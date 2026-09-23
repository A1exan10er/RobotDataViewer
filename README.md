# Robot Data Viewer

Open original robot, UMI, and head-camera companion recordings directly. Explore synchronized RGB video, 3D end-effector trajectories, colored tactile response maps, and recorded numeric signals in an English/Chinese dark interface.

**Download:** get `RobotDataViewer.zip` from the [GitHub releases](https://github.com/A1exan10er/RobotDataViewer/releases) or [Gitea releases](http://192.168.50.209:3000/yangtianyu/RobotDataViewer/releases). Extract the ZIP and double-click `RobotDataViewer/viewer.html`. Keep the included notices and source materials with the viewer when sharing it.

**Start:** open `viewer.html` from the release package (or `dist/viewer.html` after building from source), then choose **Open folder** or **Open TAR**. Select an episode, a parent folder containing episodes, or an original `.tar` archive. Press Play. No sample preparation, installation, conversion, server, or internet connection is needed.

[English quick start](docs/QUICKSTART_EN.md) · [中文使用指南](docs/QUICKSTART_ZH.md)

## Supported data

The viewer reads collector `metadata.json`, MP4 videos, camera timestamps, and state CSVs directly from dotted or nested `observation.image` / `observation.state` directories. Folder selection discovers episodes recursively. Plain TAR archives are indexed in memory and their file entries read through Blob slices; nothing is extracted to disk.

Head-camera companion exports (`ego-headcam-companion-1`) open as one episode: both head views plus the wrist cameras, tactile response, trajectories, and signals in the nested UMI folder. Select the whole export folder (for example, `T1E1`), its parent, or its uncompressed TAR. No rearrangement or conversion is needed.

Native browser video playback is used where supported. A bundled WebAssembly H.264/HEVC decoder automatically handles other recordings. Software video decoding and tactile response processing run in background workers with bounded decode-ahead buffers. Playback fills a reserve before starting or resuming after an underrun. Native browser playback corrects small clock differences through gentle speed adjustment instead of repeated seeks. Ready-to-display frames are transferred to the interface, and trajectory geometry is cached so playback does not repeatedly recalculate full paths. The viewer works offline even when the operating system has no HEVC codec. Playback performance depends on resolution, channel count, and the computer; the shared timeline waits when decoding needs to catch up.

Originals are read-only. Available channels can be inspected even when others are absent or corrupt. Missing or inconsistent camera timestamps are visibly marked as estimated alignment. Numeric tactile data is shown only if recorded. Each sensor has one full-width **Tactile response / 触觉响应** map. Amber-to-red colors show increasing image response against the fixed first frame; inactive regions stay exactly white. Spatial background normalization reveals coherent weak changes while suppressing isolated noise. Gain starts at 8× (adjustable from 1× to 16×); **Show all changes** includes unfiltered changes and noise. Colors describe relative image response, not measured force or pressure. The viewer cannot infer physical contact when the tactile images contain no detectable change.

Existing version 1 prepared sample folders remain supported. ZIP and compressed TAR inputs are not supported by the direct archive reader.

## Development

Node.js 22.18+ and npm:

```bash
npm ci
npm run dev
npm run build
npm test
```

The build embeds the application, styles, decoder, and notices in `dist/viewer.html`. No runtime dependencies are fetched. `vendor/` contains the pinned decoder build; rebuilding it is documented in [vendor/BUILD.md](vendor/BUILD.md). Python and FFmpeg are not required to open recordings or build the frontend.

Create the portable release with `python3 tools/release.py`. It includes the viewer, quick starts, licenses, decoder source and rebuild instructions. Keep the source/license materials with copies distributed to customers.

See [format and interfaces](docs/FORMAT.md) and [validation](docs/VALIDATION.md).

## Independence

This project has its own build and release lifecycle. It does not import or run QualityCheck, use a database, contact a service, control hardware, label episodes, or modify recordings. The 6D/UMI transformation mathematics and fixed-reference RGB difference formula retain provenance from the company's existing viewer.
