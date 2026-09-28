"""Independent NumPy oracle for the viewer's additions to generate_roi.py.

The upstream file stays unchanged. This adapter uses the existing median gray
baseline, normalized analysis coordinates, a surface check, and fail-closed gates.
"""
import numpy as np
import generate_roi as reference


def analysis_gray(baseline):
    height, width = baseline.shape
    x = np.clip((np.arange(640) + .5) * width / 640 - .5, 0, width - 1)
    y = np.clip((np.arange(360) + .5) * height / 360 - .5, 0, height - 1)
    x0, y0 = x.astype(int), y.astype(int)
    x1, y1 = np.minimum(x0 + 1, width - 1), np.minimum(y0 + 1, height - 1)
    fx, fy = x - x0, (y - y0)[:, None]
    top = baseline[y0[:, None], x0] * (1 - fx) + baseline[y0[:, None], x1] * fx
    bottom = baseline[y1[:, None], x0] * (1 - fx) + baseline[y1[:, None], x1] * fx
    return ((top * (1 - fy) + bottom * fy) / 255).astype(np.float32)


def detect_region(baseline):
    gray = analysis_gray(baseline)
    foreground = reference.close_mask(gray > .075, 3)
    original = reference.local_peak_candidates

    def candidates(gray, foreground):
        return [[(x, value) for x, value in row if np.median(gray[y, x+14:x+31]) > .075]
                for y, row in enumerate(original(gray, foreground))]

    reference.local_peak_candidates = candidates
    try:
        curve, _, _, confidence = reference.fit_boundary_curve(gray, foreground)
    finally:
        reference.local_peak_candidates = original
    mask = np.zeros(baseline.shape, dtype=np.uint8)
    accepted = (curve is not None and np.isfinite(curve).all() and np.isfinite(confidence)
                and confidence >= .75 and min(curve[0], curve[-1]) - curve.min() >= 25)
    if accepted:
        region = reference.select_main_component(foreground)
        region &= np.arange(640)[None, :] >= curve[:, None] + 14
        region = reference.erode_mask(region, 3)
        height, width = baseline.shape
        xs = np.minimum(639, ((np.arange(width) + .5) * 640 / width).astype(int))
        ys = np.minimum(359, ((np.arange(height) + .5) * 360 / height).astype(int))
        mask = region[ys[:, None], xs].astype(np.uint8)
    return dict(mask=mask, status='ready' if mask.any() else 'not-found',
                confidence=float(confidence), curve=curve if curve is not None else np.empty(0, dtype=np.float32))


def synthetic_baseline(width=640, height=360, seed=7, contact=False, neighbor=True):
    """A textured sensing surface, two rim edges, and a separate neighboring rim."""
    y, x = np.mgrid[:height, :width]
    x = (x + .5) * 640 / width - .5
    y = (y + .5) * 360 / height - .5
    arc = 50 + .0032 * (y - 177) ** 2
    rng = np.random.default_rng(seed)
    gray = np.where(x >= arc, 104 + rng.integers(-4, 5, (height, width)), 9).astype(float)
    gray += 135 * np.exp(-((x - arc) / 4) ** 2)
    gray += 160 * np.exp(-((x - arc + 10) / 3) ** 2)
    if neighbor:
        gray += 200 * np.exp(-((x - 24 - .00015 * (y - 180) ** 2) / 3) ** 2)
    if contact:
        gray[(x > 230) & (x < 420) & (y > 100) & (y < 260)] += 65
    return np.clip(gray, 0, 255).astype(np.uint8)
