# -*- coding: utf-8 -*-
"""加载 PSP 多任务模型（分割 + 归一化合力：shear/fz 或 fx/fy/fz）。

默认模型: PSP_deep_flow_diff_shear（光流 2ch + Image_Diff 1ch）。
"""
from __future__ import annotations

import importlib.util
import os
from typing import Any, Dict, Tuple

import numpy as np
import torch
import yaml

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL_DIR = os.path.join(SCRIPT_DIR, "PSP_deep_flow_diff_shear_valloss_0.6344")


def _find_config_path(model_dir: str) -> str:
    preferred = (
        "psp_flow_diff.yaml",
        "psp_all.yaml",
    )
    for name in preferred:
        path = os.path.join(model_dir, name)
        if os.path.isfile(path):
            return path
    yamls = sorted(
        f for f in os.listdir(model_dir)
        if f.endswith((".yaml", ".yml"))
    )
    if not yamls:
        raise FileNotFoundError(f"No config yaml in {model_dir}")
    return os.path.join(model_dir, yamls[0])


def load_model_config(model_dir: str) -> Dict[str, Any]:
    config_path = _find_config_path(model_dir)
    with open(config_path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    data_cfg = cfg["data"]
    model_cfg = cfg.get("model", {})
    loss_cfg = cfg.get("Loss", {})
    use_shear = bool(loss_cfg.get("use_shear_magnitude", False))
    fx_max = float(data_cfg["fx_max"])
    fy_max = float(data_cfg["fy_max"])
    fz_max = float(data_cfg["fz_max"])
    if "shear_max" in data_cfg:
        shear_max = float(data_cfg["shear_max"])
    else:
        shear_max = float((fx_max ** 2 + fy_max ** 2) ** 0.5)
    in_channels = int(model_cfg.get("in_channels", 2))
    return {
        "config_path": config_path,
        "fx_max": fx_max,
        "fy_max": fy_max,
        "fz_max": fz_max,
        "shear_max": shear_max,
        "mask_threshold": float(data_cfg.get("mask_threshold", 1e-6)),
        "normalize": bool(data_cfg.get("normalize", True)),
        "pretrained_backbone": bool(model_cfg.get("pretrained_backbone", False)),
        "in_channels": in_channels,
        "num_classes": int(model_cfg.get("num_classes", 2)),
        "use_shear_magnitude": use_shear,
        # 与 train.py 一致：shear 模式为 (shear, fz)，否则 (fx, fy, fz)
        "num_force_outputs": 2 if use_shear else 3,
        "save_name": str(cfg.get("output", {}).get("save_name", "model")),
        "uses_image_diff": in_channels >= 3,
        "diff_stem_prefix": str(data_cfg.get("diff_stem_prefix", "Diff")),
        "diff_scale": (
            float(data_cfg["diff_scale"])
            if data_cfg.get("diff_scale") not in (None, "", 0, 0.0)
            else None
        ),
        "diff_offset": float(data_cfg.get("diff_offset", 127.0)),
    }


def _find_weights(model_dir: str, save_name: str) -> str:
    preferred = os.path.join(model_dir, f"{save_name}.pt")
    if os.path.isfile(preferred):
        return preferred
    pts = sorted(
        f for f in os.listdir(model_dir)
        if f.endswith(".pt")
    )
    if not pts:
        raise FileNotFoundError(f"No .pt weights in {model_dir}")
    return os.path.join(model_dir, pts[0])


def denorm_force(force_norm: np.ndarray, cfg: Dict[str, Any]) -> np.ndarray:
    """归一化输出 → 物理合力。shear 模式为 (2,) [shear, fz]，否则 (3,) [fx, fy, fz]。"""
    if not cfg["normalize"]:
        return force_norm
    if cfg.get("use_shear_magnitude"):
        scales = np.array([cfg["shear_max"], cfg["fz_max"]], dtype=np.float32)
    else:
        scales = np.array([cfg["fx_max"], cfg["fy_max"], cfg["fz_max"]], dtype=np.float32)
    if force_norm.ndim == 1:
        return force_norm * scales
    return force_norm * scales[:, None, None]


class ForceNet:
    """输出: seg_probs (B,2,H,W), force (B,2|3) 归一化合力 [shear,fz] 或 [fx,fy,fz]。"""

    def __init__(self, device: torch.device, model_dir: str = DEFAULT_MODEL_DIR):
        model_path = os.path.join(model_dir, "multitask_pspnet.py")
        spec = importlib.util.spec_from_file_location("multitask_pspnet_infer", model_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        self.device = device
        self.model_dir = model_dir
        self.cfg = load_model_config(model_dir)
        self.use_amp = device.type == "cuda"
        self.num_force_outputs = int(self.cfg["num_force_outputs"])
        self.use_shear_magnitude = bool(self.cfg["use_shear_magnitude"])
        self.in_channels = int(self.cfg["in_channels"])
        self.uses_image_diff = bool(self.cfg["uses_image_diff"])
        self.diff_scale = self.cfg.get("diff_scale")
        self.diff_offset = float(self.cfg.get("diff_offset", 127.0))
        self.use_new_diff = self.diff_scale is not None

        weights_path = _find_weights(model_dir, self.cfg["save_name"])
        self.model = module.MultiTaskPSPNet(
            in_channels=self.in_channels,
            num_classes=self.cfg["num_classes"],
            pretrained_backbone=self.cfg["pretrained_backbone"],
            num_force_outputs=self.num_force_outputs,
        ).to(device)

        try:
            weights = torch.load(weights_path, map_location=device, weights_only=False)
        except TypeError:
            weights = torch.load(weights_path, map_location=device)
        if isinstance(weights, dict) and "state_dict" in weights:
            weights = weights["state_dict"]
        self.model.load_state_dict(weights)
        self.model.eval()

    def zero_baseline(self) -> np.ndarray:
        return np.zeros(self.num_force_outputs, dtype=np.float32)

    def __call__(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        if x.shape[1] != self.in_channels:
            raise ValueError(
                f"Model expects in_channels={self.in_channels}, got tensor C={x.shape[1]}"
            )
        if self.use_amp:
            with torch.autocast(device_type="cuda", dtype=torch.float16):
                return self.model(x)
        return self.model(x)

    def predict_force_phys(
        self, input_tensor: torch.Tensor, baseline_norm: np.ndarray
    ) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        """返回物理合力、分割概率 (H,W,2)、归一化合力。"""
        with torch.inference_mode():
            seg_probs, force_norm = self(input_tensor)
        force_norm_np = force_norm[0].float().cpu().numpy() - baseline_norm
        force_phys = denorm_force(force_norm_np, self.cfg)
        if self.use_shear_magnitude:
            # [shear, fz]：两者均非负
            force_norm_np[0] = max(float(force_norm_np[0]), 0.0)
            force_phys[0] = max(float(force_phys[0]), 0.0)
            force_phys[1] = max(float(force_phys[1]), 0.0)
        else:
            force_phys[2] = max(float(force_phys[2]), 0.0)
        seg_np = seg_probs[0].float().cpu().numpy().transpose(1, 2, 0)
        return force_phys, seg_np, force_norm_np
