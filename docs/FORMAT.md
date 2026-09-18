# Recording formats and reader interfaces

## Direct original recordings

An episode contains `metadata.json` and collector channels. A folder selection may include any number of nested episodes. A plain `.tar` archive may contain an episode directory or several episodes. TAR indexing supports USTAR names, GNU long names, and PAX path/size records. Links are ignored; invalid headers, duplicate paths, unsafe paths, and truncated entries are rejected.

Camera channel directories may be `observation.image.<camera>` or `observation/image/<camera>`, containing `video.mp4` and optionally `timestamps_raw.csv` and/or `timestamps.csv`. Supported cameras are `third_view`, `second_third_view`, `left_wrist_view`, `right_wrist_view`, and each wrist's `left_tactile` / `right_tactile` channels.

State directories use the same dotted/nested convention: `observation.state.eef_pose`, `gripper`, `joint_position`, `joint_velocity`, and tactile sensor names. CSVs use `timestamp_ms`; pose columns are `x,y,z,r1,...,r6,gripper`, optionally prefixed with `left_` or `right_`. The two recorded rotation columns are orthonormalized. Invalid positions are skipped; unavailable orientations are omitted. Samples are sorted by recorded timestamp.

Valid `coordinate_reference.type=umi_episode_start_relative_pose` metadata provides left/right `reference_pose` (or `pose`) entries with `tcp.x/y/z` and `tcp.qw/qx/qy/qz`. Both arms are transformed into the left episode reference frame. Without complete valid references, separate recorded-coordinate viewports avoid an invented alignment.

MP4 presentation timestamps are read directly. The viewer prefers `timestamps_raw.csv` when it provides one valid, nonnegative, monotonic capture timestamp per video frame. If raw timestamps are absent or invalid, it tries `timestamps.csv` with the same checks. If neither matches, it uses video presentation times with the first valid capture offset (processed first, then raw) and marks estimated alignment. Numeric signals retain their recorded times. Empty tactile CSVs never fabricate force readings.

For hand-guided ARX5 demonstrations, training preparation intentionally pairs observations with following actions. In the supplied ARX5 samples, `timestamps.csv` is exactly `timestamps_raw.csv` without the last row, while each MP4 retains all frames. Using the complete raw timestamps preserves the recorded video timeline without treating this intentional training difference as missing timing. The viewer does not shift timestamps, infer human command times, or modify action/observation files. Numeric signals continue to use their recorded `data.csv` times.

## Internal source interface

`RecordingSource` exposes `kind`, `manifest.episodes`, `file(path): Blob | undefined`, `data(path, signal?): Promise<EpisodeData>`, and `dispose()`. Original sources normalize the selected episode in memory only. Media include codec/dimensions/timing discovered from the MP4. Native and software transports share preparation, presentation, seek, pause, and disposal operations.

The normalized episode model is internal; users do not need to create it. Existing folders with a version 1 `robot-data-viewer` manifest remain readable for compatibility. No generated manifest is required for original recordings.

## Tactile response display

Each sensor displays one map, preserving the recorded aspect ratio and orientation. Original tactile frames are decoded internally. They are not displayed alongside the response map, including in expanded view.

Every frame is compared with a fixed copy of its first decoded frame. Maximum absolute RGB change is block-averaged onto a grid with at most 160 cells on either axis. Separable 3×3 and 9×9 means detect fine and broad spatial patterns. At each scale, the median and median absolute deviation estimate the background level and spread. Connected regions must meet both minimum area and accumulated excess-change thresholds; no strong central pixel is required. An absolute floor suppresses small camera fluctuations and a threshold cap preserves broad strong changes. The union of accepted regions is bilinearly feathered. A continuous white/amber/red palette applies display gain after detection, so raising gain does not admit additional background regions.

Native-video processing, software decoding, and software settings redraws use the same `TactileFilter` in workers. A synchronous compatibility fallback remains for browsers without offscreen bitmap processing. Native tactile sampling follows the media clock via animation frames rather than relying on the visibility of the source video. A single in-flight request coalesces incoming updates; completed frames remain useful during slow playback rendering. Seeks, settings changes, and disposal invalidate obsolete results. Decode-ahead and settings redraw buffers remain bounded.

The reference and mask are deterministic for each frame. The reference does not adapt, so held image changes are not learned away. **Show all changes / 显示全部变化** bypasses spatial cleanup and colors all absolute RGB changes, including noise. Gain ranges from 1× to 16×, default 8×. Colors are relative image responses, not measured pressure. White means no detected image response, not proof of no physical contact. If the first frame already contains contact, it remains the reference. Lighting artifacts, residual sensor deformation, and contact with no visible tactile change cannot always be distinguished by image comparison alone. No RGB-camera or gripper data are used to invent a tactile response.
