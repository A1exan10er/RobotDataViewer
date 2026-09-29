# Tactile display reference

`render_tactile_diff.py` is the supplied, unmodified offline reference for the
viewer's calibrated grayscale difference and Inferno heatmap. It estimates a
median baseline and per-pixel noise from the opening two seconds, then applies
noise subtraction, Gaussian smoothing, gain and gamma. The baseline stays fixed.

Requires Python 3, NumPy and OpenCV (`python3 -m pip install numpy opencv-python`).
For example, from the repository root:

```sh
python3 tools/reference/render_tactile_diff.py input.mp4 /tmp/tactile-diff.mp4 --gain 10 --gamma 0.7
```

The viewer ports this algorithm to TypeScript and runs it locally in workers;
it does not execute Python or require OpenCV at runtime. The opening interval
may contain existing contact. Image response is not calibrated force/pressure.

## Sensing-region reference

`generate_roi.py` is an unchanged copy of the arc detector from the local
FlawDetection project (`/home/tianyu/Projects/FlawDetection/generate_roi.py`).
Its SHA-256 is `7eec8bac257c518736fb8f048dc4fab45a4efe2b3637ac0e6669137bf613fc12`.
The original project is neither modified nor needed to build or run this viewer.
The reference requires Python 3, NumPy and Pillow:

```sh
python3 -m pip install numpy pillow
python3 tools/reference/generate_roi.py --input /path/to/images --output /tmp/tactile-roi --margin 14
python3 tests/make_tactile_roi_reference.py
```

The unchanged script's CLI generates diagnostic masks and overlays; its fallback
mask is **not** used by the viewer. `tactile_roi.py` is the independent NumPy
oracle for the viewer's adaptations: median grayscale input, centre-aligned
bilinear sampling to 640×360, a foreground surface check 14–30 pixels right of
each candidate, confidence ≥0.75, and both arc endpoints extending at least 25
pixels right of its leftmost point. Failed detections produce an empty mask.

The runtime TypeScript detector preserves the anchored curve fit and dominant
foreground component. The viewer replaces the original 14-pixel horizontal margin
with a 56-pixel Euclidean inward guard, followed by three erosion iterations. This
excludes the wide optical rim and its steep upper/lower sections, which otherwise
dominate the heatmap. The independent adapter uses the same guard for mask goldens;
the original detection reference remains unchanged. The
mask maps back by pixel-centre nearest-neighbor sampling and remains fixed with
the baseline. It applies before smoothing and after coloring, also in Show all
changes mode. Python, NumPy and Pillow are offline validation tools only.

The adapter now retries failed fits over the full existing vertex envelope.
Checked neighbor recovery uses 45-pixel rim strips, correlation ≥0.70 on at least
180 rows and at least 20 rows in each half, excluding rows with standard deviation
below five. It borrows only the curve and rebuilds the mask from the current image.
`python3 tests/make_tactile_neighbor_reference.py` generates independent synthetic
transfer goldens. The original supplied scripts remain unchanged.
