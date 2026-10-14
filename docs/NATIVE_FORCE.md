# Portable launcher and native force engine

Extract the complete platform ZIP, then double-click `Start Viewer.cmd` on
Windows or `Start Viewer.command` on macOS. On Linux, right-click
`Start Viewer.sh` and choose **Run as a Program** (some file managers also run it
on double-click).
The start files locate the bundled runtime beside them, so the whole folder can
be moved or renamed without editing paths or installing a shortcut. On Linux,
enable **Allow executing file as program** in file properties if required. The underlying
`RobotDataViewer` executable (`.exe` on Windows) remains available.
Keep the launcher open while viewing; close the browser tab and press Ctrl+C
in the launcher when finished.
It opens a random **127.0.0.1** port in your browser. Python, OpenCV, ONNX Runtime
and a minimal FFmpeg decoder are bundled. No installation or network is needed.
The HTML-only package remains available; it calculates forces in the browser.

Force display is off initially. Turning it on pauses playback and calculates all
frames of the selected episode. Completion leaves playback paused. Estimates
remain independent of heatmap gain, masks and gamma. No frame skipping,
quantization or lower-resolution neural inference is used.

The native launcher keeps completed results in a 256 MiB disk LRU, in addition
to the viewer's 32 MiB memory cache. Only compact force tracks are retained;
uploaded videos and partial results are removed. Matching includes the video
SHA-256, sensor, dimensions, frame count, timestamps, reference and model versions.
Existing version-1 `.rdv-force.json` files still import/export unchanged.
Use **Remove saved results for this episode** or **Clear all saved force results**
to delete them. Deletion switches force off and does not recalculate.

Cache locations:
- Linux: `$XDG_CACHE_HOME/RobotDataViewer/force-v1`, default `~/.cache/...`.
- Windows: `%LOCALAPPDATA%/RobotDataViewer/force-v1`.
- macOS: `~/Library/Caches/RobotDataViewer/force-v1`.

Use **Save preparation diagnostics** after calculation to save backend and timing details.
If the helper fails, **Retry with browser calculation** retains the slower HTML fallback.

The helper accepts only authenticated, same-origin loopback requests. Its launch
token stays in the browser session. It exposes no file-path read/write API.
Videos are uploaded in 4 MiB chunks, written incrementally, and checksum checked.
Cancellation stops the owned engine/decoder processes. Abandoned temporary launch
directories are cleaned at the next launch. Do not share the launch URL/token.

## Acceleration and diagnostics

One model session processes sensors in order. Up to two preprocessing tasks
prepare frames ahead; at most three frames are queued. Inference uses up to eight
threads within the physical-core budget (reserving CPU for preprocessing/decode).
OpenCV and FFmpeg each use one thread. Exact processed-image matches reuse prior
estimates, including the model's **nonzero** reference-frame estimate.

CPU and each candidate GPU provider run all eight bundled synthetic probes.
Original decoded-recording oracles are validated separately and are never packaged.
Candidates must retain contact decisions and meet `0.001 N + 0.1%` force tolerance,
and be faster than CPU. Jobs whose measured CPU estimate is below five seconds
avoid GPU startup overhead. Otherwise CPU is selected with a diagnostic reason.
Windows uses DirectML; macOS can use CoreML; Linux/Windows can use the separate
NVIDIA add-on. CUDA TF32 and CoreML low-precision accumulation are disabled.
Install the matching NVIDIA add-on as `nvidia/` beside the base executable.
A compatible NVIDIA driver is required; the add-on supplies the runtime libraries.

The graph preserves original operations except the final force-head enlargement
before spatial averaging and the order of the segmentation pointwise projection
and final enlargement. Sigmoid remains after enlargement, followed by the
original output-size interpolation. Export validation compares against the
unchanged supplied PyTorch model, separately from provider validation.

`tools/native/benchmark.py` measures cold wall time and owned process-tree RSS.
Engine diagnostics separately report initialization, decode, preprocessing,
inference (including runtime-managed device copies), upload time, backend, fallback reasons and provider checks. Summed
preprocessing CPU task durations overlap inference and are not wall-clock totals.
Physical sensor accuracy still requires measured-force calibration data.

## Reproducible native builds

Build on the target platform; PyInstaller does not cross-compile. Use Python 3.10
or 3.11 and Node 22. Linux base requires glibc 2.35 or newer when built on Ubuntu
22.04. macOS and Windows builds must be tested on their actual target architecture.

```
python -m venv .venv
# Activate .venv using the platform's normal activation command.
python -m pip install -r tools/native/requirements.txt
npm ci
npm test
npm run test:python
npm run build
python tools/release.py
python tools/native/build-ffmpeg.py
python tools/native/build.py
```

If rebuilding from the package's source archive, first restore binary build
inputs with `python tools/force/unpack-runtime.py /path/to/force-runtime.js`.
Decoder build inputs are supplied under `sources/`; follow `vendor/BUILD.md`
for rebuilding that component.

FFmpeg is built from the already supplied `sources/ffmpeg-8.1.tar.xz`, with only
local input and the required native video decoders; no GPL or external codec
libraries are enabled. Linux/macOS need make and a C compiler **only on the build
host**; Windows builds use MSYS2 MinGW64. Each package includes FFmpeg source,
configure flags/checksum, dependency versions, notices and application source.
To rebuild the model, use the force export instructions in `vendor/BUILD.md`;
PyTorch and the original model archive are build inputs, not portable runtimes.

NVIDIA build: create a separate environment and install
`tools/native/requirements-nvidia.txt` instead of the CPU/DirectML requirements.
This pins the tested CUDA 12/cuDNN 9 runtime packages as well as ORT. Run
`python tools/native/build.py --nvidia` on Windows/Linux x64. Never mix ORT wheels
in the same environment. GPU packages are large; they are intentionally separate.
See `docs/VALIDATION.md` for actual tested platforms, measurements and limitations.
