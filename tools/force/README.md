# Force preparation and browser builds

Force is optional and disabled initially. Preparing it processes every tactile
video frame in the selected episode while playback is paused. Ready tracks are
small, reusable and exportable; recipients need no model execution when tracks
are supplied. No file is uploaded or changed.

## Prepare on an authoring machine

Install Python 3.10+, FFmpeg (including ffprobe), and the pinned dependencies in
`requirements.txt` in a virtual environment. The repository includes the ONNX
model in `vendor/force/`. Then run:

```sh
python tools/force/prepare.py /path/to/folder-or-recording.tar \
  --output /path/to/force-estimates.rdv-force.json
```

Use `--episode episode_0157_` to restrict a collection and `--sensor r_tact_l`
to select one sensor. Output paths must be new. Input TAR members are streamed
to a private temporary video file, never extracted using archive paths. Each
track must contain the complete decoded frame count; a failed sensor does not
produce a partial track. Failures are reported and return a nonzero exit status.

Choose **Import force tracks** in the viewer, or put the resulting
`*.rdv-force.json` file beside a recording in its folder/TAR. Tracks are matched
by the video SHA-256, sensor, dimensions, frame count, timestamps and model
version. The viewer maps source-frame times through the existing capture-time
alignment, including offsets. Imported estimates remain separate from measured
numeric channels. JSON version 1 stores Float32 force values in N, Float64 source
presentation times in seconds, and per-frame validity; frame zero is the fixed
reference. Recording formats are unchanged.

## Rebuild the model

Use torch 2.8.0, torchvision 0.23.0, onnx 1.19.0 and the pinned runtime
dependencies. `python tools/force/export-model.py` loads the selected checkpoint
with `weights_only=True`, exports fixed FP32 inputs `[1,3,360,640]`, checks
PyTorch/ONNX agreement, and writes checksums to `vendor/force/model.json`.
No ImageNet weights are fetched. Use extended graph optimization: layout
transformations introduced enough accumulation error to fail a combined
preprocessing/inference case at the agreed `0.001 N + 0.1%` tolerance.

## Rebuild DeepFlow

The build takes the original OpenCV DeepFlow implementation, replacing only its
private include with public headers. It compiles the required core/imgproc/video
libraries and a narrow C wrapper; it does not substitute DIS or Farneback.

Place these pinned checkouts under `artifacts/force-build/`:

- `opencv`: 4.12.0, commit `49486f61fb25722cbcf586b7f4320921d46fb38e`
- `opencv_contrib`: 4.12.0, commit `d943e1d61c8bc556a13783e1546ee7c1a9e0b1cf`
- `emsdk`: install and activate 4.0.15 locally

Run `python3 tools/force/build-deepflow.py`. Builds use two compiler jobs,
WebAssembly SIMD, bounded growing memory, and no pthread/SharedArrayBuffer
requirement. `--work /path/to/checkouts` changes the checkout directory.

`npm run build` creates the ordinary viewer and the separate, lazily loaded
`force-runtime.js`. This contains the model, OpenCV wrapper and ONNX Runtime
1.23.2 assets. All WASM/modules are loaded from local bytes/blob URLs. WebGPU is
used only when an adapter is available and its zero-input numerical check passes;
otherwise the same FP32 model runs on WASM. There are no CDN calls. A single
inference worker/session serves sensors sequentially and is terminated on
completion, cancellation or source changes.

The portable source archive avoids duplicating the model/WASM binary already
contained in `force-runtime.js`. After extracting the sources, restore those
inputs with `python3 tools/force/unpack-runtime.py /path/to/force-runtime.js`,
then use `npm ci && npm run build`. Re-exporting the model instead requires the
original supplied reference ZIP from the repository.

## Numerical checks

```sh
python tools/force/check-reference.py
node tools/force/check-numerics.mjs
python tools/force/check-force-values.py
```

Reference cases include synthetic unchanged, weak, shifted and odd-sized images
and available episode 0157 samples. Files stay under ignored `artifacts/`.
Native OpenCV SIMD and WASM iterative flow kernels can differ; force acceptance
is checked against the independent PyTorch output on identical decoded images,
with matching contact gates and tolerance `0.001 N + 0.1%`. Decoder color
differences are reported separately. These checks establish implementation
agreement, not sensor calibration accuracy.
