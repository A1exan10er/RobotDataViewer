"""Regenerate small, deterministic NumPy/OpenCV goldens for the supplied reference.
Requires numpy and opencv-python, never needed by the runtime or npm test.
"""
import base64
import json
from pathlib import Path
import cv2
import numpy as np

rng = np.random.default_rng(20260928)
def encode(a):
    return base64.b64encode(a.tobytes()).decode()

def rgba(rgb):
    return np.concatenate([rgb, np.full((*rgb.shape[:2], 1), 255, dtype=np.uint8)], axis=2)

cases = []
for width, height, count in [(19, 11, 8), (3, 7, 3), (1, 1, 1), (11, 9, 9)]:
    base = rng.integers(65, 150, (height, width, 3), dtype=np.uint8)
    frames = [rgba(np.clip(base.astype(np.int16) + rng.integers(-5, 6, base.shape), 0, 255).astype(np.uint8)) for _ in range(count)]
    stack = np.stack([cv2.cvtColor(f, cv2.COLOR_RGBA2GRAY) for f in frames])
    baseline = np.median(stack, axis=0).astype(np.uint8)
    noise = np.percentile(np.abs(stack.astype(np.int16) - baseline.astype(np.int16)), 99, axis=0).astype(np.float32)
    current = base.astype(np.int16)
    current[:max(1, height//2), :max(1, width//2)] += 27
    current[height//2:, width//2:] += 6
    current[0, -1] = 255
    current = rgba(np.clip(current, 0, 255).astype(np.uint8))
    gray = cv2.cvtColor(current, cv2.COLOR_RGBA2GRAY)
    gamma = np.array([pow(i/255, .7)*255 for i in range(256)], dtype=np.uint8)
    renders = []
    for cleanup in [True, False]:
        delta = cv2.absdiff(gray, baseline).astype(np.float32)
        cleaned = cv2.GaussianBlur(np.maximum(delta-noise-2, 0), (0,0), sigmaX=2, sigmaY=2) if cleanup else delta
        for gain in [1, 10, 16]:
            value = cv2.LUT(np.clip(cleaned*gain, 0, 255).astype(np.uint8), gamma)
            if cleanup:
                value[value < 10] = 0
            colored = cv2.applyColorMap(value, cv2.COLORMAP_INFERNO)
            colored[value == 0] = 0
            output = cv2.cvtColor(colored, cv2.COLOR_BGR2RGBA)
            renders.append(dict(gain=gain, cleanup=cleanup, output=encode(output)))
    cases.append(dict(width=width, height=height, frames=list(map(encode,frames)), baseline=encode(baseline), noiseFloor=encode(noise.astype('<f4')), gray=encode(gray), current=encode(current), renders=renders))
path = Path(__file__).parent/'fixtures'/'tactile-reference.json'
path.write_text(json.dumps(dict(description='Synthetic NumPy/OpenCV goldens for tools/reference/render_tactile_diff.py', cases=cases), indent=2)+'\n')
print(path)
