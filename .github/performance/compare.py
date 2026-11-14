#!/usr/bin/env python3
"""Run a credential-free, branch-only startup comparison on a hosted runner."""
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import argparse, gzip, hashlib, http.client, json, os, re, shutil, signal
import statistics, struct, subprocess, tarfile, threading, time

SEQUENCES = [
    ['baseline','candidate','candidate','baseline','baseline','candidate','candidate','baseline'],
    ['candidate','baseline','baseline','candidate','candidate','baseline','baseline','candidate'],
]


def cpu_snapshot():
    values = [int(x) for x in Path('/proc/stat').read_text().splitlines()[0].split()[1:9]]
    return sum(values), values[3], values[7]


def quiet(output, timeout=180):
    """Require three idle readings; retain every admission sample."""
    readings = []; deadline = time.monotonic() + timeout; consecutive = 0
    previous = cpu_snapshot()
    while time.monotonic() < deadline:
        time.sleep(1); current = cpu_snapshot(); total = current[0] - previous[0]
        idle = (current[1] - previous[1]) / max(total, 1)
        steal = (current[2] - previous[2]) / max(total, 1)
        row = {'idleFraction': idle, 'stealFraction': steal,
               'normalizedLoad1m': os.getloadavg()[0] / os.cpu_count()}
        readings.append(row); output.write_text(json.dumps(readings, indent=2) + '\n')
        consecutive = consecutive + 1 if idle >= .85 and steal <= .01 and row['normalizedLoad1m'] <= .75 else 0
        if consecutive == 3: return readings
        previous = current
    raise RuntimeError('Runner did not satisfy the recorded quiet admission gate')


def prepare_output(path, runner_temp):
    output=path.resolve(); allowed=runner_temp.resolve()
    assert output != allowed and output.is_relative_to(allowed), 'Output must be a new child of runner temp'
    assert not output.exists(), 'Refuse to reuse an existing output directory'
    output.mkdir(parents=True)
    return output


def ensure_proxy_policy(samples):
    assert len(samples)==16 and {x['variant'] for x in samples}=={'baseline','candidate'}
    first=samples[0]['measurements'][0]['policy']
    assert all(measurement['policy']==first for sample in samples for measurement in sample['measurements']), 'Anonymous response policy changed between variants'
    return first


def clean_environment(dsn):
    env = {k: os.environ[k] for k in ('PATH','HOME','LANG','TMPDIR') if k in os.environ}
    env.update(CI='true', NEXT_TELEMETRY_DISABLED='1', NEXT_PUBLIC_SENTRY_DSN=dsn,
               CLERK_ENABLE_KEYLESS='false',
               NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY='pk_test_ZnJvbnRlbmQuZXhhbXBsZS5jb20k')
    return env


def extract_source(repo, ref, stage, archive):
    stage=stage.resolve();archive=archive.resolve()
    with archive.open('wb') as stream:
        subprocess.run(['git','archive',ref], cwd=repo, stdout=stream, check=True)
    stage.mkdir()
    with tarfile.open(archive) as source:
        for member in source.getmembers():
            assert not Path(member.name).is_absolute() and '..' not in Path(member.name).parts
            if member.issym() or member.islnk():
                assert ((stage/member.name).parent/member.linkname).resolve().is_relative_to(stage)
        members=source.getmembers()
        assert len({m.name for m in members})==len(members)
        assert all(m.isfile() or m.isdir() or m.issym() for m in members)
        # Extract no links while materializing files. Git archives may retain only
        # relative links to existing regular source files, never directory links.
        source.extractall(stage,members=[m for m in members if not m.issym()])
        for member in members:
            if member.issym():
                target=((stage/member.name).parent/member.linkname).resolve()
                assert not Path(member.linkname).is_absolute() and target.is_relative_to(stage) and target.is_file()
                (stage/member.name).symlink_to(member.linkname)


def apply_candidate(stage, patch):
    for line in patch.read_text().splitlines():
        if line.startswith(('+++ ', '--- ')):
            name = line[4:].split('\t', 1)[0]
            if name == '/dev/null': continue
            assert name.startswith(('a/','b/'))
            assert '..' not in Path(name).parts and not Path(name).is_absolute()
    for flags in (['--dry-run'], []):
        result=subprocess.run(['patch','--batch','--forward','-p1','-d',str(stage),'-i',str(patch),*flags],capture_output=True,text=True)
        if result.returncode:raise RuntimeError('Candidate patch failed: '+(result.stdout+result.stderr)[-4000:])


def run_logged(command, stage, env, path):
    with path.open('w') as log:
        result = subprocess.run(command, cwd=stage, env=env, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode:
        print(path.read_text()[-16000:]); raise RuntimeError('Failed local build/test gate: ' + ' '.join(command))


def payload(build, kind):
    page = build / ('server/app/index.html' if kind == 'catalogue' else 'server/app/landing.html')
    if not page.exists(): return {'note':'Dynamic homepage; response bytes are measured per request'}
    html = page.read_bytes(); assets = sorted(set(re.findall(rb'(?:src|href)="(/_next/static/[^"?]+)',html)))
    rows = []
    for raw in assets:
        url = raw.decode()
        if url.endswith(('.js','.css')):
            data = (build/url.removeprefix('/_next/')).read_bytes()
            rows.append({'url':url,'gzip':len(gzip.compress(data,mtime=0))})
    return {'htmlGzip':len(gzip.compress(html,mtime=0)), 'assets':rows,
            'totalInitialGzip':len(gzip.compress(html,mtime=0))+sum(x['gzip'] for x in rows)}


def collector(output):
    lock = threading.Lock(); counts = {'envelopes':0}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def do_OPTIONS(self):
            self.send_response(204); self.send_header('Access-Control-Allow-Origin','*')
            self.send_header('Access-Control-Allow-Headers','*'); self.end_headers()
        def do_POST(self):
            if self.headers.get('Transfer-Encoding','').lower() == 'chunked':
                size = 0
                while True:
                    amount = int(self.rfile.readline(128).split(b';',1)[0].strip(),16)
                    if not amount:
                        while self.rfile.readline(8192).strip(): pass
                        break
                    size += amount
                    if size > 1000000: self.send_error(413); return
                    self.rfile.read(amount); assert self.rfile.read(2) == b'\r\n'
            else:
                size = int(self.headers.get('Content-Length','0'))
                if size > 1000000: self.send_error(413); return
                self.rfile.read(size)
            with lock:
                counts['envelopes'] += 1; output.write_text(json.dumps(counts) + '\n')
            self.send_response(200); self.send_header('Access-Control-Allow-Origin','*')
            self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(b'{}')
    server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    return server


def fixtures(stage, builds, output, probe):
    receipt = {'requests':[]}; lock = threading.Lock(); servers = {}; threads = []
    def handler(variant, build):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_GET(self):
                from urllib.parse import urlsplit, unquote, parse_qs
                import mimetypes
                path = unquote(urlsplit(self.path).path); status=200
                if path == '/api/health': body=b'{"status":"ok"}'; mime='application/json'
                elif path.startswith('/api/'):
                    status=404;body=b'{"detail":"Synthetic fixture: unsupported endpoint"}';mime='application/json'
                else:
                    file = build/'server/app/index.html' if path=='/' else (build/path.removeprefix('/_next/') if path.startswith('/_next/static/') else stage/'public'/path.lstrip('/'))
                    resolved=file.resolve()
                    if not (resolved.is_relative_to(build) or resolved.is_relative_to(stage/'public')) or not resolved.is_file():
                        status=404;body=b'Not found';mime='text/plain'
                    else:
                        body=resolved.read_bytes();mime=mimetypes.guess_type(str(file))[0] or 'application/octet-stream'
                    if path=='/': body=body.replace(b'</body>',probe+b'</body>')
                    if path.endswith('.js'): time.sleep(.1)
                with lock:
                    receipt['requests'].append({'variant':variant,'path':path,'status':status,'bytes':len(body)})
                self.send_response(status);self.send_header('Content-Type',mime);self.send_header('Cache-Control','no-store')
                self.send_header('Content-Length',str(len(body)));self.end_headers()
                try:self.wfile.write(body)
                except (BrokenPipeError,ConnectionResetError):pass
        return Handler
    for variant,build in builds.items():
        server=ThreadingHTTPServer(('127.0.0.1',0),handler(variant,build));servers[variant]=server
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();threads.append(thread)
    return servers,receipt


def response_samples(stage, builds, env, output):
    results=[]
    for cohort,sequence in enumerate(SEQUENCES,1):
        quiet(output/f'quiet-{cohort}.json')
        for variant in sequence:
            artifact=builds[variant];active=stage/'.next';assert not active.exists();artifact.rename(active)
            index=len(results)+1;path=output/f'response-{index:02d}-{variant}.log';started=time.monotonic()
            with path.open('w') as log:
                process=subprocess.Popen(['node','scripts/next-server.mjs','start','--port','auto','--hostname','127.0.0.1'],cwd=stage,env={**env,'NODE_ENV':'production'},stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                try:
                    while True:
                        text=path.read_text();match=re.search(r'http://127[.]0[.]0[.]1:(\d+)',text)
                        if match and 'Ready in' in text:break
                        if process.poll() is not None:raise RuntimeError('Owned production server exited')
                        if time.monotonic()-started>30:raise RuntimeError('Owned production server readiness timeout')
                        time.sleep(.05)
                    measurements=[]
                    for label in ('first','warm1','warm2'):
                        connection=http.client.HTTPConnection('127.0.0.1',int(match.group(1)),timeout=30)
                        before=time.perf_counter();connection.request('GET','/',headers={'Accept':'text/html'})
                        response=connection.getresponse();headers=time.perf_counter();body=response.read();end=time.perf_counter();connection.close()
                        assert response.status==200 and b'landing-hero' in body
                        measurements.append({'request':label,'headersMs':1000*(headers-before),'documentMs':1000*(end-before),'htmlBytes':len(body),
                           'policy':{k:response.getheader(k) for k in ('cache-control','x-frame-options','x-content-type-options','referrer-policy','permissions-policy')}})
                    results.append({'cohort':cohort,'variant':variant,'measurements':measurements,'load':os.getloadavg()})
                    (output/'samples.json').write_text(json.dumps(results,indent=2)+'\n')
                finally:
                    if process.poll() is None:os.killpg(process.pid,signal.SIGTERM)
                    process.wait(timeout=15);active.rename(artifact)
    return results


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--kind',choices=['catalogue','proxy'],required=True);parser.add_argument('--baseline',required=True);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    assert re.fullmatch(r'[0-9a-f]{40}',args.baseline), 'Baseline must be a full immutable commit SHA'
    if os.environ.get('GITHUB_ACTIONS')!='true':raise SystemExit('Execution is restricted to the reviewed Actions job; local unit/syntax checks do not run benchmarks')
    repo=Path(__file__).resolve().parents[2];out=prepare_output(args.output,Path(os.environ['RUNNER_TEMP']))
    server=collector(out/'collector.json');dsn=f'http://public@127.0.0.1:{server.server_port}/1';env=clean_environment(dsn)
    stage=out/'stage';builds={v:out/(v+'-build') for v in ('baseline','candidate')}
    try:
        extract_source(repo,args.baseline,stage,out/'source.tar')
        run_logged(['pnpm','install','--frozen-lockfile','--ignore-scripts'],stage,env,out/'install.log')
        run_logged(['pnpm','build'],stage,env,out/'baseline-build.log');shutil.move(stage/'.next',builds['baseline'])
        invariants={name:hashlib.sha256((stage/name).read_bytes()).hexdigest() for name in ('instrumentation.ts','instrumentation-client.ts','next.config.ts','next.config.mjs','next.config.js','vercel.json','pnpm-lock.yaml') if (stage/name).exists()}
        original_package=json.loads((stage/'package.json').read_text())
        apply_candidate(stage,repo/'.github/performance/candidate.patch')
        assert all(hashlib.sha256((stage/name).read_bytes()).hexdigest()==digest for name,digest in invariants.items())
        candidate_package=json.loads((stage/'package.json').read_text())
        assert all(original_package.get(key)==candidate_package.get(key) for key in ('dependencies','devDependencies','engines','packageManager'))
        if args.kind=='catalogue':command=['pnpm','test:catalog']
        else:command=['node','--import','tsx','--test','tests/proxy-startup.test.mts']
        run_logged(command,stage,env,out/'candidate-check.log')
        run_logged(['pnpm','build'],stage,env,out/'candidate-build.log');shutil.move(stage/'.next',builds['candidate'])
        report={'kind':args.kind,'baseline':args.baseline,'diagnosticCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),'node':subprocess.check_output(['node','--version'],text=True).strip(),'cpus':os.cpu_count(),'payload':{k:payload(v,args.kind) for k,v in builds.items()},'normalLighthouseScores':False,'productionChanged':False,'unchangedMonitoringAndLockHashes':invariants,'monitoring':'Installed SDK with synthetic loopback DSN; production ingestion is not newly certified'}
        if args.kind=='proxy':
            report['samples']=response_samples(stage,builds,env,out)
            report['verifiedLocalResponsePolicy']=ensure_proxy_policy(report['samples'])
        else:
            servers,receipt=fixtures(stage,builds,out,(repo/'.github/performance/probe.html').read_bytes())
            try:
                urls={k:f'http://127.0.0.1:{s.server_port}/' for k,s in servers.items()};(out/'urls.json').write_text(json.dumps(urls))
                for cohort,sequence in enumerate(SEQUENCES,1):
                    quiet(out/f'quiet-{cohort}.json')
                    run_logged(['node',str(repo/'.github/performance/browser.mjs'),str(out),str(cohort),json.dumps(sequence)],repo,env|{'GITHUB_ACTIONS':'true'},out/f'browser-{cohort}.log')
                report['samples']=json.loads((out/'samples.json').read_text());report['browser']=json.loads((out/'browser.json').read_text())
                assert len(report['samples'])==16
                first=report['samples'][0]
                assert all(sample['cards']==first['cards'] and sample['detailMetadata']==first['detailMetadata'] and not sample['errors'] for sample in report['samples']), 'Catalogue or detail semantics/error parity failed'
                for variant,build in builds.items():
                    paths={r['path'] for r in receipt['requests'] if r['variant']==variant and r['status']==200 and r['path'].endswith('.js')}
                    report['payload'][variant]['jsFilesThroughDetail']=len(paths)
                    report['payload'][variant]['jsGzipThroughDetail']=sum(len(gzip.compress((build/u.removeprefix('/_next/')).read_bytes(),mtime=0)) for u in paths)
            finally:
                for s in servers.values():s.shutdown();s.server_close()
        (out/'result.json').write_text(json.dumps(report,indent=2)+'\n');print('COMPARISON_RESULT '+json.dumps(report,separators=(',',':')))
    finally:
        server.shutdown();server.server_close()
        # Artifacts contain only results and bounded synthetic logs, never installs/builds.
        for path in [stage,*builds.values(),out/'source.tar']:
            if path.is_dir():shutil.rmtree(path)
            elif path.exists():path.unlink()

if __name__=='__main__':main()
