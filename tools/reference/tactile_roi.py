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


def valid_curve(curve, confidence):
    return (curve is not None and len(curve) == 360 and np.isfinite(curve).all()
            and np.isfinite(confidence) and confidence >= .75
            and min(curve[0], curve[-1]) - curve.min() >= 25)


def interior_mask(foreground, curve, shape):
    """Exclude the optical rim with a 56-pixel Euclidean guard, then erode by 3.

    This is a viewer refinement, not a change to the upstream detection algorithm.
    A horizontal-only inset leaves the sloping parts of the bright rim visible.
    """
    offsets = np.arange(-56, 57)
    curve = curve.astype(np.float64)
    ys = np.arange(360)[:, None] + offsets
    extended = curve[np.clip(ys, 0, 359)]
    extended = np.where(ys < 0, curve[0] + ys * (curve[56]-curve[0])/56, extended)
    extended = np.where(ys > 359, curve[-1] + (ys-359) * (curve[-1]-curve[-57])/56, extended)
    boundary = np.max(extended + np.sqrt(56**2 - offsets**2), axis=1)
    region = reference.select_main_component(foreground)
    region &= np.arange(640)[None, :] >= boundary[:, None]
    region = reference.erode_mask(region, 3)
    height, width = shape
    xs = np.minimum(639, ((np.arange(width) + .5) * 640 / width).astype(int))
    ys = np.minimum(359, ((np.arange(height) + .5) * 360 / height).astype(int))
    return region[ys[:, None], xs].astype(np.uint8)


def broad_curve(gray, foreground):
    """Independent full-envelope retry; upstream reference remains unchanged."""
    rows = reference.local_peak_candidates(gray, foreground)
    meeting_x, meeting_y = reference.estimate_meeting_point(rows, 640)
    best = (-1, None, None)
    for y0 in np.arange(95., 255., 8.):
        for x0 in np.arange(18., 128., 4.):
            for curvature in np.linspace(.0014, .0065, 22):
                score, points = reference.score_u_curve(rows, x0, y0, curvature, 12.)
                score -= abs(x0-meeting_x)*.10 + abs(y0-meeting_y)*.025
                if score > best[0]:best = (score, y0, points)
    if best[2] is None or len(best[2]) < 72:return None, 0.
    points = np.asarray(best[2], dtype=np.float32)
    xs, ys = points[:, 0], points[:, 1]
    fitted, *_ = np.linalg.lstsq(np.column_stack((np.ones_like(ys), (ys-best[1])**2)), xs, rcond=None)
    y = np.arange(360, dtype=np.float32)
    model = float(fitted[0]) + float(np.clip(fitted[1], .0005, .012))*(y-best[1])**2
    selected_y, selected_x = reference.guided_curve_points(rows, model, 18.)
    curve = reference.smooth_curve(selected_y, selected_x, model)
    error = np.mean(np.abs(selected_x-np.interp(selected_y,y,curve))) if len(selected_y) else 30.
    confidence = np.clip(len(selected_y)/360*(1-min(error/30,.85)),0,1)
    return curve, float(confidence)


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
        method = 'local'
        if not valid_curve(curve, confidence):
            recovered, quality = broad_curve(gray, foreground)
            if valid_curve(recovered, quality):curve, confidence, method = recovered, quality, 'broader'
    finally:
        reference.local_peak_candidates = original
    mask = np.zeros(baseline.shape, dtype=np.uint8)
    accepted = (curve is not None and np.isfinite(curve).all() and np.isfinite(confidence)
                and confidence >= .75 and min(curve[0], curve[-1]) - curve.min() >= 25)
    if accepted:
        mask = interior_mask(foreground, curve, baseline.shape)
    return dict(mask=mask, status='ready' if mask.any() else 'not-found',
                confidence=float(confidence), method=method if mask.any() else None, curve=curve if curve is not None else np.empty(0, dtype=np.float32))


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


def biased_neighbor_baseline():
    y, x = np.mgrid[:360, :640]
    arc = 45 + .0035*(y-180)**2
    gray = np.where(x>=arc,104,25).astype(float)
    gray += 135*np.where(y<120,1,.4)*np.exp(-((x-arc)/4)**2)
    gray += np.where(y<120,225,70)*np.exp(-((x-32)/3)**2)
    return np.clip(gray,0,255).astype(np.uint8)


def borrow_region(baseline, donor_baseline, curve, confidence):
    """Independent checked transfer; input calibration statistics are never reused."""
    if baseline.shape != donor_baseline.shape or not valid_curve(curve, confidence):return None
    gray, donor = analysis_gray(baseline), analysis_gray(donor_baseline)
    xs = np.clip(np.floor(curve+.5).astype(int)[:,None]+np.arange(-12,33),0,639)
    ys = np.arange(360)[:,None]
    a = np.floor(gray[ys,xs].astype(np.float64)*255+.5)
    b = np.floor(donor[ys,xs].astype(np.float64)*255+.5)
    ac, bc = a-a.mean(axis=1,keepdims=True), b-b.mean(axis=1,keepdims=True)
    denom = np.linalg.norm(ac,axis=1)*np.linalg.norm(bc,axis=1)
    corr = np.divide((ac*bc).sum(axis=1),denom,out=np.zeros(360),where=denom>0)
    supported = (a.std(axis=1)>=5)&(b.std(axis=1)>=5)&(corr>=.70)
    if supported.sum()<180 or supported[:180].sum()<20 or supported[180:].sum()<20:return None
    result=interior_mask(reference.close_mask(gray>.075,3),curve,baseline.shape)
    return result if result.any() else None
