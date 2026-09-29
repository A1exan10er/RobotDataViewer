"""Recover bundled model/WASM build inputs from the portable runtime without executing JS."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('runtime',type=Path)
args=parser.parse_args()
text=args.runtime.read_text()
prefix='globalThis.RDV_FORCE_ASSETS='
if not text.startswith(prefix):raise SystemExit('Invalid force runtime')
assets=json.loads(text[len(prefix):].rstrip().removesuffix(';'))
out=Path(__file__).resolve().parents[2]/'vendor/force';out.mkdir(parents=True,exist_ok=True)
model=base64.b64decode(assets['model'],validate=True)
if hashlib.sha256(model).hexdigest()!=assets['manifest']['onnxSha256']:raise SystemExit('Model checksum mismatch')
(out/'force.onnx').write_bytes(model)
(out/'deepflow.wasm').write_bytes(base64.b64decode(assets['deepflowWasm'],validate=True))
print(out)
