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
import base64
import hashlib
import gzip
import subprocess
import time

export_spec=importlib.util.spec_from_file_location("evidence_export",Path(__file__).with_name("export.py"))
exporter=importlib.util.module_from_spec(export_spec);export_spec.loader.exec_module(exporter)

spec=importlib.util.spec_from_file_location("comparison",Path(__file__).with_name("compare.py"))
comparison=importlib.util.module_from_spec(spec);spec.loader.exec_module(comparison)

class Boundaries(unittest.TestCase):
    def test_profiler_captures_separate_windows_without_a_debugging_listener(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);script=root/'synthetic.mjs';control=root/'control.json';output=root/'profile.json'
            script.write_text('''import {existsSync,writeFileSync} from 'node:fs';
function startupWork(){const end=Date.now()+25;while(Date.now()<end){Math.sqrt(Math.random());}}
function firstWork(){const end=Date.now()+25;while(Date.now()<end){Math.sqrt(Math.random());}}
startupWork();writeFileSync(process.env.SYNTHETIC_READY,'ready');
setInterval(()=>{if(existsSync(process.env.SYNTHETIC_FIRST)&&!existsSync(process.env.SYNTHETIC_DONE)){firstWork();writeFileSync(process.env.SYNTHETIC_DONE,'done');}},10);
''')
            env=comparison.clean_environment('http://public@127.0.0.1:1/1')|{'WAXON_PROFILE_TARGET':str(script),'WAXON_PROFILE_CONTROL':str(control),'WAXON_PROFILE_OUTPUT':str(output),'SYNTHETIC_READY':str(root/'ready'),'SYNTHETIC_FIRST':str(root/'first'),'SYNTHETIC_DONE':str(root/'done')}
            with (root/'node.log').open('w') as log:
                process=subprocess.Popen(['node','--import',str(Path(__file__).with_name('cpu-probe.mjs')),str(script)],env=env,stdout=log,stderr=subprocess.STDOUT)
                try:
                    comparison.wait_file(root/'ready',process,timeout=10)
                    comparison.profile_command(control,'first');comparison.wait_file(Path(str(output)+'.ready'),process,timeout=10)
                    (root/'first').write_text('go');comparison.wait_file(root/'done',process,timeout=10)
                    comparison.profile_command(control,'stop');comparison.wait_file(output,process,timeout=10)
                    phases=json.loads(output.read_text())['phases'];self.assertEqual([p['phase'] for p in phases],['startup','first'])
                    for phase,expected in zip(phases,['startupWork','firstWork']):
                        raw=gzip.decompress(base64.b64decode(phase['gzipBase64']));self.assertEqual(len(raw),phase['bytes']);self.assertEqual(hashlib.sha256(raw).hexdigest(),phase['sha256'])
                        profile=json.loads(raw);self.assertTrue(profile['samples']);self.assertEqual(len(profile['samples']),len(profile['timeDeltas']))
                        self.assertIn(expected,[n['callFrame']['functionName'] for n in profile['nodes']])
                finally:
                    process.terminate();process.wait(timeout=10)
            self.assertNotIn('Debugger listening',(root/'node.log').read_text())

    def test_profile_exports_exclude_control_and_partial_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            for name in ['profile-01-baseline.json','profile-02-candidate.log','profile-01-baseline.control','profile-01-baseline.json.tmp','profile-01-baseline.json.ready','profile-05-baseline.json']:(root/name).write_text('{}')
            self.assertEqual([p.name for p in exporter.selected_files(root)],['profile-01-baseline.json','profile-02-candidate.log'])

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

    def test_evidence_export_excludes_sources_and_unknown_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'result.json').write_text('{"synthetic":true}');(root/'.env').write_text('synthetic-private');(root/'stage').mkdir();(root/'stage/result.json').write_text('not an export')
            self.assertEqual([p.name for p in exporter.selected_files(root)],['result.json'])

    def test_evidence_export_rejects_symlinks_and_oversized_logs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);output=root/'out';output.mkdir();(root/'outside').write_text('synthetic-private');(output/'result.json').symlink_to(root/'outside')
            with self.assertRaises(AssertionError):exporter.selected_files(output)
            (output/'result.json').unlink();(output/'install.log').write_bytes(b'x'*1000001)
            with self.assertRaisesRegex(AssertionError,'bound'):exporter.selected_files(output)

    def test_evidence_frames_round_trip_with_integrity(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'candidate-detail.png';data=bytes(range(256))*40;path.write_bytes(data);frames=list(exporter.frames(path));start=json.loads(frames[0].split(' ',1)[1]);chunks=[json.loads(x.split(' ',1)[1]) for x in frames[1:-1]]
            self.assertEqual([c['offset'] for c in chunks],list(range(0,len(data),3072)))
            self.assertEqual(b''.join(base64.b64decode(c['data']) for c in chunks),data)
            self.assertEqual(start['sha256'],hashlib.sha256(data).hexdigest())

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
