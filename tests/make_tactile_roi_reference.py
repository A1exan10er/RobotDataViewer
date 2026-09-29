"""Regenerate independent arc/mask goldens; requires NumPy and Pillow."""
import base64
import json
import sys
import zlib
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools' / 'reference'))
from tactile_roi import detect_region, synthetic_baseline, biased_neighbor_baseline


def encode(array):
    return base64.b64encode(zlib.compress(array.tobytes(), 9)).decode()


cases = []
inputs = {
    'biased-neighbor': biased_neighbor_baseline(),
    'curved-rim': synthetic_baseline(neighbor=False),
    'neighboring-rim': synthetic_baseline(),
    'existing-contact': synthetic_baseline(contact=True),
    'odd-dimensions': synthetic_baseline(161, 93),
    'black': np.zeros((36, 64), dtype=np.uint8),
    'white': np.full((36, 64), 255, dtype=np.uint8),
    'straight-edge': np.tile(np.where(np.arange(640) < 55, 13, 179), (360, 1)).astype(np.uint8),
    'noise': np.clip(127 + np.random.default_rng(7).normal(0, 9, (360, 640)), 0, 255).astype(np.uint8),
    'weak-rim': np.where(synthetic_baseline(neighbor=False) > 130, 103, 100).astype(np.uint8),
    'obscured-arc': np.full((93, 161), 104, dtype=np.uint8),
}
for name, baseline in inputs.items():
    region = detect_region(baseline)
    cases.append(dict(name=name, width=baseline.shape[1], height=baseline.shape[0],
                      baseline=encode(baseline), mask=encode(region['mask']),
                      curve=encode(region['curve'].astype('<f4')), status=region['status'], confidence=region['confidence'], method=region['method']))
    print(name, region['status'], round(region['confidence'], 4), flush=True)
path = Path(__file__).parent / 'fixtures' / 'tactile-roi.json'
path.write_text(json.dumps(dict(description='NumPy arc detection goldens; arrays are zlib + base64', cases=cases), indent=2) + '\n')
