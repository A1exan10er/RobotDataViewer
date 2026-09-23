# Robot Data Viewer

1. Double-click **viewer.html** to open the viewer in a desktop browser.
2. Choose **Open folder** for an original episode folder or a folder containing several recordings. Choose **Open TAR** for an original episode `.tar` file.
3. Select a recording in the sidebar and press **Play**.

You can select `local-data` directly. An episode TAR can be opened as collected, without unpacking or preparing it. Everything stays on your computer and works offline.

For head-camera recordings, select the complete export folder, such as **T1E1**, or its TAR. The two head views, wrist views, tactile response, and motion will appear together automatically; keep the included `umi` folder in place.

Drag the timeline to seek. Use the speed menu or the previous/next-frame buttons. Space toggles playback; the arrow keys step through frames. Expand any panel for a closer look. For trajectories, drag to orbit, Shift-drag to pan, and scroll to zoom. Open Recorded signals to inspect numeric channels.

Each **Tactile response** panel shows one map at the recorded sensor orientation. Amber through red means increasing image response relative to the first frame; white means no detected response. The **Weak–Strong** legend describes relative image response, not measured force or pressure. Background cleanup is automatic. Open the panel’s display settings (sliders icon) to adjust display gain from 1× to 16× (default 8×), or enable **Show all changes** to include small differences and noise. The first frame stays the reference during playback and seeking, so a sustained recorded change does not fade away. The viewer cannot show contact that has no detectable tactile-image change. Original recordings are unchanged.

The viewer automatically uses complete raw camera timestamps when available, including ARX5 recordings whose training timestamps intentionally omit the last entry. “Estimated alignment” means neither timestamp file provides a valid timestamp for every video frame; video timing is used as a fallback. Missing numeric tactile data does not prevent the tactile response maps from working.

Use the language button to switch to Chinese. You can open another folder or TAR at any time.

Use a current desktop Firefox, Chrome, or Edge browser. No plugins or external codecs are needed. Playback may briefly show “Synchronizing” at startup or after seeking while it fills the decode buffer. Direct archive opening supports uncompressed `.tar` files.
