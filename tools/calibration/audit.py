"""Read-only structural checks for the supplied UMI/Ego calibration bundle.

Run with the existing native Python dependencies (NumPy and OpenCV). The report
does not certify physical accuracy: no observations or valid lens ROI are given.
"""
import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np


def read_matrix_file(path, keys):
    storage = cv2.FileStorage(str(path), cv2.FILE_STORAGE_READ)
    try:
        if not storage.isOpened():
            raise ValueError(f"Cannot open {path.name}")
        return {key: storage.getNode(key).mat() for key in keys}
    finally:
        storage.release()


def camera_audit(matrix, distortion, size):
    matrix = np.asarray(matrix, dtype=np.float64)
    distortion = np.asarray(distortion, dtype=np.float64).reshape(4, 1)
    if matrix.shape != (3, 3) or not np.isfinite(matrix).all() or not np.isfinite(distortion).all():
        raise ValueError("Invalid camera matrix or distortion")
    if matrix[0, 0] <= 0 or matrix[1, 1] <= 0:
        raise ValueError("Focal lengths must be positive")
    width, height = map(int, size)
    if width < 2 or height < 2:
        raise ValueError("Invalid image dimensions")
    # OpenCV fisheye's theta = atan(r) forward-facing model domain.
    theta = np.linspace(0, np.pi / 2, 10001)
    coefficients = distortion.reshape(-1)
    derivative = 1 + sum((2 * i + 3) * k * theta ** (2 * i + 2)
                         for i, k in enumerate(coefficients))
    radius = theta * (1 + sum(k * theta ** (2 * i + 2)
                              for i, k in enumerate(coefficients)))
    nonmonotonic = np.flatnonzero(derivative <= 0)
    probes = np.array([
        [0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1],
        [0, height / 2], [width - 1, height / 2],
        [width / 2, 0], [width / 2, height - 1],
        [matrix[0, 2], matrix[1, 2]],
    ], dtype=np.float64).reshape(-1, 1, 2)
    undistorted = cv2.fisheye.undistortPoints(probes, matrix, distortion)
    # Failure sentinel is finite: isfinite alone incorrectly accepts -1e6.
    failed = (~np.isfinite(undistorted).all(axis=(1, 2)) |
              (np.abs(undistorted) >= 999999).any(axis=(1, 2)))
    errors = [None] * len(probes)
    if (~failed).any():
        restored = cv2.fisheye.distortPoints(undistorted[~failed], matrix, distortion)
        for index, error in zip(np.flatnonzero(~failed),
                                np.linalg.norm((restored - probes[~failed]).reshape(-1, 2), axis=1)):
            errors[int(index)] = float(error) if np.isfinite(error) else None
    return {
        "imageSize": [width, height],
        "principalPoint": [float(matrix[0, 2]), float(matrix[1, 2])],
        "firstNonmonotonicAngleDegrees": (
            float(np.degrees(theta[nonmonotonic[0]])) if len(nonmonotonic) else None
        ),
        "maximumDistortedRadiusWithin90Degrees": float(radius.max()),
        "inverseFailureCount": int(failed.sum()),
        "probes": [
            {"pixel": point.reshape(2).tolist(), "inverseFailed": bool(bad),
             "roundTripErrorPx": error}
            for point, bad, error in zip(probes, failed, errors)
        ],
        "interpretation": (
            "Boundary probes are a domain stress test, not calibration observations. "
            "The valid lens ROI, original images, and independent measurements are "
            "required before accepting or rejecting physical accuracy."
        ),
    }


def audit(root):
    root = Path(root)
    umi_path = root / "UMI_Camera_Parameters/intrinsics_LRCP.yaml"
    ego_path = root / "Ego_Camera_Parameters/2uq2_parameters.json"
    ego_yaml = root / "Ego_Camera_Parameters/2uq2_parameters.yaml"
    umi = read_matrix_file(umi_path, ("camera_matrix", "distortion", "image_size"))
    ego = json.loads(ego_path.read_text())
    keys = ("left_camera_matrix", "right_camera_matrix", "left_distortion",
            "right_distortion", "rotation_right_from_left",
            "translation_right_from_left_m")
    yaml_values = read_matrix_file(ego_yaml, keys)
    rotation = np.asarray(ego["rotation_right_from_left"])
    translation = np.asarray(ego["translation_right_from_left_m"])
    return {
        "format": "rdv-calibration-audit",
        "version": 1,
        "opencv": cv2.__version__,
        "sourceChecksums": {
            str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in (umi_path, ego_path, ego_yaml)
        },
        "physicalAccuracyVerified": False,
        "egoUmiTransformAvailable": False,
        "egoStereo": {
            "rotationDeterminant": float(np.linalg.det(rotation)),
            "rotationOrthogonalityMaxError": float(np.abs(rotation.T @ rotation - np.eye(3)).max()),
            "baselineMillimeters": float(np.linalg.norm(translation) * 1000),
            "baselineDeclarationErrorMeters": float(abs(np.linalg.norm(translation) - ego["baseline_m"])),
            "yamlJsonMaxDifferences": {
                key: float(np.max(np.abs(yaml_values[key].reshape(-1) - np.asarray(ego[key]).reshape(-1))))
                for key in keys
            },
            "reportedStereoRmsPx": ego["stereo_rms_px"],
            "reportedHeldOutRmsPx": ego["held_out_right_prediction_rms_px"],
        },
        "cameras": {
            "umi": camera_audit(umi["camera_matrix"], umi["distortion"], umi["image_size"].reshape(-1)),
            "egoLeft": camera_audit(ego["left_camera_matrix"], ego["left_distortion"], ego["image_size"]),
            "egoRight": camera_audit(ego["right_camera_matrix"], ego["right_distortion"], ego["image_size"]),
        },
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="Camera_Parameters_Documents directory")
    arguments = parser.parse_args()
    print(json.dumps(audit(arguments.directory), ensure_ascii=False, indent=2, allow_nan=False))
