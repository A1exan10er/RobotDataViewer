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

## Tactile image-change display

Noise cleanup is enabled by default. The display compares each RGB frame with the fixed first decoded frame. It averages absolute color-change energy on a bounded spatial grid, estimates the background spread from the lower part of the change distribution, and keeps connected regions only when they contain a sufficiently large, stronger core. A soft spatial mask suppresses isolated specks and weak diffuse fluctuations before the existing 1–16× display gain is applied. Excluded pixels are opaque white.

The mask is calculated independently for each frame. It does not learn away held contact, accumulate motion trails, or change with playback/seek order. The native-video worker, software-decoder worker, and settings redraw use the same implementation. Native playback displays the latest completed tactile result even when processing takes longer than 100 ms; seeks and display-setting changes explicitly invalidate older results. Incoming requests are coalesced so delayed rendering does not create a backlog. No external library, online service, or extra preparation is needed.

The tactile display settings include **Noise cleanup / 背景去噪**. Turning this off restores all original first-frame RGB differences, including small changes and background fluctuations. Very small or weak changes can be suppressed in the cleaned display; neither display is a calibrated force measurement or a contact/no-contact classifier. If the first frame already contains contact, it remains the reference.

Background reading for the spatial filtering approach: [OpenCV smoothing](https://docs.opencv.org/4.13.0/d4/d13/tutorial_py_filtering.html) and [OpenCV connected components](https://docs.opencv.org/4.x/d3/dc0/group__imgproc__shape.html). The viewer's implementation is self-contained TypeScript; OpenCV is not shipped or required.
