# Robot Data Viewer

Open original robot, UMI, and head-camera companion recordings directly. Explore synchronized RGB video, 3D end-effector trajectories, colored tactile response maps, and recorded numeric signals in an English/Chinese dark interface.

**Stable recorded-data snapshot (2026-10-20):** `stable-recordings-2026-10-20`
preserves commit `f7dc623` unchanged on `codex/stable-recordings`, on both
[GitHub](https://github.com/A1exan10er/RobotDataViewer/tree/stable-recordings-2026-10-20)
and [Gitea](https://git.neoteai.com/yangtianyu/RobotDataViewer/src/tag/stable-recordings-2026-10-20).
This labels normal recorded-data viewing as stable; live cameras retain their
experimental acceptance limits. It is a source snapshot, not a renamed or rebuilt
installer. Further force, tactile, calibration and device-model work is isolated
on `codex/force-tactile-calibration`; see the [investigation and implementation plan](docs/DEVELOPMENT_PLAN_ZH.md).

**Development build — 1.6.0-dev.2:** automatic saved-force reuse in both the
native launcher and HTML viewer, selectable compute backend, faster CUDA frame
preparation, and opening-period tactile noise cleanup. See
[development usage and validation](docs/DEVELOPMENT_BUILD_ZH.md).
This development version adds a visible desktop launcher with service status,
Open Viewer, and Stop & Exit. Closing the launcher stops the service; closing
browser tabs alone does not. Repeat launches reuse the same installation.
Active force preparation asks for confirmation; completed saved results remain.
The downloads below remain the previous published versions.

After building the native package, the runnable folder is
`dist/RobotDataViewer-1.6.0-dev.2-<platform>/`, beside its ZIP. On Linux,
open `RobotDataViewer` inside that folder. `npm run build` alone creates the
HTML application; follow [native build instructions](docs/NATIVE_FORCE.md)
to produce the executable. Keep the entire native folder together.

**Download for live cameras:** choose the native portable ZIP for your computer from the repaired [GitHub v1.5.0-rc.3 release](https://github.com/A1exan10er/RobotDataViewer/releases/tag/v1.5.0-rc.3) or [Gitea v1.5.0-rc.3 release](https://git.neoteai.com/yangtianyu/RobotDataViewer/releases/tag/v1.5.0-rc.3): Linux x64, Windows x64, macOS Intel (`macos-x64`), or Apple Silicon (`macos-arm64`). All four packages and their checksums were downloaded again and verified after publication.

**Start:** extract the whole package. Windows: double-click **Start Viewer.cmd**. Linux: open **RobotDataViewer**, or right-click **Start Viewer.sh → Run as a Program**. macOS: double-click **Start Viewer.command**. The bundled service opens your default browser at a local `http://127.0.0.1` address. Keep the launcher window open; close the viewer tab and press Ctrl+C in the launcher when finished. No Python, Node.js, installation or internet connection is needed after download.

Choose **Live cameras → Start all** and allow browser/system camera access, or choose **Recordings → Open folder / Open TAR** to inspect recorded data. A disabled Start all button now explains an insecure context or missing camera API and provides launcher guidance.

**HTML-only option:** `RobotDataViewer.zip` contains `RobotDataViewer/viewer.html` and its runtime, documentation, licenses and source. It has no native launcher. Open `viewer.html` directly for recordings; live-camera access from a local file depends on the browser. Keep the complete package together.

The repaired build is [b7c47bb](https://github.com/A1exan10er/RobotDataViewer/commit/b7c47bb8ae06e6e76d0189d205050c7e9199c38a), still **v1.5.0-rc.3**. Use the attached `repaired-source.tar.gz`, `RELEASE-MANIFEST.json` and `SHA256SUMS.txt` for this build. The unchanged tag and automatically generated Source code archives retain the original rc.3 source. Stable releases and optional NVIDIA add-ons remain available.

[English quick start](docs/QUICKSTART_EN.md) · [中文使用指南](docs/QUICKSTART_ZH.md)

## Live cameras (1.5.0 release candidate)

Inspect up to eight USB/UVC cameras before recording: wrist/environment at
640×480/30 Hz and tactile at 640×360/30 Hz. **Live cameras** provides raw previews,
stream-health indicators, hot-plug handling, and manually calibrated tactile
response maps. Camera frames remain local. See [live-camera usage and validation
limits](docs/LIVE_CAMERAS.md). Physical-camera acceptance on Windows/macOS and broader multi-camera hardware testing remain required before stable 1.5.0; the preserved 1.4.0 release remains available.

The 1.5.0-rc.3 candidate includes visible role choices, independent camera names,
and custom width/height/frame-rate settings, remembered by browser device identity. Use the pencil button to name a device and **Capture settings**
to change its requested parameters. See the quick starts for Firefox and Chrome.

## Supported data

The viewer reads collector `metadata.json`, MP4 videos, camera timestamps, and state CSVs directly from dotted or nested `observation.image` / `observation.state` directories. Folder selection discovers episodes recursively. Plain TAR archives are indexed in memory and their file entries read through Blob slices; nothing is extracted to disk.

Head-camera companion exports (`ego-headcam-companion-1`) open as one episode: both head views plus the wrist cameras, tactile response, trajectories, and signals in the nested UMI folder. Select the whole export folder (for example, `T1E1`), its parent, or its uncompressed TAR. No rearrangement or conversion is needed.

RGB uses native browser playback where supported. H.264/HEVC tactile video uses the bundled sequential WebAssembly decoder, avoiding per-frame calibration seeks even when native playback is available. The same decoder handles RGB recordings the browser cannot play. Software video decoding and tactile response processing run in background workers with bounded decode-ahead buffers. Calibration and initial playback reuse the same opening grayscale samples; no raw tactile video or duplicate calibration video is loaded. Camera buffering and the two calibration jobs begin together. Playback fills a reserve before starting or resuming after an underrun. Native browser playback corrects small clock differences through gentle speed adjustment instead of repeated seeks. Ready-to-display frames are transferred to the interface, and trajectory geometry is cached so playback does not repeatedly recalculate full paths. The viewer works offline even when the operating system has no HEVC codec. Playback performance depends on resolution, channel count, and the computer; the shared timeline waits when decoding needs to catch up.

Originals are read-only. Available channels can be inspected even when others are absent or corrupt. Missing or inconsistent camera timestamps are visibly marked as estimated alignment. Recorded numeric tactile data remains separate from optional model estimates. Each sensor has one full-width **Tactile response / 触觉响应** map. A fixed median baseline and per-pixel noise estimate from the opening two seconds suppress background fluctuations. Gaussian smoothing and an Inferno palette reveal increasing response from purple through orange to pale yellow; inactive regions stay exactly black. A fixed arc mask keeps only the inner sensing surface, excluding the bright optical rim and a guard band around it while preserving the original framing and orientation. Excluded pixels stay opaque black. If the initial arc search fails, the viewer expands the search and can check up to four nearby recordings from the same sensor/device group. It validates rim alignment before reusing only the arc geometry; brightness and noise calibration always belong to the selected episode. A small notice identifies recovery from a neighboring episode. If no valid region is available, the affected panel hides its response and displays a notice. Gain starts at 10× (adjustable from 1× to 16×), with fixed gamma 0.7. **Show all changes** bypasses denoising and the low-response cutoff within the sensing region; it never disables the mask. RGB and tactile views prepare together, with at most two calibrations running at once. Play waits until every available channel has a frame ready at the selected timestamp, then reveals and starts all views together. Pause cancels queued playback; seeking and stepping update the preparation target. Failed channels show a notice while the remaining channels can start together. Completed baseline/noise/mask models are reused on episode returns in a 32 MiB memory cache, cleared when the recording source changes or closes. Seeking and sustained changes never rebase the model. The opening interval may already contain contact. Colors describe relative image response, not measured force or pressure, and cannot show contact with no detectable image change.

Existing version 1 prepared sample folders remain supported. ZIP and compressed TAR inputs are not supported by the direct archive reader.

The development build stops opening-period noise sampling before sustained image
changes and removes tiny isolated responses before smoothing. Start each episode
unloaded; the first eight frames are still assumed to be a valid reference.
The baseline remains fixed during playback, preserving sustained contact.

## Optional force estimates

Turn on **Show estimated force** to view per-sensor normal force **Fz** and
**shear magnitude** in newtons beside the tactile images and on synchronized
curves. Force is off by default: ordinary viewing loads no model and performs
no force computation. Without ready tracks, enabling force pauses playback
and prepares every tactile frame of the selected episode. This separate step
can take several minutes; progress and cancellation remain available. When it
finishes, press Play. Seeking, speed changes and frame stepping keep values
aligned with the displayed source frame.

Use **Save force tracks** to share results. Recipients can use **Import force
tracks**, or open a folder/TAR containing a `*.rdv-force.json` file, and enable
force without recalculation. Original recordings are never modified. Authors
can also [prepare tracks with Python](tools/force/README.md). Keep the complete
portable ZIP, including `force-runtime.js`, for optional browser calculation.

In the development build, completed tracks are saved automatically. Reopening
the same recording checks saved results before loading any model. The native
launcher retains them until explicit removal; HTML uses browser-managed IndexedDB,
which may be cleared or evicted. The interface shows how many tracks were saved
and reused, the actual compute backend, and any save failure. Exported files
remain the portable backup. **Automatic / Prefer GPU / CPU** affects only new
calculations; already saved tracks are reused regardless of that choice.

These are model estimates relative to each video's first frame, not calibrated
force measurements. Existing contact and model bias may produce nonzero values
at the reference frame. Heatmap colors remain relative image response, and
changing gain or hiding the sensor rim does not change the force calculation.

## Development

Node.js 22.18+ and npm:

```bash
npm ci
npm run dev
npm run build
npm test
```

The build embeds the application, styles, decoder, and notices in `dist/viewer.html`. No runtime dependencies are fetched. `vendor/` contains the pinned decoder build; rebuilding it is documented in [vendor/BUILD.md](vendor/BUILD.md). Python and FFmpeg are not required to open recordings or build the frontend.

Create the HTML-only release with `python3 tools/release.py` after a successful build. For the four native packages and verified publication, follow [the release repair procedure](docs/RELEASE_REPAIR.md). Distribute `dist/RobotDataViewer.zip` as a complete package; it contains no customer recordings. It includes the viewer, quick starts, licenses, decoder source and rebuild instructions. Keep the source/license materials with copies distributed to customers.

See [format and interfaces](docs/FORMAT.md) and [validation](docs/VALIDATION.md).

## Independence

This project has its own build and release lifecycle. It does not import or run QualityCheck, use a database, contact a remote service, label episodes, or modify recordings. Live camera mode requests local browser camera access only. The 6D/UMI transformation mathematics retain provenance from the company's existing viewer. The tactile display follows the supplied [offline reference](tools/reference/README.md).

Native force acceleration in 1.4.0: launch the platform package for full-frame native preparation and a removable 256 MiB saved-result cache. The HTML-only viewer remains available. See [native builds and usage](docs/NATIVE_FORCE.md) and [measured validation](docs/VALIDATION.md).
