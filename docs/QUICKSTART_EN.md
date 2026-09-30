# Robot Data Viewer

Extract the complete portable ZIP before opening the viewer. Keep its notices and source materials together when sharing it. Send your data folders or TAR files separately; recordings are not embedded in the viewer. No installation, server, Python, or internet connection is required. RGB and tactile prepare in parallel and start together.

1. Double-click **viewer.html** to open the viewer in a desktop browser.
2. Choose **Open folder** for an original episode folder or a folder containing several recordings. Choose **Open TAR** for an original episode `.tar` file.
3. Select a recording in the sidebar and press **Play**.

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

## Faster native package (1.4.0)

For faster force preparation, extract the native ZIP for your operating system
and run its RobotDataViewer launcher (Windows: .exe; macOS: Start Viewer.command).
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
as wrist/environment (640×480, 30 Hz) or tactile (640×360, 30 Hz). Raw images
remain visible; remove contact and click **Calibrate** for tactile response.
Stop all disables automatic preview of newly connected cameras. See
[LIVE_CAMERAS.md](LIVE_CAMERAS.md) for controls, permissions, and release-candidate
validation limits.
