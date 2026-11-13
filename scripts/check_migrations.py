"""Check the Drizzle ledger through the configured sandboxed Agent Vault route."""

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
MARKER = "waxon_neon_migration_placeholder"
ROLE = "waxon_migration_auditor"
NATIVE_PROJECT = "e1b073e7-bd52-46c9-bd69-5241202680ee"
PRODUCTION_PROJECT = "ad93d013-8087-4bcb-bf12-63ef33e13282"
QUERY = """
SELECT current_user AS role, current_database() AS db,
  current_setting('transaction_read_only') AS read_only,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_%' AND c.relkind IN ('r','p','v','m','f')
      AND c.oid <> 'drizzle.__drizzle_migrations'::regclass
      AND (has_table_privilege(c.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
  ) AS application_access,
  has_table_privilege('drizzle.__drizzle_migrations',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ledger_write,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) AS privileged_role,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members
    WHERE member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
  ) AS role_membership,
  has_database_privilege(current_database(), 'CREATE') AS database_create,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace
    WHERE nspname NOT IN ('pg_catalog', 'information_schema')
      AND nspname NOT LIKE 'pg_%' AND has_schema_privilege(oid, 'CREATE')
  ) AS schema_create,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_%' AND p.prosecdef
      AND has_function_privilege(p.oid, 'EXECUTE')
  ) AS callable_security_definer,
  COALESCE((SELECT json_agg(json_build_array(created_at::text, hash)
    ORDER BY created_at, id) FROM drizzle.__drizzle_migrations), '[]'::json) AS ledger
""".strip()


def profile():
    host = os.environ.get("NEON_AUDIT_HOST", "")
    database = os.environ.get("NEON_AUDIT_DATABASE", "")
    if (not re.fullmatch(r"ep-[a-z0-9-]+[.][a-z0-9.-]+[.]neon[.]tech", host)
            or not re.fullmatch(r"[a-zA-Z0-9_]+", database)
            or os.environ.get("NEON_AUDIT_ROLE") != ROLE
            or os.environ.get("NEON_MIGRATION_AUDIT_DSN") != MARKER
            or not os.environ.get("SSL_CERT_FILE")):
        raise RuntimeError("The reviewed metadata-only migration route is unavailable")
    return {"host": host, "database": database, "proxy": "127.0.0.1:8283",
            "ca_file": os.environ["SSL_CERT_FILE"]}


def expected_ledger():
    directory = ROOT / "drizzle-v2"
    journal = json.loads((directory / "meta/_journal.json").read_text())
    result = []
    for row in journal["entries"]:
        if not re.fullmatch(r"[0-9]{4}_[a-z0-9_]+", row["tag"]) or type(row["when"]) is not int:
            raise RuntimeError("Unexpected Drizzle journal entry")
        digest = hashlib.sha256((directory / (row["tag"] + ".sql")).read_bytes()).hexdigest()
        result.append([str(row["when"]), digest])
    return result


def query(url, configuration):
    proxy = urlsplit(os.environ.get("HTTPS_PROXY", ""))
    if proxy.scheme != "http" or proxy.netloc.rsplit("@", 1)[-1] != configuration["proxy"] or not proxy.password:
        raise RuntimeError("Expected a session from the reviewed Agent Vault proxy")
    if os.environ.get("NEON_MIGRATION_AUDIT_DSN") != MARKER:
        raise RuntimeError("Agent Vault placeholder missing")
    result = subprocess.run([
        "/usr/bin/curl", "-q", "-sS", "--max-time", "35", "--noproxy", "",
        "--cacert", configuration["ca_file"], "--proto", "=https,http",
        "--max-filesize", "1048576", "-H", "Neon-Connection-String: " + MARKER,
        "-H", "Content-Type: application/json", "--data-binary", "@-",
        "-w", "\n%{http_code}", url,
    ], input=json.dumps({"query": QUERY, "params": []}), capture_output=True, text=True, timeout=40)
    body, _, status = result.stdout.rpartition("\n")
    if result.returncode or status != "200":
        status = status if re.fullmatch(r"[0-9]{3}", status) else "unavailable"
        raise RuntimeError("Neon migration query failed (HTTP " + status + "); provider output withheld")
    return json.loads(body)


def verify(response, configuration, expected):
    rows = response["rows"]
    if len(rows) != 1:
        raise RuntimeError("Unexpected migration-check response")
    row = rows[0]
    if row["role"] != ROLE or row["db"] != configuration["database"] or row["read_only"] != "on":
        raise RuntimeError("Unexpected database, auditor identity, or transaction mode")
    permissions = ("application_access", "ledger_write", "privileged_role", "role_membership",
                   "database_create", "schema_create", "callable_security_definer")
    if any(row[name] is not False for name in permissions):
        raise RuntimeError("The auditor has permissions outside the reviewed ledger scope")
    if row["ledger"] != expected:
        raise RuntimeError("The live migration ledger differs from this checkout")
    print(json.dumps({"ok":True,"read_only":True,"credential_mode":"public-placeholder","item_count":len(expected)}))


def main():
    if sys.argv[1:]:
        raise RuntimeError("The migration check accepts no scope or command overrides")
    configuration = profile()
    expected = expected_ledger()
    response = query("https://" + configuration["host"] + "/sql", configuration)
    if expected != expected_ledger():
        raise RuntimeError("Local migration files changed during the check")
    verify(response, configuration, expected)


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        print(json.dumps({"ok": False, "reason": str(error)}))
        sys.exit(1)
    except Exception:
        print(json.dumps({"ok": False, "reason": "Migration check failed; private diagnostics withheld"}))
        sys.exit(1)
