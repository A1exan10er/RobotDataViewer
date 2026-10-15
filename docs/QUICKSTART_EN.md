# Robot Data Viewer

For recordings and live USB cameras, choose an attached desktop ZIP for your operating system from the [GitHub release](https://github.com/A1exan10er/RobotDataViewer/releases/tag/v1.5.0-rc.3) or [Gitea release](https://git.neoteai.com/yangtianyu/RobotDataViewer/releases/tag/v1.5.0-rc.3): `windows-x64`, `linux-x64`, `macos-x64` (Intel), or `macos-arm64` (Apple Silicon). Desktop packages include their runtime; recipients need only a desktop browser. No Python, Node.js, installation, server configuration, or internet connection is required after downloading. All four desktop packages are attached on both hosts and were downloaded again with matching checksums. This remains a pre-release; see the release validation notes.

1. **Extract the entire ZIP** to a folder on your computer.
2. **Start the viewer:** Windows — double-click **Start Viewer.cmd**; Linux — open **RobotDataViewer**, or right-click **Start Viewer.sh → Run as a Program**; macOS — double-click **Start Viewer.command**. Your default browser opens automatically. If it does not, copy the local URL displayed in the launcher window into Chrome, Edge or Firefox.
3. Keep the launcher window open. Choose **Recordings** to open a folder/TAR, or **Live cameras → Start all** and allow camera access.
4. When finished, close the viewer tab to release cameras, then press **Ctrl+C** in the launcher window to stop the service.

On Linux, some file managers also run **Start Viewer.sh** by double-click. If it opens as text, use **Run as a Program**. Enable **Properties → Permissions → Allow executing file as program** if required. The bundled **RobotDataViewer** executable can also be opened directly.

Keep all files and subfolders together: moving or renaming the whole extracted folder works; copying only the start file does not. This start file belongs to the package and needs no desktop shortcut installation. Keep notices and source materials with copies you share. Send recordings separately; they are not embedded in the viewer.

The smaller, HTML-only `RobotDataViewer.zip` is still available: double-click **viewer.html** in a desktop browser. It has no bundled localhost launcher. Use the platform package for a consistent live-camera permission workflow.

If **Start all** is disabled, the current page cannot access the browser's camera API; this is not a camera detection result. Open **Start Viewer** (or the Linux **RobotDataViewer** executable) and use its `http://127.0.0.1` address in desktop Chrome, Edge or Firefox. Direct `file:` camera access depends on the browser. A normal remote HTTP page cannot access cameras. If access is denied after Start all, allow it in browser/system camera settings and retry.

The repaired **v1.5.0-rc.3** build is **b7c47bb8ae06e6e76d0189d205050c7e9199c38a**. Same-version packages identify their source commit and viewer checksum in **BUILD.json**. Use **SHA256SUMS.txt** and **RELEASE-MANIFEST.json** from the release to verify downloads; the attached repaired-source archive corresponds to the repair commit. GitHub/Gitea automatically generated tag source archives remain the original rc.3 source.

In **Recordings**, choose **Open folder** for an original episode folder or a folder containing several recordings, or **Open TAR** for an original episode `.tar` file. Select a recording in the sidebar and press **Play**. RGB and tactile prepare in parallel and start together.

You can select `local-data` directly. An episode TAR can be opened as collected, without unpacking or preparing it. Everything stays on your computer and works offline.

For head-camera recordings, select the complete export folder, such as **T1E1**, or its TAR. The two head views, wrist views, tactile response, and motion will appear together automatically; keep the included `umi` folder in place.

Drag the timeline to seek. Use the speed menu or the previous/next-frame buttons. Space toggles playback; the arrow keys step through frames. Expand any panel for a closer look. For trajectories, drag to orbit, Shift-drag to pan, and scroll to zoom. Open Recorded signals to inspect numeric channels.

Press **Play** once to start RGB and tactile together. If preparation is still in progress, the viewer holds the selected timestamp and starts automatically when all available channels have a frame ready. Press **Pause** to cancel queued playback. Seeking and frame stepping remain available and update the preparation target. A failed channel shows a notice; the remaining channels start together when ready. Returning to an episode reuses its completed calibration while it remains in the memory cache; opening another recording clears that cache.

Each **Tactile response** panel shows one map at the recorded sensor orientation. Purple through orange to pale yellow means increasing image response; black means no detected response or an excluded region. Only changes inside the sensing surface are shown. The bright arc and a surrounding guard band are blacked out so that rim movement does not dominate the display; the original framing is preserved. If the arc is not detected, the panel stays black with a notice; other channels remain usable. The **Weak–Strong** legend is relative image response, not measured force or pressure. The viewer prepares a fixed baseline and noise estimate from the opening two seconds (at least eight frames when available; shorter clips use all frames), then smooths and colors the changes. Open the panel’s display settings (sliders icon) to adjust gain from 1× to 16× (default 10×), or enable **Show all changes** to bypass denoising and include small differences and noise inside the sensing region. Gamma stays at 0.7. Playback, seeking and expansion keep the same baseline and arc mask, so sustained changes do not fade away. Existing contact in the opening interval can become part of the baseline. The viewer cannot show contact with no detectable tactile-image change. Original recordings are unchanged.

The viewer automatically uses complete raw camera timestamps when available, including ARX5 recordings whose training timestamps intentionally omit the last entry. “Estimated alignment” means neither timestamp file provides a valid timestamp for every video frame; video timing is used as a fallback. Missing numeric tactile data does not prevent the tactile response maps from working.

Use the language button to switch to Chinese. You can open another folder or TAR at any time.

Use a current desktop Firefox, Chrome, or Edge browser. No plugins or external codecs are needed. “Preparing synchronized views” means the selected frames are being prepared together; “Synchronizing” during playback means a decode buffer is being replenished. Direct archive opening supports uncompressed `.tar` files.

If a sensor arc is difficult to detect, the viewer also checks matching nearby episodes already present in the selected folder or TAR. You do not need to open those episodes first. Only checked arc geometry is reused; each episode keeps its own baseline and noise estimate. Hover the recovery notice to see the reference episode. Open the parent folder or complete task TAR to make neighboring recordings available.

## Optional force display

Force is off initially. Enable **Show estimated force** to prepare the selected
episode or reuse matching saved results. Calculation pauses playback, processes
every sensor frame, and can take several minutes. You can cancel or turn the
option off; ordinary RGB/tactile playback remains available. Preparation ends
paused: press Play to see Fz (normal force) and shear magnitude in N, with curves,
synchronized to the same displayed video frames. Values also appear when expanded.

Use **Save force tracks** to share `*.rdv-force.json`; recipients import it or put
it beside the recording in its folder/TAR. Videos are checked by content, so
renaming does not attach forces to unrelated recordings. No Python or network
is required for viewing or browser calculation. Keep `force-runtime.js` next to
`viewer.html` for calculation; existing tracks work without loading that model.

Values are estimates, not calibrated measurements. The first frame is the
reference and may already contain contact; the model can predict a nonzero
baseline. Display gain and rim masking affect only the heatmap, not force.

## Native force preparation

The platform package also provides faster force preparation through its
**Start Viewer** launcher.
Keep the launcher open. It includes Python, OpenCV, ONNX Runtime and FFmpeg;
recipients install no development tools. Your selected tactile videos are sent
only to the launcher on this computer. The model loads only when force is requested.

Completed estimates are remembered across restarts in a 256 MiB disk cache.
The force toolbar shows storage usage and lets you remove this episode's results
or all saved force results. Removal switches force off without recalculating.
Preparation shows elapsed time, overall frame progress and an estimated remaining
time. It still processes every frame and ends paused. Optional NVIDIA libraries
are supplied separately; see NATIVE_FORCE.md for installation and limitations.

## Live USB camera inspection

Choose **Live cameras → Start all** and allow camera access. Assign each device
using the visible **Wrist / environment** (640×480, 30 Hz) or **Tactile**
(640×360, 30 Hz) choices. Use the pencil button to give each camera its own
name; the original device name stays underneath. **Capture settings** lets you
enter custom width, height, and frame rate (at least 1 Hz), then **Apply**.
Requested and actual settings appear separately. **Reset to role defaults**
removes custom values; changing roles also restores defaults. Changing capture
settings restarts only that running camera and requires recalibration. Renaming
does not interrupt capture or calibration. Preferences are remembered by browser
device identity when storage is available. Raw images remain visible; remove
contact and click **Calibrate** for tactile response. Firefox, Chrome and Edge
can use the localhost launcher if direct-file camera permission is unavailable.
Stop all disables automatic preview of newly connected cameras. See
[LIVE_CAMERAS.md](LIVE_CAMERAS.md) for controls, permissions, and release-candidate
validation limits.

On the tested Linux Firefox 156 setup, this USB tactile camera accepts uncropped
640×480/30 Hz but rejects uncropped 640×360/30 Hz. Keep **Tactile** selected,
open **Capture settings**, enter **640 / 480 / 30**, choose **Apply → Start**,
then calibrate. The role and resolution are independent. Use Chrome to request
the camera's uncropped 640×360 preset; the viewer never silently substitutes
browser cropping/scaling to make an unsupported request appear successful.

Repair acceptance on Linux Chrome 155 and Firefox 157 confirmed one minute of raw camera capture and camera release through the native launcher. Chrome tactile calibration passed. Firefox required the explicit 640×480/30 Hz override and reported **Sensing region not found**; raw preview remained available. Automated Windows/macOS launcher and synthetic-camera checks passed, while physical-camera acceptance on those platforms remains pending.
