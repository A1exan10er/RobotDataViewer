# Live camera inspection / 实时相机检查

Live cameras is a separate mode for checking USB/UVC cameras before recording.
It shows browser-accessible camera images locally, without audio, recording,
uploads, a vendor SDK, or a synchronized recording timeline. The target setup is
up to eight cameras on Windows Chrome/Edge or Linux Chrome. Headcam-specific
profiles and live force estimates are outside this mode.

## Start and identify cameras

Open the extracted `viewer.html` in Chrome/Edge, or use the existing native
localhost launcher. Choose **Live cameras → Start all**, then allow camera access.
An ordinary remote HTTP page cannot access cameras; use local files, localhost,
or HTTPS. If a browser blocks camera access from a local file, use the localhost
launcher. System camera privacy settings and other applications can also prevent
access. The application never requests microphone access.

Newly attached cameras start while automatic capture is active. **Stop all**
disables this behavior. An individual **Stop** is retained through refresh and
reconnection; use that card's **Start** to enable it again. **Refresh devices**
rescans without restarting unchanged streams. Disconnects remain visible.

Assign each camera its profile:

- **Wrist / environment:** 640 × 480 at 30 Hz.
- **Tactile:** 640 × 360 at 30 Hz.
- **Unassigned:** the device's default capture mode, useful for inspecting an
  unfamiliar camera or recovering from an unsupported profile.

Profiles request exact dimensions and frame rate. Software crop/resize is
prohibited when the browser supports that constraint. The card reports actual
capture settings and flags disagreement. Unsupported profiles show an error;
other cameras keep working. The browser may not expose USB serial numbers or
pixel formats. Identical camera names remain separate devices. Role memory uses
browser device IDs, not names, and may reset after permission changes, browser
storage clearing, or a changed localhost port. Storage is optional.

## Inspect raw images and stream health

Expand a card to inspect the full image. Raw previews retain their aspect ratio
and are neither mirrored nor masked. Look for lighting, focus, lens/surface, or
image defects yourself; status indicators are not a hardware pass/fail test.

**Actual capture** reports negotiated dimensions and configured frame rate.
**Displayed FPS** measures compositor presentation, not sensor acquisition. No
new frames for two seconds produces a stale-image overlay. Displayed FPS below
24 for five seconds after startup produces a warning. These conditions can come
from USB bandwidth/power, other applications, or computer/browser load. No device
synchronization or USB-throughput guarantee is implied. If metrics are not
supported, the card says so. Hidden-page health judgments pause.

## Calibrate tactile response

The raw tactile image always remains visible beside the response map. Remove
contact, keep the sensor still, and click **Calibrate**. The viewer collects 60
distinct observed frames (about two seconds at 30 Hz) and fits the existing sensing
region. Two cameras can calibrate at once; others wait. Collection fails after
ten seconds if insufficient new frames arrive. Cancel or retry without stopping
other previews. A missing region hides only the heatmap.

The median reference, noise suppression, sensing-region mask, Inferno palette,
10× default gain (1–16×), and **Show all changes** match the recorded-data viewer.
Colors indicate relative image response, not force or pressure. The reference
never adapts automatically. **Recalibrate** deliberately replaces it. Restart,
reconnection, profile changes, or leaving live mode invalidate it. No neighboring
recording is used to repair a live region. Use the same supported sensor geometry.

Response processing runs in workers with only one frame in flight per camera;
old processing work is not queued ahead of the live image. Response age is shown
separately, with a warning above two seconds. Raw previews continue if response
processing is slow or fails. Raw and processed images are not guaranteed to
represent the same instantaneous frame.

Switching to Live cameras pauses recorded playback and cancels force preparation.
Returning preserves the selected source and time. Leaving Live cameras or closing
the page releases capture tracks and tactile workers.

## 实时相机操作

选择“实时相机 → 全部启动”，在浏览器与系统中允许相机权限。选择腕部/环境
（640×480，30 Hz）或触觉（640×360，30 Hz）类型。未知设备可先使用默认规格。
界面显示实际采集规格、显示帧率与最近一帧时间；规格不支持时显示错误，不影响
其他相机。相同名称的设备会分别显示。新接入的相机在自动启动开启时开始预览；
“全部停止”会关闭自动启动，单独停止的设备需在对应面板重新启动。

原始图像不裁剪、不遮罩。触觉相机需先移除接触、保持静止，再点击“标定”。
60 个观测帧建立固定基线，同时最多标定两台，10 秒内不足帧数则提示重试。
感知区域未找到时只隐藏响应图，原始图像继续显示。可手动重新标定；断开、
重启或更换类型后需重新标定。颜色是相对图像响应，并非实测力或压力。

显示帧率不是传感器采集帧率。停帧、低帧率可能来自 USB 带宽、供电、系统负载
或其他占用相机的软件。状态提示不等于硬件质量结论，仍需人工检查图像。
数据仅在本机处理，不请求音频，不保存或上传相机画面。

## Validation and release gate

1.5.0-rc.1 is a release candidate. One physical tactile camera has been tested on
Linux Chrome: both profiles, calibration, contact response and release, physical
unplug/replug with automatic recovery, recalibration, and sustained preview.
Synthetic tests cover one, four, and eight streams; they do not verify a physical
eight-camera USB topology or Windows drivers. Stable 1.5.0 requires a physical mixed-camera
acceptance run on Windows Chrome/Edge and Linux Chrome, including eight cameras,
profile negotiation, unplug/replug, sustained viewing, and tactile calibration.
Keep the stable 1.4.0 download until that acceptance is complete.

Development check: build, then run `npm run test:live`. The harness creates a
separate loopback-only fixture and isolated Chrome profile; it never uses the
user's browser profile or physical cameras. Set `ROBOT_VIEWER_CHROME` if Chrome
is installed at a different path. Fixture scripts are not injected into the
production viewer. See `VALIDATION.md` for completed checks and limitations.

For an explicitly authorized physical-camera test, run
`node tools/browser-camera-hardware.mjs --hardware`. Add `--operator` for contact
and unplug/replug checks; press Enter in the terminal after the contact step.
This test uses a fresh Chrome profile, automatically grants camera permission
for its localhost page, and saves diagnostic screenshots only under ignored
`artifacts/live-camera-hardware/`. It is never part of CI. Set `ROBOT_VIEWER_WEB`
to an extracted package folder or `ROBOT_VIEWER_URL` to the local launcher URL.

API references: [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
and [video frame callbacks](https://wicg.github.io/video-rvfc/).
