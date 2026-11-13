import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / "check_migrations.py" if name == "check_migrations" else Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


check = load("check_migrations")
setup = load("provision_migration_audit")
PERMISSIONS = ("application_access", "ledger_write", "privileged_role", "role_membership",
               "database_create", "schema_create", "callable_security_definer")


class MigrationAudit(unittest.TestCase):
    def response(self):
        return {"rows": [{"role": check.ROLE, "db": "neondb", "read_only": "on",
                           **dict.fromkeys(PERMISSIONS, False), "ledger": [["100", "hash"]]}]}

    def test_each_unreviewed_permission_is_rejected(self):
        for permission in PERMISSIONS:
            with self.subTest(permission=permission):
                response = self.response()
                response["rows"][0][permission] = True
                with self.assertRaisesRegex(RuntimeError, "outside the reviewed ledger scope"):
                    check.verify(response, {"database": "neondb"}, [["100", "hash"]])

    def test_identity_read_only_and_ledger_mismatches_stop(self):
        for key, value in (("role", "owner"), ("db", "other"), ("read_only", "off"),
                           ("ledger", [["100", "altered"]])):
            with self.subTest(key=key):
                response = self.response()
                response["rows"][0][key] = value
                with self.assertRaises(RuntimeError):
                    check.verify(response, {"database": "neondb"}, [["100", "hash"]])
        response = self.response()
        response["rows"].append(dict(response["rows"][0]))
        with self.assertRaises(RuntimeError):
            check.verify(response, {"database": "neondb"}, [["100", "hash"]])

    def test_success_exposes_counts_without_database_rows(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            check.verify(self.response(), {"database": "neondb"}, [["100", "hash"]])
        self.assertEqual(json.loads(output.getvalue()),
                         {"ok": True, "read_only": True, "credential_mode": "public-placeholder", "item_count": 1})

    def test_journal_hashes_use_waxon_v2_and_reject_path_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            migration = root / "drizzle-v2/0000_baseline.sql"
            migration.parent.mkdir()
            migration.write_text("SELECT 1;")
            journal = migration.parent / "meta/_journal.json"
            journal.parent.mkdir()
            journal.write_text(json.dumps({"entries": [{"tag": "0000_baseline", "when": 100}]}))
            with patch.object(check, "ROOT", root):
                self.assertEqual(check.expected_ledger(),
                                 [["100", hashlib.sha256(migration.read_bytes()).hexdigest()]])
                journal.write_text(json.dumps({"entries": [{"tag": "../escape", "when": 100}]}))
                with self.assertRaises(RuntimeError):
                    check.expected_ledger()

    def test_missing_marker_and_wrong_proxy_fail_before_network(self):
        configuration = {"proxy": "127.0.0.1:8283"}
        for environment in ({}, {"HTTPS_PROXY": "http://user:fake@127.0.0.1:1"},
                            {"HTTPS_PROXY": "http://user:fake@127.0.0.1:8283"}):
            with self.subTest(environment=bool(environment)), patch.dict(os.environ, environment, clear=True):
                with patch.object(check.subprocess, "run") as run:
                    with self.assertRaises(RuntimeError):
                        check.query("https://ep-fixture.aws.neon.tech/sql", configuration)
                    run.assert_not_called()


    def test_existing_service_scope_must_be_exact(self):
        service = {"id": "fixture", "type": "http", "name": "waxon-neon-ledger",
                   "hostPattern": "ep-fixture-pooler.us-east-1.aws.neon.tech",
                   "allowedMethods": ["POST"], "allowedPathPrefixes": ["/sql"],
                   "credential": {"type": "bearer", "headerName": "Neon-Connection-String",
                                  "headerPrefix": "", "memberProvidedFields": []},
                   "customHeaders": [], "substitutions": []}
        bundle = {"accessBundle": {"name": setup.BUNDLE, "services": [service]}}
        with patch.object(setup, "api", return_value=bundle):
            self.assertEqual(setup.reviewed_service("fake-token", {"id": "fixture"}), service)
        for field, value in (("hostPattern", "*.neon.tech"), ("allowedMethods", ["GET", "POST"]),
                             ("allowedPathPrefixes", ["/"]), ("name", "other")):
            changed = {**service, field: value}
            bundle = {"accessBundle": {"name": setup.BUNDLE, "services": [changed]}}
            with self.subTest(field=field), patch.object(setup, "api", return_value=bundle):
                with self.assertRaises(RuntimeError):
                    setup.reviewed_service("fake-token", {"id": "fixture"})

    def test_trusted_source_is_production_only_and_never_connected(self):
        source = "postgresql://owner:synthetic-only@ep-fixture.us-east-1.aws.neon.tech/neondb?sslmode=require"
        with patch.object(setup, "command", return_value=source) as command:
            self.assertEqual(setup.production_target(), ("ep-fixture.us-east-1.aws.neon.tech", "neondb"))
            args = command.call_args.args[0]
            self.assertIn("--projectId=" + setup.PRODUCTION_PROJECT, args)
            self.assertIn("--env=prod", args)
            self.assertIn("--expand=false", args)
            self.assertIn("--include-imports=false", args)
            self.assertIn("--secret-overriding=false", args)
        for bad in (source.replace(".neon.tech", ".example.org"), source.replace("sslmode=require", "sslmode=disable")):
            with patch.object(setup, "command", return_value=bad):
                with self.assertRaises(RuntimeError):
                    setup.production_target()


if __name__ == "__main__":
    unittest.main()
