"""摄像头实时推理：DeepFlow 光流 + Image_Diff → PSP 分割 + 合力 (shear, fz)。

模型: PSP_deep_flow_diff_shear_valloss_0.6344（输入 3 通道 [u, v, diff]）

python main_new.py
python main_new.py --camera /dev/video0
python main_new.py --model-dir PSP_deep_flow_diff_shear_valloss_0.6344
"""
from __future__ import annotations

import argparse
import os
import time

import cv2
import numpy as np

from force_model import DEFAULT_MODEL_DIR, ForceNet, load_model_config
from image_diff import (
    build_model_input_tensor,
    compute_offset_diff,
    compute_relative_diff,
    diff_to_vis,
    make_diff_click_callback,
)
from main import (
    BATCH_FLOW_YAML,
    CAPTURE_FPS,
    DEFAULT_CAMERA,
    FLOW_SIZE,
    IS_WINDOWS,
    CaptureThread,
    compute_batch_flow,
    create_flow_algo_from_settings,
    draw_flow_on_image,
    draw_force_plot,
    list_camera_devices,
    load_batch_flow_settings,
    normalize_fixed_scale,
    open_camera,
    resize_to_flow,
    setup_cv2_qt_fonts,
)

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def prepare_frame(frame, flip_horizontal=False):
    if flip_horizontal:
        frame = cv2.flip(frame, 1)
    return resize_to_flow(frame)


def draw_force_overlay(seg_probs, force_phys, seg_threshold, use_shear_magnitude=True, width=640):
    """用分割概率做背景，叠加合力文字。"""
    seg_fz = seg_probs[:, :, 0]
    vis = cv2.applyColorMap(normalize_fixed_scale(seg_fz, max_val=1.0), cv2.COLORMAP_JET)
    mask = seg_fz >= seg_threshold
    vis[~mask] = (vis[~mask] * 0.3).astype(np.uint8)

    if use_shear_magnitude:
        lines = [f"Shear: {force_phys[0]:.4f}", f"Fz: {force_phys[1]:.4f}"]
    else:
        lines = [
            f"Fx: {force_phys[0]:.4f}",
            f"Fy: {force_phys[1]:.4f}",
            f"Fz: {force_phys[2]:.4f}",
        ]
    for i, text in enumerate(lines):
        cv2.putText(
            vis, text, (10, 30 + i * 28),
            cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2, cv2.LINE_AA,
        )
    return vis


def reset_baseline(net: ForceNet, bg_bgr_ref, baseline_norm, corrected, input_tensor):
    import torch

    bg_bgr_ref[0] = corrected.copy()
    with torch.inference_mode():
        _, force_out = net(torch.zeros_like(input_tensor))
    baseline_norm[:] = force_out[0].float().cpu().numpy()


def process_frame(
    frame, algo, net, bg_bgr, flow_settings, device,
    left_region, right_region,
    seg_threshold, baseline_norm,
    force_hists,
    flip_horizontal=False,
):
    corrected = prepare_frame(frame, flip_horizontal)
    flow, flow_bgr, gray = compute_batch_flow(bg_bgr, corrected, algo, flow_settings)
    if net.use_new_diff:
        diff = compute_offset_diff(
            bg_bgr, corrected, offset=net.diff_offset, diff_scale=net.diff_scale,
        )
    else:
        diff = compute_relative_diff(bg_bgr, corrected)
    input_tensor = build_model_input_tensor(
        flow, diff, device, require_diff=net.uses_image_diff,
    )

    force_phys, seg_probs, _ = net.predict_force_phys(input_tensor, baseline_norm)

    seg_fz = seg_probs[:, :, 0]
    seg_shear = seg_probs[:, :, 1]
    active = (
        ((seg_fz >= seg_threshold) | (seg_shear >= seg_threshold))
        & (left_region | right_region)
    )
    if not np.any(active):
        force_phys = np.zeros(net.num_force_outputs, dtype=np.float32)

    for i, hist in enumerate(force_hists):
        hist = np.roll(hist, -1)
        hist[-1] = float(force_phys[i])
        force_hists[i] = hist

    overlay = draw_force_overlay(
        seg_probs, force_phys, seg_threshold,
        use_shear_magnitude=net.use_shear_magnitude,
        width=FLOW_SIZE[0],
    )
    flow_vis = draw_flow_on_image(
        flow_bgr.copy(), flow,
        step=flow_settings["arrow_step"],
        arrow_scale=flow_settings["arrow_scale"],
    )
    diff_vis = diff_to_vis(diff)

    return {
        "corrected": corrected,
        "overlay": overlay,
        "flow_vis": flow_vis,
        "diff_vis": diff_vis,
        "force_hists": force_hists,
        "gray": gray,
        "input_tensor": input_tensor,
        "flow_bgr": flow_bgr,
        "force_phys": force_phys,
        "diff": diff,
    }


def main():
    p = argparse.ArgumentParser(description="触觉传感器实时推理（DeepFlow + Image_Diff + shear/fz）")
    p.add_argument("--camera", default=DEFAULT_CAMERA)
    p.add_argument("--fps", type=int, default=CAPTURE_FPS)
    p.add_argument("--flow-config", default=BATCH_FLOW_YAML)
    p.add_argument("--flip-horizontal", action="store_true")
    p.add_argument("--lite", action="store_true", help="仅显示 Overlay")
    p.add_argument("--cpu", action="store_true")
    p.add_argument("--list-cameras", action="store_true")
    p.add_argument("--model-dir", default=DEFAULT_MODEL_DIR)
    args = p.parse_args()

    if args.list_cameras:
        devices = list_camera_devices()
        if not devices:
            print("未发现可用摄像头")
        else:
            for item in devices:
                name = f"  ({item['name']})" if item.get("name") else ""
                print(f"  {item['device']}{name}  {item['width']}x{item['height']}")
        return

    model_dir = os.path.abspath(args.model_dir)
    cfg = load_model_config(model_dir)
    seg_threshold = 0.1

    setup_cv2_qt_fonts()
    cv2.setUseOptimized(True)

    import torch

    device = torch.device("cpu" if args.cpu or not torch.cuda.is_available() else "cuda")
    flow_settings = load_batch_flow_settings(args.flow_config)
    algo = create_flow_algo_from_settings(flow_settings)
    rw, rh = FLOW_SIZE
    if flow_settings.get("flow_algo") == "deepflow":
        print(
            f"光流: DeepFlow | scale={flow_settings['deepflow_scale']} | "
            f"clahe={flow_settings['use_clahe']} | blur={flow_settings['blur_ksize']} | {rw}x{rh}"
        )
    else:
        print(
            f"光流: DIS/{flow_settings['dis_style']} | blur={flow_settings['blur_ksize']} | "
            f"{rw}x{rh}"
        )

    net = ForceNet(device, model_dir=model_dir)
    print(
        f"模型: {os.path.basename(model_dir)} | in_channels={cfg['in_channels']} | "
        f"input={'flow+diff' if cfg.get('uses_image_diff') else 'flow'}"
    )
    if cfg["use_shear_magnitude"]:
        print(f"归一化: shear_max={cfg['shear_max']} fz_max={cfg['fz_max']}")
        plot_names = ("Shear", "Fz")
    else:
        print(
            f"归一化: fx_max={cfg['fx_max']} fy_max={cfg['fy_max']} fz_max={cfg['fz_max']}"
        )
        plot_names = ("Fx", "Fy", "Fz")

    cap, bg_frame, cap_w, cap_h = open_camera(args.camera, rw, rh, args.fps)
    if cap is None:
        return

    grabber = CaptureThread(cap, drain=2 if IS_WINDOWS else 1)
    print(f"输入: 摄像头 {cap_w}x{cap_h} → {rw}x{rh}")

    bg_corrected = prepare_frame(bg_frame, args.flip_horizontal)
    bg_bgr_ref = [bg_corrected]
    height, width = FLOW_SIZE[1], FLOW_SIZE[0]

    left_region = np.zeros((height, width), dtype=bool)
    left_region[:, :width // 2] = True
    right_region = ~left_region

    baseline_norm = net.zero_baseline()
    force_hists = [np.zeros(100) for _ in range(net.num_force_outputs)]
    resized_title = f"1. Resized ({width}x{height})"
    windows = ["4. Overlay: Seg + Force"] if args.lite else [
        "0. Camera Raw", resized_title, "2. Optical Flow", "3. Image Diff",
        "4. Overlay: Seg + Force", "5. Force Plot",
    ]
    last_result = None
    diff_click_state = {"diff": None}

    for name in windows:
        cv2.namedWindow(name, cv2.WINDOW_NORMAL)
    if not args.lite:
        cv2.setMouseCallback(
            "3. Image Diff",
            make_diff_click_callback(diff_click_state, "3. Image Diff"),
        )
        print("提示: 在「3. Image Diff」窗口左键点击可查看该点真实 diff 值")

    dev_name = torch.cuda.get_device_name(device) if device.type == "cuda" else "cpu"
    print(f"推理: {dev_name} | 按 q 退出, r 校零")

    last_seq = -1
    loop_fps = 0.0
    loop_count = 0
    loop_t0 = time.perf_counter()
    cam_fps = 0.0

    try:
        while True:
            ret, frame, last_seq, cam_fps = grabber.read(last_seq)
            if not ret or frame is None:
                key = cv2.waitKey(1) & 0xFF
                if key in (ord("q"), 27):
                    break
                continue

            result = process_frame(
                frame, algo, net, bg_bgr_ref[0], flow_settings, device,
                left_region, right_region,
                seg_threshold, baseline_norm,
                force_hists,
                flip_horizontal=args.flip_horizontal,
            )
            force_hists = result["force_hists"]
            last_result = result
            diff_click_state["diff"] = result["diff"]
            loop_count += 1

            now = time.perf_counter()
            if now - loop_t0 >= 1.0:
                loop_fps = loop_count / max(now - loop_t0, 1e-6)
                loop_count = 0
                loop_t0 = now

            stats = f"cam {cam_fps:.0f} | loop {loop_fps:.0f} fps"

            if args.lite:
                overlay = result["overlay"].copy()
                cv2.putText(overlay, stats, (10, overlay.shape[0] - 12),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
                cv2.imshow("4. Overlay: Seg + Force", overlay)
            else:
                raw = frame.copy()
                cv2.putText(raw, stats, (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
                cv2.imshow("0. Camera Raw", raw)
                cv2.imshow(resized_title, result["corrected"])
                cv2.imshow("2. Optical Flow", result["flow_vis"])
                cv2.imshow("3. Image Diff", result["diff_vis"])
                cv2.imshow("4. Overlay: Seg + Force", result["overlay"])
                cv2.imshow("5. Force Plot", draw_force_plot(*force_hists, names=plot_names))

            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                break
            if key == ord("r") and last_result is not None:
                reset_baseline(
                    net, bg_bgr_ref, baseline_norm,
                    last_result["corrected"], last_result["input_tensor"],
                )
                for hist in force_hists:
                    hist.fill(0)
                print(">>> 背景已重置，并完成模型基准校零 (Tare)。")
    finally:
        grabber.stop()
        cap.release()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
