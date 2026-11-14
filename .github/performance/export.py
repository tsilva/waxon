"""Export bounded, allowlisted synthetic comparison files through native job logs."""
from pathlib import Path
import argparse,base64,hashlib,json,os,re,stat

JSON_NAMES={'collector.json','urls.json','samples.json','result.json','browser.json','quiet-1.json','quiet-2.json'}
LOG_NAMES={'install.log','baseline-build.log','candidate-check.log','candidate-build.log','browser-1.log','browser-2.log'}

def selected_files(output, extra=None):
    root=output.resolve();items=[]
    if root.exists():
        for path in sorted(root.iterdir()):
            name=path.name
            allowed=name in JSON_NAMES or name in LOG_NAMES or name in {'baseline-detail.png','candidate-detail.png'} or re.fullmatch(r'response-[0-9]{2}-(baseline|candidate)[.]log',name)
            if allowed:
                assert not path.is_symlink() and stat.S_ISREG(path.stat().st_mode),'Export must be a regular owned result file'
                assert path.resolve().parent==root
                assert path.stat().st_size <= (2000000 if path.suffix=='.png' else 1000000),'Diagnostic file exceeds export bound'
                items.append(path)
    if extra and extra.exists():
        assert extra.name=='performance-tools-ages.json' and not extra.is_symlink() and extra.is_file() and extra.stat().st_size<100000
        items.append(extra)
    assert sum(path.stat().st_size for path in items)<=8000000,'Diagnostic export exceeds total bound'
    return items

def frames(path):
    data=path.read_bytes();digest=hashlib.sha256(data).hexdigest();name=path.name
    yield 'COMPARISON_FILE_START '+json.dumps({'name':name,'bytes':len(data),'sha256':digest})
    for offset in range(0,len(data),3072):
        yield 'COMPARISON_FILE_CHUNK '+json.dumps({'name':name,'offset':offset,'data':base64.b64encode(data[offset:offset+3072]).decode('ascii')})
    yield 'COMPARISON_FILE_END '+json.dumps({'name':name,'sha256':digest})

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    temp=Path(os.environ['RUNNER_TEMP']).resolve();output=args.output.resolve()
    assert output != temp and output.is_relative_to(temp),'Export must remain inside runner temp'
    files=selected_files(output,temp/'performance-tools-ages.json')
    print('COMPARISON_EXPORT '+json.dumps({'files':[p.name for p in files],'transport':'native job logs; no artifact action or policy change'}))
    for path in files:
        for frame in frames(path):print(frame,flush=True)

if __name__=='__main__':main()
