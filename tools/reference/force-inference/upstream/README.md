# DeepFlow + Image_Diff Sensor Inference 360

基于 `PSP_deep_flow_diff_shear_valloss_0.6344` 的实时/离线推理。

模型输入：**3 通道** `[u, v, diff]`
- 光流：DeepFlow `(H,W,2)`
- 图像差：`(I1-I0)/max(I0,1)` 灰度相对差分 `(H,W)`（与训练 `Image_Diff` 一致）

模型输出：
- 分割：`2 × 360 × 640`（fz / shear mask 概率）
- 合力：`shear = sqrt(fx²+fy²)`, `fz`

## 模型目录

默认使用同目录下：

```
PSP_deep_flow_diff_shear_valloss_0.6344/
  multitask_pspnet.py
  PSP_deep_flow_diff_shear.pt
  psp_flow_diff.yaml
```

归一化参数（`psp_flow_diff.yaml`）：
- `in_channels: 3`
- `shear_max: 2.6`
- `fz_max: 5.7`
- `use_shear_magnitude: true`

## 实时推理

实时会同时算 DeepFlow 与 Image_Diff，再 concat 送入模型。

**无矫正**（摄像头直接 640×360）：

```bash
cd deep_diff_flow_sensor_inference_360
conda activate pressure
python main_new.py
python main_new.py --camera /dev/video0
```

**带鸟瞰矫正**（1280×720 → 矫正 → 640×360）：

```bash
python main.py
```

按键：
- `q` / `Esc` 退出
- `r` 背景重置 + 校零

## 离线推理

需要同时提供光流与 Image_Diff：

```bash
python infer_flow.py /path/to/deep_flow_OpticalFlow_xxx.npz \
  --diff /path/to/Diff_xxx.npz
python infer_flow.py flow.npz --diff Diff.npz --output result.json
```

输出示例：

```json
{
  "force_phys": {"shear": 0.85, "fz": 1.92},
  "in_channels": 3,
  "use_shear_magnitude": true
}
```

## 指定其他模型目录

```bash
python main_new.py --model-dir /path/to/PSP_deep_flow_diff_shear_valloss_0.6344
```
