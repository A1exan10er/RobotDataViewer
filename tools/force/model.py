"""Pinned primary reference model and preprocessing, independent of heatmaps."""
from pathlib import Path
import hashlib
import importlib.util
import io
import zipfile

ROOT = Path(__file__).resolve().parents[2]
REFERENCE = ROOT / 'tools/reference/force-inference'
ARCHIVE = REFERENCE / 'NEW_sensor_inference_360.zip'
MODEL_ID = 'PSP_deep_flow_diff_shear_valloss_0.6344'
PIPELINE = 'deepflow-035-clahe-relative-diff-2dp-first-frame-v1'


def load_torch():
    import torch
    arch = REFERENCE / 'upstream' / MODEL_ID / 'multitask_pspnet.py'
    spec = importlib.util.spec_from_file_location('rdv_force_arch', arch)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    model = module.MultiTaskPSPNet(in_channels=3, num_classes=2, pretrained_backbone=False, num_force_outputs=2)
    with zipfile.ZipFile(ARCHIVE) as z:
        raw = z.read('NEW_sensor_inference_360/' + MODEL_ID + '/PSP_deep_flow_diff_shear.pt')
    weights = torch.load(io.BytesIO(raw), map_location='cpu', weights_only=True)
    model.load_state_dict(weights.get('state_dict', weights))
    model.eval()
    return model, hashlib.sha256(raw).hexdigest()


class Preprocessor:
    def __init__(self, reference_bgr):
        import cv2
        self.cv = cv2
        self.clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        self.algo = cv2.optflow.createOptFlow_DeepFlow()
        self.reference = self.gray(reference_bgr)
        self.small_reference = self.small(self.reference)

    def gray(self, bgr):
        if bgr.shape[:2] != (360, 640):
            bgr = self.cv.resize(bgr, (640, 360))
        return self.cv.cvtColor(bgr, self.cv.COLOR_BGR2GRAY)

    def small(self, gray):
        return self.cv.resize(self.clahe.apply(gray), (224, 126), interpolation=self.cv.INTER_AREA)

    def __call__(self, bgr):
        return self.from_gray(self.gray(bgr))

    def from_gray(self, current):
        import numpy as np
        small_flow = self.algo.calc(self.small_reference, self.small(current), None)
        flow = self.cv.resize(small_flow, (640, 360), interpolation=self.cv.INTER_LINEAR).astype(np.float32) * (1.0 / 0.35)
        reference = self.reference.astype(np.float32)
        diff = np.round((current.astype(np.float32) - reference) / np.maximum(reference, 1.0), 2).astype(np.float32)
        return np.concatenate([flow, diff[..., None]], axis=-1).transpose(2, 0, 1)[None].copy()


def forces(normalized, contact_score):
    """Reference initial baseline_norm is zero; no implicit tare or adaptation."""
    if contact_score < 0.1:
        return 0.0, 0.0
    return max(0.0, float(normalized[0]) * 2.6), max(0.0, float(normalized[1]) * 5.7)
