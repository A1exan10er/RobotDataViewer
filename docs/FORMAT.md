# Recording formats and reader interfaces

## Direct original recordings

An episode contains `metadata.json` and collector channels. A folder selection may include any number of nested episodes. A plain `.tar` archive may contain an episode directory or several episodes. TAR indexing supports USTAR names, GNU long names, and PAX path/size records. Links are ignored; invalid headers, duplicate paths, unsafe paths, and truncated entries are rejected.

Camera channel directories may be `observation.image.<camera>` or `observation/image/<camera>`, containing `video.mp4` and optionally `timestamps_raw.csv` and/or `timestamps.csv`. Supported cameras are `ego_left`, `ego_right`, `third_view`, `second_third_view`, `left_wrist_view`, `right_wrist_view`, and each wrist's `left_tactile` / `right_tactile` channels.

State directories use the same dotted/nested convention: `observation.state.eef_pose`, `gripper`, `joint_position`, `joint_velocity`, and tactile sensor names. CSVs use `timestamp_ms`; pose columns are `x,y,z,r1,...,r6,gripper`, optionally prefixed with `left_` or `right_`. The two recorded rotation columns are orthonormalized. Invalid positions are skipped; unavailable orientations are omitted. Samples are sorted by recorded timestamp.

Valid `coordinate_reference.type=umi_episode_start_relative_pose` metadata provides left/right `reference_pose` (or `pose`) entries with `tcp.x/y/z` and `tcp.qw/qx/qy/qz`. Both arms are transformed into the left episode reference frame. Without complete valid references, separate recorded-coordinate viewports avoid an invented alignment.

MP4 presentation timestamps are read directly. The viewer prefers `timestamps_raw.csv` when it provides one valid, nonnegative, monotonic capture timestamp per video frame. If raw timestamps are absent or invalid, it tries `timestamps.csv` with the same checks. If neither matches, it uses video presentation times with the first valid capture offset (processed first, then raw) and marks estimated alignment. Numeric signals retain their recorded times. Empty tactile CSVs never fabricate force readings.

For hand-guided ARX5 demonstrations, training preparation intentionally pairs observations with following actions. In the supplied ARX5 samples, `timestamps.csv` is exactly `timestamps_raw.csv` without the last row, while each MP4 retains all frames. Using the complete raw timestamps preserves the recorded video timeline without treating this intentional training difference as missing timing. The viewer does not shift timestamps, infer human command times, or modify action/observation files. Numeric signals continue to use their recorded `data.csv` times.

## Head-camera companion exports

A root `metadata.json` with `format: "ego-headcam-companion-1"` and `umi_episode: "umi"` declares one combined episode:

```text
T1E1/
  metadata.json
  observation.image.ego_left/{video.mp4,timestamps.csv,timestamps_raw.csv}
  observation.image.ego_right/{video.mp4,timestamps.csv,timestamps_raw.csv}
  umi/
    metadata.json
    observation.image.<wrist-or-tactile>/{video.mp4,timestamps.csv,timestamps_raw.csv}
    observation.state.<channel>/data.csv
```

The `umi_episode` link must be a safe relative descendant path inside the selected export. The reader joins only explicitly declared companion exports, and suppresses the included UMI entry from the episode list. Selecting the UMI folder alone still opens its six-camera recording. Other episodes in a selected parent folder remain separate. Task/platform labels fall back to the nested UMI metadata; UMI coordinate references and numeric channels also come from that folder.

Head cameras appear first as **Head camera · Left eye / 头戴相机 · 左眼** and **Head camera · Right eye / 头戴相机 · 右眼**, followed by the recorded wrist/overview views. Each MP4 reads its own sibling timestamp files. Head views prefer valid `timestamps.csv`, then `timestamps_raw.csv`; UMI channels retain raw-first precedence. Fractional milliseconds are preserved. Every CSV row maps to its corresponding exported MP4 frame, independent of `source_raw_index`, `source_sequence`, or `is_new`. Missing/invalid timing falls back to an explicitly estimated timeline as with existing recordings.

The head timestamps already use the shared episode clock. The viewer does not apply `alignment.json` offsets a second time, resample using `frame_mappings`, reorder eyes using stereo-source metadata, or follow absolute provenance paths. “Timestamp alignment” describes the available timing evidence, not hardware exposure synchronization. Native and software playback interpolate between each stream's capture timestamps and MP4 presentation times, supporting different frame rates and recording intervals without modifying the data.

## Internal source interface

`RecordingSource` exposes `kind`, `manifest.episodes`, `file(path): Blob | undefined`, `data(path, signal?): Promise<EpisodeData>`, and `dispose()`. Original sources normalize the selected episode in memory only. Media include codec/dimensions/timing discovered from the MP4. Native and software transports share preparation, presentation, seek, pause, and disposal operations.

The normalized episode model is internal; users do not need to create it. Existing folders with a version 1 `robot-data-viewer` manifest remain readable for compatibility. No generated manifest is required for original recordings.

## Tactile response display

Each sensor displays one map, preserving the recorded aspect ratio and orientation. Original tactile frames are decoded internally. They are not displayed alongside the response map, including in expanded view.

Each channel prepares a fixed baseline from the first `min(totalFrames, max(8, round(2 × fps)))` decoded frames (ties-to-even rounding, default 30 fps if unknown). Short clips use every available frame. RGB frames are converted to 8-bit grayscale using OpenCV-compatible fixed-point coefficients. The per-pixel median is truncated to 8-bit; the 99th percentile of absolute deviations from that median uses linear interpolation and float32 storage.

For each current frame, the renderer subtracts the stored noise floor and an additional 2 intensity levels from absolute grayscale difference, clamps at zero, and applies a separable 17-tap Gaussian with sigma 2 and reflected (`REFLECT_101`) boundaries. The result is multiplied by display gain, clamped/truncated to 8-bit, and mapped through a gamma-0.7 lookup table. Intensities below 10 are suppressed. A bundled 256-entry Inferno table supplies RGB colors; zero response is exactly opaque black. Floating-point accumulation can differ slightly from OpenCV SIMD processing at quantization boundaries.

The sensing region is detected from the median baseline using the locally bundled FlawDetection arc algorithm. A centre-aligned bilinear 640×360 analysis image feeds edge scoring, an anchored right-opening curve fit, guided refinement, and dominant-foreground selection. Candidate points must lead into surface pixels 14–30 analysis pixels to their right (median grayscale >0.075). Accepted curves have confidence ≥0.75, finite coordinates, and both endpoints at least 25 pixels right of the leftmost point. The mask keeps foreground right of the curve with a 14-pixel inward margin and three erosion iterations, then maps back to source pixel centres using nearest-neighbor sampling. The source frame is not cropped, rotated or resized for display.

Excluded differences are zeroed before smoothing and output pixels are forced to opaque black after coloring, so outside changes cannot bleed into the sensing region. The mask is always enforced, including with Show all changes. Missing or unreliable arcs produce an empty mask and a visible panel notice; there is no unmasked fallback and other channels can continue playback.

Native playback collects the opening frames using an independent video decoder at presentation-time midpoints; it never seeks the synchronized playback video for calibration. The software worker performs a calibration prepass and rewinds before filling its bounded playback queue. Shared playback readiness waits for calibration and a rendered frame from every available channel. Failures remain visible in their panels and are terminal exceptions to readiness; cancellation releases obsolete work. Calibration retains only grayscale samples and releases them after computing the model and sensing mask. Arc fitting runs once during preparation, never per frame.

Native-video processing, software decoding, and software settings redraws share the same `TactileFilter` in workers. Browsers without offscreen bitmap processing capture one RGBA frame per asynchronous request; calibration, arc fitting and filtering still run in a worker. Native sampling follows the media clock independently of source-video visibility. One in-flight render coalesces updates, so slow rendering still paints completed frames. Seeks, settings changes, and disposal invalidate obsolete results. The internal baseline model contains dimensions, sample count, an 8-bit grayscale baseline, float32 noise-floor arrays, a source-sized byte mask, arc detection status and confidence; recording formats and timestamps are unchanged.

Camera buffering has priority. Tactile preparation runs in a queue with at most two calibration jobs. The playback coordinator establishes all expected channels before panels mount, including queued decoders. Every channel stages its mapped current frame behind an opaque overlay; software decoding reserves up to 0.65 seconds ahead without seeking into the future. Once every successful channel acknowledges a frame for the current generation, all views are revealed together and queued playback starts on the next animation frame. Pause cancels queued playback. Seeks, frame stepping, speed changes and decoder fallback re-enter shared readiness without changing calibration. Native automatic rendering is suspended during staging; staged replies also carry source time and settings revision. Synchronous and asynchronous decoder/render failures are confined to their panel.

Completed models are retained in a 32 MiB LRU memory cache, keyed by source Blob identity, capture/decoder path and calibration parameters. Cache arrays are copied before worker use. No calibration frames, videos or bitmaps are cached. Changing or closing the recording source clears the cache; there is no disk cache or speculative episode preparation. Transient failures are not cached.

The baseline never adapts. Playback, seeking, holds and expansion reuse the same model. **Show all changes / 显示全部变化** bypasses noise subtraction, smoothing and the low-intensity cutoff, retaining grayscale comparison, gain, gamma, the same palette and the sensing mask. Gain ranges from 1× to 16×, default 10×. Baseline duration and gamma are fixed. Colors are relative image response, not measured pressure. Black means no detected image response or an excluded region, not proof of no physical contact. Existing contact in the opening interval becomes part of the baseline; lighting artifacts and residual deformation may also produce response. No RGB-camera or gripper data are used to invent a tactile response.

The original Python/OpenCV implementation is preserved unchanged under `tools/reference/`; it is a development reference, not a runtime requirement.

### Sequential tactile startup

H.264/HEVC tactile panels select the bundled sequential decoder before mounting;
only RGB panels use native video elements by default. Calibration starts alongside
camera buffering, with two initialization/calibration jobs at most. The opening
samples are converted from decoded RGBA using the reference coefficients and reused
as grayscale playback frames after the fixed median/noise/mask model is complete.
The native capture path remains available for other browser-playable codecs.

Internal decoder messages carry optional grayscale source buffers for tactile
frames and processed response images. RGB messages retain their image/pixel form.
Settings redraws send a copy of the displayed grayscale sample to the same worker;
source time, playback generation, settings revision and paint order still control
acceptance. These are internal interfaces, not changes to recording files.

Initial buffering stops at the requested 0.65-second reserve. Normal playback can
prefetch farther. Retained opening samples and colored frame buffers share the
64 MiB channel budget; when the opening window cannot fit alongside its reserve,
startup uses one sequential rewind. The 32 MiB LRU contains only completed models,
never videos, decoded samples or bitmaps. Bounded local diagnostics report decoder
initialization, samples, seeks, statistics, arc detection and joint presentation.
