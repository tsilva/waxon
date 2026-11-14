import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import http.client

spec=importlib.util.spec_from_file_location("comparison",Path(__file__).with_name("compare.py"))
comparison=importlib.util.module_from_spec(spec);spec.loader.exec_module(comparison)

class Boundaries(unittest.TestCase):
    def test_child_environment_excludes_live_credentials(self):
        with patch.dict(os.environ,{"PATH":"/tools","HOME":"/runner","SENTRY_AUTH_TOKEN":"synthetic-forbidden","DATABASE_URL":"synthetic-forbidden","GITHUB_TOKEN":"synthetic-forbidden"},clear=True):
            result=comparison.clean_environment("http://public@127.0.0.1:1/1")
        self.assertNotIn("SENTRY_AUTH_TOKEN",result);self.assertNotIn("DATABASE_URL",result);self.assertNotIn("GITHUB_TOKEN",result)
        self.assertEqual(result['NEXT_PUBLIC_SENTRY_DSN'],"http://public@127.0.0.1:1/1")

    def archive(self,name,link=None):
        buffer=io.BytesIO()
        with tarfile.open(fileobj=buffer,mode='w') as archive:
            entry=tarfile.TarInfo(name)
            if link is not None:entry.type=tarfile.SYMTYPE;entry.linkname=link;archive.addfile(entry)
            else:entry.size=2;archive.addfile(entry,io.BytesIO(b'ok'))
        return buffer.getvalue()

    def extract(self,root,data):
        def fake_run(command,**kwargs):kwargs['stdout'].write(data)
        with patch.object(comparison.subprocess,'run',side_effect=fake_run):
            comparison.extract_source(root,'frozen',root/'stage',root/'source.tar')

    def test_source_archive_rejects_escape_before_extraction(self):
        for name,link in [('../escape',None),('link','../../escape')]:
            with self.subTest(name=name),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary)
                with self.assertRaises(AssertionError):self.extract(root,self.archive(name,link))
                self.assertFalse((root/'escape').exists())

    def test_source_archive_accepts_normal_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);self.extract(root,self.archive('app/page.tsx'))
            self.assertEqual((root/'stage/app/page.tsx').read_bytes(),b'ok')

    def test_quiet_gate_requires_consecutive_idle_samples(self):
        with tempfile.TemporaryDirectory() as temporary:
            clock=[0];states=iter([(0,0,0),(100,40,0),(200,130,0),(300,220,0),(400,310,0)])
            with patch.object(comparison,'cpu_snapshot',side_effect=lambda:next(states)),patch.object(comparison.time,'sleep',side_effect=lambda seconds:clock.__setitem__(0,clock[0]+seconds)),patch.object(comparison.time,'monotonic',side_effect=lambda:clock[0]),patch.object(comparison.os,'getloadavg',return_value=(.1,.1,.1)),patch.object(comparison.os,'cpu_count',return_value=2):
                result=comparison.quiet(Path(temporary)/'quiet.json',timeout=10)
            self.assertEqual(len(result),4)

    def test_busy_runner_is_not_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            clock=[0];states=iter([(0,0,0),(100,40,0),(200,80,0),(300,120,0)])
            with patch.object(comparison,'cpu_snapshot',side_effect=lambda:next(states)),patch.object(comparison.time,'sleep',side_effect=lambda seconds:clock.__setitem__(0,clock[0]+seconds)),patch.object(comparison.time,'monotonic',side_effect=lambda:clock[0]),patch.object(comparison.os,'getloadavg',return_value=(.1,.1,.1)),patch.object(comparison.os,'cpu_count',return_value=2):
                with self.assertRaisesRegex(RuntimeError,'quiet admission'):comparison.quiet(Path(temporary)/'quiet.json',timeout=3)

    def test_output_cannot_create_files_outside_runner_temp(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();allowed=root/'runner';allowed.mkdir();outside=root/'outside'
            with self.assertRaisesRegex(AssertionError,'runner temp'):comparison.prepare_output(outside,allowed)
            self.assertFalse(outside.exists())
            inside=comparison.prepare_output(allowed/'result',allowed)
            self.assertTrue(inside.is_dir())
            with self.assertRaisesRegex(AssertionError,'existing'):comparison.prepare_output(inside,allowed)

    def test_response_header_weakening_fails_acceptance(self):
        samples=[{'variant':'baseline' if i%2==0 else 'candidate','measurements':[{'policy':{'x-content-type-options':'nosniff'}}]} for i in range(16)]
        self.assertEqual(comparison.ensure_proxy_policy(samples),{'x-content-type-options':'nosniff'})
        samples[1]['measurements'][0]['policy']['x-content-type-options']=None
        with self.assertRaisesRegex(AssertionError,'policy changed'):comparison.ensure_proxy_policy(samples)

    def test_counter_only_collector_accepts_chunked_envelopes(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'count.json';server=comparison.collector(path)
            try:
                connection=http.client.HTTPConnection('127.0.0.1',server.server_port)
                connection.request('POST','/api/1/envelope/',body=iter([b'header\n',b'synthetic payload']),headers={'Content-Type':'application/x-sentry-envelope'},encode_chunked=True)
                response=connection.getresponse();self.assertEqual(response.status,200);response.read();connection.close()
                self.assertEqual(json.loads(path.read_text()),{'envelopes':1});self.assertNotIn('payload',path.read_text())
            finally:server.shutdown();server.server_close()

if __name__=='__main__':unittest.main()
