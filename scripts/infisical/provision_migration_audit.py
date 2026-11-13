"""Explicit trusted setup for Waxon's read-only Production migration-audit route.

Ordinary checks never run this module. Credential values remain in this process
and the encrypted Vault service, never in files, child arguments or output.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
DOMAIN = "https://app.infisical.com"
CLI = Path.home() / ".config/infisical/cli/0.44.13/infisical"
CA = Path.home() / ".config/infisical/agent-vault-ca.pem"
FINGERPRINT = "SHA256:37:B2:E0:81:45:EC:C0:58:46:2E:D1:2F:E1:2B:E6:AE:2B:78:B1:B3:F0:21:CD:8F:EC:54:CC:30:2D:36:9E:37"
NATIVE_PROJECT = "e1b073e7-bd52-46c9-bd69-5241202680ee"
PRODUCTION_PROJECT = "ad93d013-8087-4bcb-bf12-63ef33e13282"
BUNDLE = "local-waxon-migration-audit"
ROLE = "waxon_migration_auditor"
API = "/api/v1/agent-vault/access-bundles"
PROFILE = Path.home() / ".config/infisical/neon-migration-checks/waxon.json"
ENV = {"HOME": str(Path.home()), "PATH": "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args):
        raise RuntimeError("Redirect rejected during trusted setup")


def command(args):
    result = subprocess.run(args, env=ENV, cwd=ROOT, capture_output=True, text=True, timeout=45)
    if result.returncode:
        stages = [json.loads(line)["proof_stage"] for line in result.stdout.splitlines()
                  if line.startswith('{"proof_stage":')]
        if stages:
            raise RuntimeError("Synthetic client failed during " + stages[-1] + "; output withheld")
        if "agent-vault" in args:
            categories = {name: any(term in result.stderr.lower() for term in terms) for name, terms in {
                "authentication": ("unauthorized", "not logged", "401"),
                "bundle_lookup": ("bundle",), "ttl": ("duration", "ttl", "minimum"),
                "proxy": ("connection refused", "proxy"), "certificate": ("certificate",),
            }.items()}
            raise RuntimeError("Native client startup failed; diagnostic categories=" + json.dumps(categories))
        raise RuntimeError("Infisical login or trusted command failed; output withheld")
    return result.stdout.strip()


def request(url, *, token=None, payload=None, headers=None, method=None):
    if not url.startswith("https://"):
        raise RuntimeError("Trusted setup requires HTTPS")
    outgoing = {"Content-Type": "application/json", **(headers or {})}
    if token:
        outgoing["Authorization"] = "Bearer " + token
    req = urllib.request.Request(
        url, headers=outgoing, method=method,
        data=None if payload is None else json.dumps(payload).encode(),
    )
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(
            req, timeout=35
        ) as response:
            return json.loads(response.read(1048577))
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Trusted setup request rejected (HTTP {error.code}); output withheld") from None
    except (urllib.error.URLError, TimeoutError):
        raise RuntimeError("Trusted setup transport failed; output withheld") from None


def api(token, path, payload=None, method=None):
    if not path.startswith("/api/") or ".." in path:
        raise RuntimeError("Unreviewed administration path")
    return request(DOMAIN + path, token=token, payload=payload, method=method)


def preflight():
    native = runbox_administration().reviewed_identity()
    if native != {"workspaceId": NATIVE_PROJECT, "defaultEnvironment": "dev",
                  "gitBranchToEnvironmentMapping": None, "domain": DOMAIN}:
        raise RuntimeError("Waxon native identity changed")
    der = ssl.PEM_cert_to_DER_cert(CA.read_text())
    fingerprint = "SHA256:" + ":".join(f"{b:02X}" for b in hashlib.sha256(der).digest())
    if fingerprint != FINGERPRINT:
        raise RuntimeError("Proxy CA differs from the reviewed public certificate")
    token = command([str(CLI), "--domain=" + DOMAIN, "--silent", "--telemetry=false",
                     "user", "get", "token", "--plain"])
    if not token:
        raise RuntimeError("Infisical login renewal required")
    project = api(token, "/api/v1/workspace/" + PRODUCTION_PROJECT)["workspace"]
    if project["id"] != PRODUCTION_PROJECT or project["name"] != "waxon-production":
        raise RuntimeError("Production source identity changed")
    existing = None
    for offset in range(0, 1000, 100):
        rows = api(token, API + f"?limit=100&offset={offset}")["accessBundles"]
        for row in rows:
            if row["name"] == BUNDLE:
                if existing is not None:
                    raise RuntimeError("Duplicate audit bundles require review")
                existing = row
        if len(rows) < 100:
            break
    else:
        raise RuntimeError("Access-bundle inventory exceeded its reviewed bound")
    return token, existing


def checker():
    spec = importlib.util.spec_from_file_location("waxon_migration_check", ROOT / "scripts/check_migrations.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def reviewed_service(token, existing):
    if existing is None:
        raise RuntimeError("No existing Waxon audit bundle; separate role provisioning is required")
    bundle = api(token, API + "/" + existing["id"])["accessBundle"]
    if bundle["name"] != BUNDLE or len(bundle["services"]) != 1:
        raise RuntimeError("Unexpected migration-audit bundle contents")
    service = bundle["services"][0]
    credential = service.get("credential", {})
    if (service["type"] != "http" or service["name"] != "waxon-neon-ledger"
            or service["allowedMethods"] != ["POST"]
            or service["allowedPathPrefixes"] != ["/sql"]
            or credential.get("type") != "bearer"
            or credential.get("headerName") != "Neon-Connection-String"
            or credential.get("headerPrefix") != ""
            or credential.get("memberProvidedFields")
            or service.get("customHeaders") or service.get("substitutions")
            or not re.fullmatch(r"ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech", service["hostPattern"])):
        raise RuntimeError("Existing audit service differs from the reviewed scope")
    return service


def production_target():
    # Explicit trusted setup only: the source URL is inspected in RAM, never
    # supplied to the ordinary audit client or used for a database connection.
    value = command([
        str(CLI), "--domain=" + DOMAIN, "--silent", "--telemetry=false",
        "secrets", "get", "DATABASE_URL_UNPOOLED", "--plain",
        "--projectId=" + PRODUCTION_PROJECT, "--env=prod", "--path=/",
        "--expand=false", "--include-imports=false", "--secret-overriding=false",
    ])
    url = urllib.parse.urlsplit(value)
    database = urllib.parse.unquote(url.path.removeprefix("/"))
    if (url.scheme not in {"postgres", "postgresql"} or not url.username or not url.password
            or not re.fullmatch(r"ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech", url.hostname or "")
            or "-pooler." in url.hostname or not re.fullmatch(r"[a-zA-Z0-9_]+", database)
            or urllib.parse.parse_qs(url.query).get("sslmode") not in
            (["require"], ["verify-ca"], ["verify-full"])):
        raise RuntimeError("Unexpected Waxon Production database binding")
    return url.hostname, database


def install(token, existing):
    if PROFILE.exists() or PROFILE.is_symlink():
        raise RuntimeError("Audit profile already exists; do not overwrite a live route")
    service = reviewed_service(token, existing)
    host, database = production_target()
    if service["hostPattern"].replace("-pooler.", ".", 1) != host:
        raise RuntimeError("Audit route does not target Waxon's Production endpoint")
    profile = {
        "version": 1, "project_id": NATIVE_PROJECT, "source_project_id": PRODUCTION_PROJECT,
        "source_environment": "prod", "source_path": "/", "bundle": BUNDLE,
        "host": service["hostPattern"], "database": database, "role": ROLE,
        "infisical": str(CLI), "cli_sha256": hashlib.sha256(CLI.read_bytes()).hexdigest(),
        "proxy": "127.0.0.1:8283", "ca_file": str(CA), "ca_fingerprint": FINGERPRINT,
    }
    PROFILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if PROFILE.parent.is_symlink():
        raise RuntimeError("Audit profile directory must not be a symlink")
    descriptor = os.open(PROFILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(profile, stream, indent=2)
        stream.write("\n")
    checker().profile()
    print(json.dumps({"ok": True, "profile_installed": True, "existing_service_unchanged": True,
                      "production_target_verified": True, "credential_values_persisted": False}))


def fake_test(token):
    """Exercise the real broker and sandbox with a disposable synthetic credential."""
    audit = checker()
    received = []
    fake_value = "postgresql://synthetic:synthetic@invalid.example/fixture"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            received.append(self.path == "/sql" and body == {"query": audit.QUERY, "params": []}
                            and self.headers.get("Neon-Connection-String") == fake_value)
            result = {"rows": [{"role": ROLE, "db": "fixture", "read_only": "on",
                                "application_access": False, "ledger_write": False,
                                "privileged_role": False, "role_membership": False,
                                "database_create": False, "schema_create": False,
                                "callable_security_definer": False, "ledger": []}]}
            data = json.dumps(result).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    directory = ROOT / ".internal/evidence/migration-audit"
    directory.mkdir(parents=True, exist_ok=True)
    client, canary = directory / "fake_client.py", directory / "sandbox-canary.txt"
    if client.exists() or canary.exists():
        raise RuntimeError("Synthetic proof files already exist")
    bundle_id = None
    try:
        name = "waxon-migration-audit-proof-" + uuid.uuid4().hex[:12]
        bundle_id = api(token, API, {"name": name})["accessBundle"]["id"]
        api(token, API + "/" + bundle_id + "/services", {
            "type": "http", "name": "synthetic-neon-ledger",
            "hostPattern": f"127.0.0.1:{server.server_port}",
            "allowedMethods": ["POST"], "allowedPathPrefixes": ["/sql"],
            "credential": {"type": "bearer", "headerName": "Neon-Connection-String",
                           "headerPrefix": "", "value": fake_value},
        })
        canary.write_text("synthetic sandbox canary\n")
        code = '''import importlib.util,json,os,subprocess
from pathlib import Path
spec=importlib.util.spec_from_file_location("audit",MODULE)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
configuration={"proxy":"127.0.0.1:8283","ca_file":CAFILE,"database":"fixture"}
print(json.dumps({"proof_stage":"allowed request"}),flush=True)
response=m.query(URL+"/sql",configuration)
m.verify(response,configuration,[])
print(json.dumps({"proof_stage":"path restrictions"}),flush=True)
for path in ("/other","/sql/../other"):
 try:m.query(URL+path,configuration)
 except RuntimeError as error:
  assert "HTTP 403" in str(error)
 else:raise AssertionError("path restriction failed")
base=["/usr/bin/sandbox-exec","-D","USER_HOME="+str(Path.home()),"-D","CA_FILE="+CAFILE,"-f",SANDBOX]
print(json.dumps({"proof_stage":"method restriction"}),flush=True)
get=subprocess.run(base+["/usr/bin/curl","-q","-sS","--max-time","5","--noproxy","","-o","/dev/null","-w","%{http_code}",URL+"/sql"],capture_output=True,text=True,timeout=8)
assert get.stdout=="403"
print(json.dumps({"proof_stage":"direct network restriction"}),flush=True)
direct=subprocess.run(base+["/usr/bin/curl","-q","-sS","--max-time","3","--noproxy","*",URL+"/sql"],capture_output=True,text=True,timeout=6)
assert direct.returncode!=0
print(json.dumps({"proof_stage":"home read restriction"}),flush=True)
home=subprocess.run(base+["/bin/cat",CANARY],capture_output=True,text=True,timeout=5)
assert home.returncode!=0 and not home.stdout
print(json.dumps({"proof_stage":"placeholder restriction"}),flush=True)
os.environ.pop("NEON_MIGRATION_AUDIT_DSN")
try:m.query(URL+"/sql",configuration)
except RuntimeError:pass
else:raise AssertionError("placeholder validation failed")
print(json.dumps({"ok":True,"fake_credential":True,"path_and_method_denials":True,"direct_network_denied":True,"home_read_denied":True,"missing_placeholder_denied":True}))
'''
        substitutions = {"MODULE": str(ROOT / "scripts/check_migrations.py"),
                         "CAFILE": str(CA), "SANDBOX": str(ROOT / "scripts/infisical/neon_migrations.sb"),
                         "URL": f"http://127.0.0.1:{server.server_port}", "CANARY": str(canary)}
        # Set constants as Python literals, never shell interpolation.
        client.write_text("\n".join(f"{key}={value!r}" for key, value in substitutions.items()) + "\n" + code)
        output = command([
            str(CLI), "agent-vault", "run", "--domain=" + DOMAIN,
            "--access-bundle=" + name, "--proxy=127.0.0.1:8283",
            "--ca-fingerprint=" + FINGERPRINT, "--ttl=2m", "--no-ca-trust", "--silent",
            "--no-skills", "--telemetry=false", "--", "/usr/bin/env",
            "NEON_MIGRATION_AUDIT_DSN=" + audit.MARKER, sys.executable, "-I", str(client),
        ])
        records = [json.loads(line) for line in output.splitlines() if line.startswith('{"ok":')]
        if not records or records[-1].get("home_read_denied") is not True or received != [True]:
            raise RuntimeError("Synthetic broker/sandbox proof failed; output withheld")
        print(json.dumps(records[-1]))
    finally:
        server.shutdown()
        server.server_close()
        for path in (client, canary):
            if path.exists():
                path.unlink()
        if bundle_id:
            api(token, API + "/" + bundle_id, method="DELETE")



def runbox_administration():
    location=Path(__file__).resolve()
    root=next(p for p in location.parents if (p/'scripts/infisical/administration.py').is_file())
    spec=importlib.util.spec_from_file_location('reviewed_runbox_administration',root/'scripts/infisical/administration.py')
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def main():
    if '--plan' in sys.argv[1:]:
        if sys.argv[1:] != ['--plan']: raise ValueError('Use --plan without provisioning arguments')
        print(json.dumps(runbox_administration().publication_plan()))
        return
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--inspect", action="store_true")
    mode.add_argument("--install", action="store_true")
    mode.add_argument("--fake-test", action="store_true")
    args = parser.parse_args()
    raise ValueError('Runbox metadata publication requires explicit trusted review before provisioning; no credentials read or changes made')
    token, existing = preflight()
    if args.fake_test:
        reviewed_service(token, existing)
        fake_test(token)
        return
    if args.install:
        install(token, existing)
        return
    if existing:
        if PROFILE.exists():
            checker().profile()
        bundle = api(token, API + "/" + existing["id"])["accessBundle"]
        services = [{key: service.get(key) for key in
                     ("id", "type", "name", "hostPattern", "allowedMethods", "allowedPathPrefixes")}
                    | {"credential": {key: service.get("credential", {}).get(key)
                                       for key in ("type", "headerName", "headerPrefix")}}
                    for service in bundle["services"]]
        print(json.dumps({"ok": True, "metadata_only": True, "existing_bundle": bundle["id"],
                          "services": services, "database_credentials_read": False}))
        return
    print(json.dumps({"ok": True, "metadata_only": True, "production_source_verified": True,
                      "audit_bundle_available": True, "database_credentials_read": False}))


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        print(json.dumps({"ok": False, "reason": str(error)}))
        sys.exit(1)
    except Exception:
        print(json.dumps({"ok": False, "reason": "Trusted setup failed; details withheld"}))
        sys.exit(1)
