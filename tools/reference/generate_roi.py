#!/usr/bin/env python3
"""Generate and verify gripper ROI masks.

The ROI generator is intentionally separate from flaw detection. Its outputs
are meant for visual review before the masks are trusted by the detector.
"""

from __future__ import annotations

import argparse
import csv
from collections import deque
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


PRODUCTION_SIZE = (640, 360)
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff"}


@dataclass
class RoiResult:
    image: str
    roi_area: int
    total_area: int
    roi_ratio: float
    foreground_area: int
    curve_found: bool
    confidence: float
    curve_points: int
    mask_path: str
    overlay_path: str
    debug_path: str
    rect_x: int
    rect_y: int
    rect_width: int
    rect_height: int
    rect_area: int
    rect_ratio: float
    rect_mask_path: str
    rect_overlay_path: str


def image_resample_filter() -> int:
    return getattr(getattr(Image, "Resampling", Image), "BILINEAR")


def find_images(input_dir: Path) -> list[Path]:
    return sorted(
        path
        for path in input_dir.iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    )


def load_rgb(path: Path, size: tuple[int, int]) -> np.ndarray:
    image = Image.open(path).convert("RGB").resize(size, image_resample_filter())
    return np.asarray(image).astype(np.float32) / 255.0


def rgb_to_gray(image: np.ndarray) -> np.ndarray:
    return 0.299 * image[..., 0] + 0.587 * image[..., 1] + 0.114 * image[..., 2]


def erode_mask(mask: np.ndarray, iterations: int) -> np.ndarray:
    result = mask.copy()
    for _ in range(iterations):
        result = (
            result
            & np.roll(result, 1, axis=0)
            & np.roll(result, -1, axis=0)
            & np.roll(result, 1, axis=1)
            & np.roll(result, -1, axis=1)
        )
        result[0, :] = False
        result[-1, :] = False
        result[:, 0] = False
        result[:, -1] = False
    return result


def dilate_mask(mask: np.ndarray, iterations: int) -> np.ndarray:
    result = mask.copy()
    for _ in range(iterations):
        result = (
            result
            | np.roll(result, 1, axis=0)
            | np.roll(result, -1, axis=0)
            | np.roll(result, 1, axis=1)
            | np.roll(result, -1, axis=1)
        )
    return result


def close_mask(mask: np.ndarray, iterations: int) -> np.ndarray:
    return erode_mask(dilate_mask(mask, iterations), iterations)


def connected_components(mask: np.ndarray) -> list[dict[str, object]]:
    height, width = mask.shape
    visited = np.zeros_like(mask, dtype=bool)
    components: list[dict[str, object]] = []

    for start_y, start_x in zip(*np.nonzero(mask & ~visited)):
        if visited[start_y, start_x]:
            continue

        queue: deque[tuple[int, int]] = deque([(int(start_y), int(start_x))])
        visited[start_y, start_x] = True
        pixels: list[tuple[int, int]] = []
        min_x = max_x = int(start_x)
        min_y = max_y = int(start_y)

        while queue:
            y, x = queue.popleft()
            pixels.append((y, x))
            min_x = min(min_x, x)
            max_x = max(max_x, x)
            min_y = min(min_y, y)
            max_y = max(max_y, y)

            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if ny < 0 or ny >= height or nx < 0 or nx >= width:
                    continue
                if visited[ny, nx] or not mask[ny, nx]:
                    continue
                visited[ny, nx] = True
                queue.append((ny, nx))

        ys = np.array([pixel[0] for pixel in pixels], dtype=np.int32)
        xs = np.array([pixel[1] for pixel in pixels], dtype=np.int32)
        component_mask = np.zeros_like(mask, dtype=bool)
        component_mask[ys, xs] = True
        components.append(
            {
                "mask": component_mask,
                "area": len(pixels),
                "bbox": (min_x, min_y, max_x, max_y),
                "centroid_x": float(np.mean(xs)),
                "centroid_y": float(np.mean(ys)),
            }
        )

    return components


def select_main_component(foreground: np.ndarray) -> np.ndarray:
    components = connected_components(foreground)
    if not components:
        return foreground

    height, width = foreground.shape
    candidates = []
    for component in components:
        area = int(component["area"])
        min_x, min_y, max_x, max_y = component["bbox"]
        centroid_x = float(component["centroid_x"])
        spans_body = max_x > width * 0.45 and max_y - min_y > height * 0.45
        is_tiny = area < width * height * 0.01
        if not is_tiny and spans_body:
            candidates.append((area, centroid_x, component))

    if not candidates:
        candidates = [(int(component["area"]), float(component["centroid_x"]), component) for component in components]

    # Prefer the dominant component; the centroid tie-break avoids selecting a
    # partial neighboring gripper if it has similar area on the left edge.
    candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return candidates[0][2]["mask"]


def median_filter_1d(values: np.ndarray, window: int) -> np.ndarray:
    radius = window // 2
    result = values.copy()
    for index in range(values.size):
        start = max(0, index - radius)
        end = min(values.size, index + radius + 1)
        result[index] = np.median(values[start:end])
    return result


def row_runs(row: np.ndarray) -> list[tuple[int, int]]:
    xs = np.flatnonzero(row)
    if xs.size == 0:
        return []
    breaks = np.where(np.diff(xs) > 1)[0]
    starts = np.concatenate(([xs[0]], xs[breaks + 1]))
    ends = np.concatenate((xs[breaks], [xs[-1]]))
    return [(int(start), int(end)) for start, end in zip(starts, ends)]


def smooth_gray(gray: np.ndarray) -> np.ndarray:
    padded = np.pad(gray, ((1, 1), (1, 1)), mode="edge")
    result = np.zeros_like(gray)
    for dy in range(3):
        for dx in range(3):
            result += padded[dy : dy + gray.shape[0], dx : dx + gray.shape[1]]
    return result / 9.0


def edge_score(gray: np.ndarray) -> np.ndarray:
    smooth = smooth_gray(gray)
    gx = np.zeros_like(smooth)
    gy = np.zeros_like(smooth)
    gx[:, 1:-1] = smooth[:, 2:] - smooth[:, :-2]
    gy[1:-1, :] = smooth[2:, :] - smooth[:-2, :]
    gradient = np.sqrt(gx * gx + gy * gy)
    return 0.65 * smooth + 2.2 * gradient


def local_peak_candidates(gray: np.ndarray, foreground: np.ndarray) -> list[list[tuple[int, float]]]:
    height, width = gray.shape
    score = edge_score(gray)
    max_x = min(width - 2, int(width * 0.42))
    candidates_by_row: list[list[tuple[int, float]]] = []

    for y in range(height):
        row_candidates: list[tuple[int, float]] = []
        for x in range(8, max_x):
            if not foreground[y, x]:
                continue
            value = float(score[y, x])
            if value < 0.38:
                continue
            if value >= score[y, x - 1] and value >= score[y, x + 1]:
                row_candidates.append((x, value))
        row_candidates.sort(key=lambda item: item[1], reverse=True)
        candidates_by_row.append(row_candidates[:12])

    return candidates_by_row


def estimate_meeting_point(candidates_by_row: list[list[tuple[int, float]]], width: int) -> tuple[float, float]:
    votes: list[tuple[float, int, int]] = []
    for y, candidates in enumerate(candidates_by_row):
        for x, value in candidates:
            if 18 <= x <= width * 0.22:
                center_weight = 1.0 - min(abs(y - 180.0) / 180.0, 0.9)
                votes.append((value * (0.35 + center_weight), x, y))

    if not votes:
        return width * 0.08, 180.0

    votes.sort(reverse=True)
    top = votes[: min(80, len(votes))]
    weights = np.array([item[0] for item in top], dtype=np.float32)
    xs = np.array([item[1] for item in top], dtype=np.float32)
    ys = np.array([item[2] for item in top], dtype=np.float32)
    return float(np.average(xs, weights=weights)), float(np.average(ys, weights=weights))


def score_u_curve(
    candidates_by_row: list[list[tuple[int, float]]],
    x0: float,
    y0: float,
    curvature: float,
    tolerance: float,
) -> tuple[float, list[tuple[float, float]]]:
    selected: list[tuple[float, float]] = []
    total = 0.0

    for y, candidates in enumerate(candidates_by_row):
        predicted_x = x0 + curvature * (float(y) - y0) ** 2
        if predicted_x < 0:
            continue
        best_score = 0.0
        best_x: float | None = None
        for x, value in candidates:
            error = abs(float(x) - predicted_x)
            if error > tolerance:
                continue
            inner_edge_bonus = 1.0 + 0.22 * max(0.0, float(x) - predicted_x) / (tolerance + 1e-6)
            candidate_score = value * (1.0 - error / (tolerance + 1e-6)) * inner_edge_bonus
            if candidate_score > best_score:
                best_score = candidate_score
                best_x = float(x)
        if best_x is not None:
            total += best_score
            selected.append((best_x, float(y)))

    coverage_bonus = min(len(selected) / 220.0, 1.0)
    return total * (0.5 + coverage_bonus), selected


def guided_curve_points(
    candidates_by_row: list[list[tuple[int, float]]],
    model_x: np.ndarray,
    tolerance: float,
) -> tuple[np.ndarray, np.ndarray]:
    selected_y: list[float] = []
    selected_x: list[float] = []

    for y, candidates in enumerate(candidates_by_row):
        if not candidates:
            continue
        predicted_x = float(model_x[y])
        best_score = 0.0
        best_x: float | None = None
        for x, value in candidates:
            error = abs(float(x) - predicted_x)
            if error > tolerance:
                continue
            # Prefer the inner edge when two bright rim edges are close. The
            # desired ROI boundary is the edge nearer the gripper surface, not
            # the outer neighboring edge.
            inner_edge_bonus = 1.0 + 0.35 * max(0.0, float(x) - predicted_x) / (tolerance + 1e-6)
            score = value * (1.0 - error / (tolerance + 1e-6)) * inner_edge_bonus
            if score > best_score:
                best_score = score
                best_x = float(x)
        if best_x is not None:
            selected_y.append(float(y))
            selected_x.append(best_x)

    return np.array(selected_y, dtype=np.float32), np.array(selected_x, dtype=np.float32)


def smooth_curve(selected_y: np.ndarray, selected_x: np.ndarray, model_x: np.ndarray) -> np.ndarray:
    height = model_x.size
    if selected_y.size < 4:
        return model_x

    y_grid = np.arange(height, dtype=np.float32)
    interpolated = np.interp(y_grid, selected_y, selected_x, left=model_x[0], right=model_x[-1])
    interpolated = np.clip(interpolated, model_x - 18.0, model_x + 18.0)

    # Blend back toward the guided model at rows with no observations to avoid
    # unstable jumps caused by local glare or missing edge points.
    observed = np.zeros(height, dtype=np.float32)
    observed[np.clip(selected_y.astype(np.int32), 0, height - 1)] = 1.0
    support = np.convolve(observed, np.ones(21, dtype=np.float32), mode="same")
    weight = np.clip(support / 10.0, 0.0, 0.55)
    blended = weight * interpolated + (1.0 - weight) * model_x

    smoothed = median_filter_1d(blended.astype(np.float32), window=41)
    kernel = np.ones(31, dtype=np.float32) / 31.0
    padded = np.pad(smoothed, (15, 15), mode="edge")
    return np.convolve(padded, kernel, mode="valid").astype(np.float32)


def fit_boundary_curve(gray: np.ndarray, foreground: np.ndarray) -> tuple[np.ndarray | None, np.ndarray, np.ndarray, float]:
    height, width = foreground.shape
    candidates_by_row = local_peak_candidates(gray, foreground)
    meeting_x, meeting_y = estimate_meeting_point(candidates_by_row, width)

    y0_values = np.arange(max(95.0, meeting_y - 55.0), min(255.0, meeting_y + 55.0), 8.0)
    x0_values = np.arange(max(18.0, meeting_x - 32.0), min(width * 0.20, meeting_x + 32.0), 4.0)
    curvature_values = np.linspace(0.0014, 0.0065, 22)

    best_score = -1.0
    best_model: tuple[float, float, float] | None = None
    best_points: list[tuple[float, float]] = []

    for y0 in y0_values:
        for x0 in x0_values:
            for curvature in curvature_values:
                score, points = score_u_curve(candidates_by_row, float(x0), float(y0), float(curvature), 12.0)
                anchor_penalty = abs(float(x0) - meeting_x) * 0.10 + abs(float(y0) - meeting_y) * 0.025
                score -= anchor_penalty
                if score > best_score:
                    best_score = score
                    best_model = (float(x0), float(y0), float(curvature))
                    best_points = points

    if best_model is None or len(best_points) < height * 0.20:
        return None, np.empty(0), np.empty(0), 0.0

    points = np.array(best_points, dtype=np.float32)
    xs = points[:, 0]
    ys = points[:, 1]
    x0, y0, curvature = best_model

    design = np.column_stack((np.ones_like(ys), (ys - y0) ** 2))
    refined, *_ = np.linalg.lstsq(design, xs, rcond=None)
    x0 = float(refined[0])
    curvature = float(max(0.0005, min(0.012, refined[1])))

    y_grid = np.arange(height, dtype=np.float32)
    model_x = x0 + curvature * (y_grid - y0) ** 2
    selected_y, selected_x = guided_curve_points(candidates_by_row, model_x, tolerance=18.0)
    curve_x = smooth_curve(selected_y, selected_x, model_x)

    if selected_y.size:
        fitted_at_selected = np.interp(selected_y, y_grid, curve_x)
        mean_error = float(np.mean(np.abs(selected_x - fitted_at_selected)))
    else:
        mean_error = 30.0
    coverage = min(selected_y.size / float(height), 1.0)
    confidence = max(0.0, min(1.0, coverage * (1.0 - min(mean_error / 30.0, 0.85))))

    return curve_x.astype(np.float32), selected_y, selected_x, confidence


def generate_roi(image: np.ndarray, margin: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, bool, float]:
    gray = rgb_to_gray(image)
    foreground = gray > 0.075
    foreground = close_mask(foreground, iterations=3)
    main_component = select_main_component(foreground)

    curve_x, curve_ys, curve_xs, confidence = fit_boundary_curve(gray, foreground)
    height, width = gray.shape

    if curve_x is None:
        roi = erode_mask(main_component, iterations=4)
        return roi, main_component, np.empty((0, 2), dtype=np.float32), False, confidence

    y_grid = np.arange(height, dtype=np.float32)
    x_grid = np.arange(width, dtype=np.float32)[None, :]
    curve_mask = x_grid >= (curve_x[:, None] + float(margin))
    roi = main_component & curve_mask

    # Avoid image borders and unstable rim pixels.
    roi = erode_mask(roi, iterations=3)

    full_curve_points = np.column_stack((curve_x, y_grid)).astype(np.float32)
    curve_points = full_curve_points[
        (full_curve_points[:, 0] >= 0) & (full_curve_points[:, 0] < width)
    ]
    return roi, main_component, curve_points, True, confidence


def save_mask(mask: np.ndarray, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image = Image.fromarray((mask.astype(np.uint8) * 255), "L")
    image.save(output_path)


def rectangle_from_roi(roi: np.ndarray, inset: int) -> tuple[int, int, int, int]:
    bbox = mask_bbox(roi)
    if bbox is None:
        return 0, 0, roi.shape[1], roi.shape[0]
    x0, y0, x1, y1 = bbox
    x0 = min(max(0, x0 + inset), roi.shape[1] - 1)
    y0 = min(max(0, y0 + inset), roi.shape[0] - 1)
    x1 = max(min(roi.shape[1] - 1, x1 - inset), x0)
    y1 = max(min(roi.shape[0] - 1, y1 - inset), y0)
    return x0, y0, x1 - x0 + 1, y1 - y0 + 1


def rectangle_mask(shape: tuple[int, int], rect: tuple[int, int, int, int]) -> np.ndarray:
    x, y, width, height = rect
    mask = np.zeros(shape, dtype=bool)
    mask[y : y + height, x : x + width] = True
    return mask


def save_rectangle_overlay(
    image: np.ndarray,
    rect: tuple[int, int, int, int],
    output_path: Path,
) -> None:
    base = Image.fromarray((np.clip(image, 0.0, 1.0) * 255).astype(np.uint8)).convert("RGBA")
    color = np.zeros((image.shape[0], image.shape[1], 4), dtype=np.uint8)
    x, y, width, height = rect
    color[y : y + height, x : x + width, 1] = 255
    color[y : y + height, x : x + width, 3] = 85
    overlay = Image.alpha_composite(base, Image.fromarray(color, "RGBA"))
    draw = ImageDraw.Draw(overlay)
    draw.rectangle((x, y, x + width - 1, y + height - 1), outline=(0, 255, 0, 255), width=3)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    overlay.convert("RGB").save(output_path, quality=92)


def save_overlay(
    image: np.ndarray,
    roi: np.ndarray,
    curve_points: np.ndarray,
    output_path: Path,
) -> None:
    base = Image.fromarray((np.clip(image, 0.0, 1.0) * 255).astype(np.uint8)).convert("RGBA")
    color = np.zeros((*roi.shape, 4), dtype=np.uint8)
    color[..., 1] = 255
    color[..., 3] = roi.astype(np.uint8) * 95
    overlay = Image.alpha_composite(base, Image.fromarray(color, "RGBA"))
    draw = ImageDraw.Draw(overlay)
    bbox = mask_bbox(roi)
    if bbox is not None:
        draw.rectangle(bbox, outline=(0, 255, 0, 255), width=2)
    if curve_points.size:
        points = [(float(x), float(y)) for x, y in curve_points]
        if len(points) >= 2:
            draw.line(points, fill=(255, 255, 0, 255), width=3)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    overlay.convert("RGB").save(output_path, quality=92)


def save_debug(
    image: np.ndarray,
    foreground: np.ndarray,
    roi: np.ndarray,
    curve_points: np.ndarray,
    output_path: Path,
) -> None:
    base = Image.fromarray((np.clip(image, 0.0, 1.0) * 255).astype(np.uint8)).convert("RGBA")

    debug = np.zeros((*roi.shape, 4), dtype=np.uint8)
    debug[..., 0] = foreground.astype(np.uint8) * 255
    debug[..., 3] = foreground.astype(np.uint8) * 70
    debug[..., 1] = roi.astype(np.uint8) * 255
    debug[..., 3] = np.maximum(debug[..., 3], roi.astype(np.uint8) * 105)
    merged = Image.alpha_composite(base, Image.fromarray(debug, "RGBA"))
    draw = ImageDraw.Draw(merged)

    if curve_points.size:
        points = [(float(x), float(y)) for x, y in curve_points]
        for point in points[:: max(1, len(points) // 160)]:
            x, y = point
            draw.ellipse((x - 2, y - 2, x + 2, y + 2), fill=(255, 255, 0, 255))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    merged.convert("RGB").save(output_path, quality=92)


def mask_bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.nonzero(mask)
    if xs.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def write_summary(rows: list[RoiResult], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "image",
        "roi_area",
        "total_area",
        "roi_ratio",
        "foreground_area",
        "curve_found",
        "confidence",
        "curve_points",
        "mask_path",
        "overlay_path",
        "debug_path",
        "rect_x",
        "rect_y",
        "rect_width",
        "rect_height",
        "rect_area",
        "rect_ratio",
        "rect_mask_path",
        "rect_overlay_path",
    ]
    with output_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    "image": row.image,
                    "roi_area": row.roi_area,
                    "total_area": row.total_area,
                    "roi_ratio": f"{row.roi_ratio:.4f}",
                    "foreground_area": row.foreground_area,
                    "curve_found": str(row.curve_found).lower(),
                    "confidence": f"{row.confidence:.4f}",
                    "curve_points": row.curve_points,
                    "mask_path": row.mask_path,
                    "overlay_path": row.overlay_path,
                    "debug_path": row.debug_path,
                    "rect_x": row.rect_x,
                    "rect_y": row.rect_y,
                    "rect_width": row.rect_width,
                    "rect_height": row.rect_height,
                    "rect_area": row.rect_area,
                    "rect_ratio": f"{row.rect_ratio:.4f}",
                    "rect_mask_path": row.rect_mask_path,
                    "rect_overlay_path": row.rect_overlay_path,
                }
            )


def create_contact_sheet(image_paths: list[Path], output_path: Path) -> None:
    if not image_paths:
        return
    thumb_w, thumb_h = 320, 180
    label_h = 24
    cols = 4
    rows = (len(image_paths) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * thumb_w, rows * (thumb_h + label_h)), "white")
    draw = ImageDraw.Draw(sheet)
    for index, path in enumerate(image_paths):
        image = Image.open(path).convert("RGB").resize((thumb_w, thumb_h), image_resample_filter())
        x = (index % cols) * thumb_w
        y = (index // cols) * (thumb_h + label_h)
        sheet.paste(image, (x, y))
        draw.rectangle((x, y + thumb_h, x + thumb_w - 1, y + thumb_h + label_h - 1), fill=(245, 245, 245))
        draw.text((x + 6, y + thumb_h + 6), path.name.replace("_roi_overlay.jpg", ""), fill=(0, 0, 0))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path, quality=92)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate gripper ROI verification outputs")
    parser.add_argument("--input", type=Path, default=Path("TrainingSet"))
    parser.add_argument("--output", type=Path, default=Path("outputs/roi"))
    parser.add_argument("--width", type=int, default=PRODUCTION_SIZE[0])
    parser.add_argument("--height", type=int, default=PRODUCTION_SIZE[1])
    parser.add_argument("--margin", type=int, default=14)
    parser.add_argument("--rect-inset", type=int, default=8)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    size = (args.width, args.height)
    image_paths = find_images(args.input)
    if not image_paths:
        raise SystemExit(f"No images found in {args.input}")

    mask_dir = args.output / "masks"
    overlay_dir = args.output / "overlays"
    debug_dir = args.output / "debug"
    rect_mask_dir = args.output / "rect_masks"
    rect_overlay_dir = args.output / "rect_overlays"

    rows: list[RoiResult] = []
    overlay_paths: list[Path] = []
    debug_paths: list[Path] = []

    for path in image_paths:
        image = load_rgb(path, size)
        roi, foreground, curve_points, curve_found, confidence = generate_roi(image, margin=args.margin)
        rect = rectangle_from_roi(roi, inset=args.rect_inset)
        rect_mask = rectangle_mask(roi.shape, rect)
        mask_path = mask_dir / f"{path.stem}_roi_mask.png"
        overlay_path = overlay_dir / f"{path.stem}_roi_overlay.jpg"
        debug_path = debug_dir / f"{path.stem}_curve_debug.jpg"
        rect_mask_path = rect_mask_dir / f"{path.stem}_surface_rect_mask.png"
        rect_overlay_path = rect_overlay_dir / f"{path.stem}_surface_rect_overlay.jpg"
        save_mask(roi, mask_path)
        save_mask(rect_mask, rect_mask_path)
        save_overlay(image, roi, curve_points, overlay_path)
        save_rectangle_overlay(image, rect, rect_overlay_path)
        save_debug(image, foreground, roi, curve_points, debug_path)
        overlay_paths.append(overlay_path)
        debug_paths.append(debug_path)

        total_area = int(roi.size)
        roi_area = int(np.sum(roi))
        rect_area = int(np.sum(rect_mask))
        rows.append(
            RoiResult(
                image=path.name,
                roi_area=roi_area,
                total_area=total_area,
                roi_ratio=roi_area / total_area,
                foreground_area=int(np.sum(foreground)),
                curve_found=curve_found,
                confidence=confidence,
                curve_points=int(curve_points.shape[0]),
                mask_path=str(mask_path),
                overlay_path=str(overlay_path),
                debug_path=str(debug_path),
                rect_x=rect[0],
                rect_y=rect[1],
                rect_width=rect[2],
                rect_height=rect[3],
                rect_area=rect_area,
                rect_ratio=rect_area / total_area,
                rect_mask_path=str(rect_mask_path),
                rect_overlay_path=str(rect_overlay_path),
            )
        )

    write_summary(rows, args.output / "roi_summary.csv")
    create_contact_sheet(overlay_paths, args.output / "roi_overlay_contact_sheet.jpg")
    create_contact_sheet(debug_paths, args.output / "roi_debug_contact_sheet.jpg")
    create_contact_sheet(
        sorted(rect_overlay_dir.glob("*_surface_rect_overlay.jpg")),
        args.output / "surface_rect_contact_sheet.jpg",
    )

    found_count = sum(1 for row in rows if row.curve_found)
    mean_confidence = float(np.mean([row.confidence for row in rows])) if rows else 0.0
    mean_roi_ratio = float(np.mean([row.roi_ratio for row in rows])) if rows else 0.0
    print(f"Images processed: {len(rows)}")
    print(f"Production size: {size[0]}x{size[1]}")
    print(f"Curve found: {found_count}/{len(rows)}")
    print(f"Mean confidence: {mean_confidence:.4f}")
    print(f"Mean ROI ratio: {mean_roi_ratio:.4f}")
    print(f"Summary: {args.output / 'roi_summary.csv'}")
    print(f"Masks: {mask_dir}")
    print(f"Overlays: {overlay_dir}")
    print(f"Debug: {debug_dir}")
    print(f"Rectangle masks: {rect_mask_dir}")
    print(f"Rectangle overlays: {rect_overlay_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
