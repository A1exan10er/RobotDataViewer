# -*- coding: utf-8 -*-
"""Diff helpers: legacy relative Image_Diff or Image_New_Diff (offset + /255)."""
from __future__ import annotations

from typing import Optional

import cv2
import numpy as np
import torch


DIFF_EPSILON = 1.0
DIFF_VIS_CLIP = 1.0
DIFF_DECIMALS = 2


def quantize_diff(diff: np.ndarray, decimals: int = DIFF_DECIMALS) -> np.ndarray:
    """Round relative diff to fixed decimals (model input + display)."""
    return np.round(np.asarray(diff, dtype=np.float32), int(decimals)).astype(np.float32)


def diff_to_vis(diff: np.ndarray, clip: float = DIFF_VIS_CLIP) -> np.ndarray:
    """Map diff to BGR visualization (TURBO colormap)."""
    d = np.asarray(diff, dtype=np.float32)
    if float(d.min()) >= -0.05:
        norm = np.clip(d / max(clip, 1e-6), 0.0, 1.0)
        u8 = (norm * 255.0).astype(np.uint8)
        return cv2.applyColorMap(u8, cv2.COLORMAP_TURBO)
    clipped = np.clip(d, -clip, clip)
    norm = ((clipped + clip) / (2.0 * clip) * 255.0).astype(np.uint8)
    return cv2.applyColorMap(norm, cv2.COLORMAP_TURBO)


def compute_offset_diff(
    ref_bgr: np.ndarray,
    cur_bgr: np.ndarray,
    *,
    offset: float = 127.0,
    diff_scale: Optional[float] = 255.0,
) -> np.ndarray:
    """clip(cur - ref + offset, 0, 255) [/ diff_scale] — matches batch_new_diff."""
    if ref_bgr.ndim == 2:
        ref = ref_bgr.astype(np.float32)
    else:
        ref = cv2.cvtColor(ref_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    if cur_bgr.ndim == 2:
        cur = cur_bgr.astype(np.float32)
    else:
        cur = cv2.cvtColor(cur_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    if ref.shape != cur.shape:
        raise ValueError(f"diff size mismatch: I0={ref.shape}, I1={cur.shape}")
    diff = np.clip(cur - ref + float(offset), 0.0, 255.0).astype(np.float32)
    if diff_scale is not None:
        diff = diff / float(diff_scale)
    return diff


def compute_relative_diff(
    ref_bgr: np.ndarray,
    cur_bgr: np.ndarray,
    *,
    epsilon: float = DIFF_EPSILON,
    decimals: int = DIFF_DECIMALS,
) -> np.ndarray:
    """Return (H, W) float32 relative gray diff: (I1-I0)/max(I0, eps)."""
    if ref_bgr.ndim == 2:
        ref = ref_bgr.astype(np.float32)
    else:
        ref = cv2.cvtColor(ref_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    if cur_bgr.ndim == 2:
        cur = cur_bgr.astype(np.float32)
    else:
        cur = cv2.cvtColor(cur_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    if ref.shape != cur.shape:
        raise ValueError(f"diff size mismatch: I0={ref.shape}, I1={cur.shape}")
    diff = (cur - ref) / np.maximum(ref, float(epsilon))
    return quantize_diff(diff, decimals=decimals)


def make_diff_click_callback(state: dict, window_name: str = "3. Image Diff"):
    """Left-click on Image Diff window → print real diff value to terminal.

    ``state`` must keep key ``diff`` updated to the latest (H,W) float array.
    """

    def _map_to_image(x: int, y: int, w: int, h: int) -> tuple[int, int]:
        """Map window mouse coords → image pixel; prefer raw if already in-bounds."""
        # Many OpenCV backends already report image-pixel coords for imshow.
        if 0 <= x < w and 0 <= y < h:
            return x, y
        try:
            rx, ry, rw, rh = cv2.getWindowImageRect(window_name)
        except cv2.error:
            return x, y
        if rw <= 0 or rh <= 0:
            return x, y
        # Client-area click → image rectangle, then scale to source resolution.
        ix = int((x - rx) * w / rw)
        iy = int((y - ry) * h / rh)
        if 0 <= ix < w and 0 <= iy < h:
            return ix, iy
        # Fallback without origin offset (some backends set rx/ry oddly).
        ix = int(x * w / rw)
        iy = int(y * h / rh)
        return ix, iy

    def on_mouse(event, x, y, flags, param):  # noqa: ARG001
        if event != cv2.EVENT_LBUTTONDOWN:
            return
        diff = state.get("diff")
        if diff is None:
            print("[diff] 尚无差分数据")
            return
        h, w = diff.shape[:2]
        ix, iy = _map_to_image(int(x), int(y), w, h)
        if not (0 <= ix < w and 0 <= iy < h):
            print(f"[diff] 点击窗口坐标 ({x},{y}) → 图像 ({ix},{iy}) 超出 {w}x{h}")
            return
        print(f"[diff] (x={ix}, y={iy}) value={float(diff[iy, ix]):.2f}")

    return on_mouse


def load_diff_array(path: str, diff_scale: Optional[float] = None) -> np.ndarray:
    """Load diff npz/npy as (H, W) float32; optionally divide by diff_scale."""
    loaded = np.load(path)
    if hasattr(loaded, "files"):
        key = "diff" if "diff" in loaded.files else loaded.files[0]
        arr = loaded[key]
    else:
        arr = loaded
    arr = np.asarray(arr, dtype=np.float32)
    if arr.ndim == 3:
        if arr.shape[0] == 1:
            arr = arr[0]
        elif arr.shape[-1] == 1:
            arr = arr[..., 0]
        else:
            raise ValueError(f"Unexpected diff shape {arr.shape}: {path}")
    if arr.ndim != 2:
        raise ValueError(f"Expected (H,W) diff, got {arr.shape}: {path}")
    if diff_scale is not None:
        arr = arr / float(diff_scale)
    elif float(arr.max()) > 1.5:
        arr = arr / 255.0
    return arr.astype(np.float32)


def concat_flow_diff(flow: np.ndarray, diff: np.ndarray) -> np.ndarray:
    """flow (H,W,2) + diff (H,W) -> (H,W,3) float32 [u, v, diff]."""
    flow = np.asarray(flow, dtype=np.float32)
    diff = np.asarray(diff, dtype=np.float32)
    if flow.ndim != 3 or flow.shape[-1] != 2:
        raise ValueError(f"Expected flow (H,W,2), got {flow.shape}")
    if diff.ndim != 2:
        raise ValueError(f"Expected diff (H,W), got {diff.shape}")
    if diff.shape != flow.shape[:2]:
        raise ValueError(f"Flow/diff spatial mismatch: {flow.shape} vs {diff.shape}")
    return np.concatenate([flow, diff[..., None]], axis=-1)


def build_model_input_tensor(
    flow: np.ndarray,
    diff: Optional[np.ndarray],
    device: torch.device,
    *,
    require_diff: bool = True,
) -> torch.Tensor:
    """Build (1,C,H,W) tensor. C=3 when diff is provided, else C=2."""
    if diff is None:
        if require_diff:
            raise ValueError("Image_Diff is required for this model (in_channels=3)")
        x = np.asarray(flow, dtype=np.float32)
    else:
        x = concat_flow_diff(flow, diff)
    return torch.from_numpy(x).permute(2, 0, 1).unsqueeze(0).float().to(device)
