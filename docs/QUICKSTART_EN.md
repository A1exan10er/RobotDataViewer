# Robot Data Viewer

1. Double-click **viewer.html** to open the viewer in a desktop browser.
2. Choose **Open folder** for an original episode folder or a folder containing several recordings. Choose **Open TAR** for an original episode `.tar` file.
3. Select a recording in the sidebar and press **Play**.

You can select `local-data` directly. An episode TAR can be opened as collected, without unpacking or preparing it. Everything stays on your computer and works offline.

Drag the timeline to seek. Use the speed menu or the previous/next-frame buttons. Space toggles playback; the arrow keys step through frames. Expand any panel for a closer look. For trajectories, drag to orbit, Shift-drag to pan, and scroll to zoom. Open Recorded signals to inspect numeric channels.

Each tactile panel shows the original video and its change relative to the first frame. **Noise cleanup** is on by default: it removes scattered background fluctuations and highlights concentrated changes. Open the panel's display settings (sliders icon) to turn cleanup off when you want to inspect small differences. Image change starts at 8× contrast so subtle contact changes are easier to see. Use its gain slider to adjust the exaggeration from 1× to 16×; it does not alter recorded data. These images are not calibrated force or pressure.

The viewer automatically uses complete raw camera timestamps when available, including ARX5 recordings whose training timestamps intentionally omit the last entry. “Estimated alignment” means neither timestamp file provides a valid timestamp for every video frame; video timing is used as a fallback. Missing numeric tactile data does not prevent tactile video playback.

Use the language button to switch to Chinese. You can open another folder or TAR at any time.

Use a current desktop Firefox, Chrome, or Edge browser. No plugins or external codecs are needed. Playback may briefly show “Synchronizing” at startup or after seeking while it fills the decode buffer. Direct archive opening supports uncompressed `.tar` files.
