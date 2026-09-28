#!/usr/bin/env python3
"""Render a synchronized tactile stream as a denoised inferno difference view."""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--start", type=float, default=0.0)
    parser.add_argument("--end", type=float, default=None)
    parser.add_argument("--baseline-seconds", type=float, default=2.0)
    parser.add_argument("--gain", type=float, default=10.0)
    parser.add_argument("--gamma", type=float, default=0.7)
    return parser.parse_args()


def read_baseline(cap: cv2.VideoCapture, count: int) -> tuple[np.ndarray, np.ndarray]:
    frames: list[np.ndarray] = []
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    for _ in range(count):
        ok, frame = cap.read()
        if not ok:
            break
        frames.append(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
    if not frames:
        raise RuntimeError("could not read baseline frames")

    stack = np.stack(frames, axis=0)
    baseline = np.median(stack, axis=0).astype(np.uint8)
    deviations = np.abs(stack.astype(np.int16) - baseline.astype(np.int16))
    noise_floor = np.percentile(deviations, 99, axis=0).astype(np.float32)
    return baseline, noise_floor


def main() -> None:
    args = parse_args()
    cap = cv2.VideoCapture(str(args.input))
    if not cap.isOpened():
        raise RuntimeError(f"could not open {args.input}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    baseline_count = max(8, min(int(round(args.baseline_seconds * fps)), total_frames))
    baseline, noise_floor = read_baseline(cap, baseline_count)

    start_frame = max(0, int(round(args.start * fps)))
    end_frame = total_frames
    if args.end is not None:
        end_frame = min(total_frames, int(round(args.end * fps)))
    if end_frame <= start_frame:
        raise ValueError("end must be greater than start")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(
        str(args.output),
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (width, height),
    )
    if not writer.isOpened():
        raise RuntimeError(f"could not open output writer for {args.output}")

    gamma_lut = np.array(
        [pow(i / 255.0, args.gamma) * 255.0 for i in range(256)], dtype=np.uint8
    )
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    processed = 0
    for frame_index in range(start_frame, end_frame):
        ok, frame = cap.read()
        if not ok:
            break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        delta = cv2.absdiff(gray, baseline).astype(np.float32)
        cleaned = np.maximum(delta - noise_floor - 2.0, 0.0)
        cleaned = cv2.GaussianBlur(cleaned, (0, 0), sigmaX=2.0, sigmaY=2.0)
        amplified = np.clip(cleaned * args.gain, 0, 255).astype(np.uint8)
        amplified = cv2.LUT(amplified, gamma_lut)
        amplified[amplified < 10] = 0
        colored = cv2.applyColorMap(amplified, cv2.COLORMAP_INFERNO)
        colored[amplified == 0] = 0
        writer.write(colored)
        processed += 1
        if processed % 300 == 0:
            print(f"rendered {processed} frames")

    writer.release()
    cap.release()
    print(f"wrote {processed} frames at {fps:.3f} fps to {args.output}")


if __name__ == "__main__":
    main()

