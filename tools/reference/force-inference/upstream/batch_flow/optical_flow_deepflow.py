"""
DeepFlow 稠密光流（OpenCV contrib optflow）
逻辑对齐 /home/xinzhi/桌面/optiflow/main.py 中的 DeepFlow 分支。
"""

from __future__ import annotations

from typing import Optional, Tuple

import cv2
import numpy as np

_clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))


def preprocess_gray(gray: np.ndarray) -> np.ndarray:
    return _clahe.apply(gray)


def create_deepflow() -> cv2.DenseOpticalFlow:
    if not hasattr(cv2, "optflow"):
        raise RuntimeError(
            "DeepFlow 需要 opencv-contrib-python（当前 cv2 无 optflow 模块）"
        )
    return cv2.optflow.createOptFlow_DeepFlow()


def compute_deepflow(
    prev_gray: np.ndarray,
    curr_gray: np.ndarray,
    algo: Optional[cv2.DenseOpticalFlow] = None,
    *,
    scale: float = 0.35,
    use_clahe: bool = True,
) -> np.ndarray:
    """
    计算 DeepFlow，返回 (H, W, 2) float32。
    scale < 1 时先降采样加速（与 optiflow 默认 DEEPFLOW_SCALE=0.4 一致）。
    """
    if algo is None:
        algo = create_deepflow()

    prev_g = preprocess_gray(prev_gray) if use_clahe else prev_gray
    curr_g = preprocess_gray(curr_gray) if use_clahe else curr_gray

    if scale >= 0.999:
        return algo.calc(prev_g, curr_g, None).astype(np.float32)

    h, w = prev_g.shape
    sw = max(16, int(round(w * scale)))
    sh = max(16, int(round(h * scale)))
    prev_s = cv2.resize(prev_g, (sw, sh), interpolation=cv2.INTER_AREA)
    curr_s = cv2.resize(curr_g, (sw, sh), interpolation=cv2.INTER_AREA)
    flow_s = algo.calc(prev_s, curr_s, None)
    flow = cv2.resize(flow_s, (w, h), interpolation=cv2.INTER_LINEAR)
    flow = flow.astype(np.float32) * (1.0 / scale)
    return flow


def flow_to_polar_int16(flow: np.ndarray) -> np.ndarray:
    amp, angle = cv2.cartToPolar(flow[..., 0], flow[..., 1], angleInDegrees=False)
    return np.array([amp.astype(np.int16), angle.astype(np.int16)])
