"""Legacy publication must stop before credentials or provisioning side effects."""
import argparse
import importlib.util
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch
import urllib.request


class PublicationReview(unittest.TestCase):
    def test_all_legacy_publication_entrypoints_stop_before_io(self):
        root=Path(__file__).parent
        for path in sorted(root.glob('*.py')):
            if not path.name.startswith(('provision_','connect_')):
                continue
            with self.subTest(script=path.name):
                dependency=types.ModuleType('psycopg')
                dependency.sql=types.SimpleNamespace()
                with patch.dict(sys.modules, {'psycopg':dependency}):
                    spec=importlib.util.spec_from_file_location('trusted_admin_'+path.stem,path)
                    module=importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                with patch.object(argparse.ArgumentParser,'parse_args',return_value=types.SimpleNamespace()), \
                     patch.object(subprocess,'run',side_effect=AssertionError('Unexpected subprocess')), \
                     patch.object(urllib.request,'urlopen',side_effect=AssertionError('Unexpected network')), \
                     patch.object(Path,'read_text',side_effect=AssertionError('Unexpected credential read')), \
                     patch.object(Path,'write_text',side_effect=AssertionError('Unexpected file write')), \
                     patch.object(Path,'mkdir',side_effect=AssertionError('Unexpected directory write')):
                    with self.assertRaisesRegex(ValueError,'Runbox metadata publication requires explicit trusted review'):
                        module.main()




class FixedIdentityTests(unittest.TestCase):
    def test_identity_requires_no_tool_or_configuration_and_rejects_scope_overrides(self):
        path = Path(__file__).with_name("administration.py")
        spec = importlib.util.spec_from_file_location("fixed_administration", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with patch("subprocess.run", side_effect=AssertionError("No external tools")), patch("pathlib.Path.read_text", side_effect=AssertionError("No config read")):
            identity = module.reviewed_identity()
            self.assertEqual(module.reviewed_identity(identity=dict(identity)), identity)
            self.assertFalse(module.publication_plan()["credentials_read"])
            for change in [{"workspaceId": "unreviewed"}, {"domain": "https://unreviewed.invalid"}, {"defaultEnvironment": "prod"}, {"extra": "unreviewed"}]:
                with self.assertRaises(ValueError):
                    module.reviewed_identity(identity={**identity, **change})

if __name__ == "__main__":
    unittest.main()
