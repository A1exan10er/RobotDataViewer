# Validation

## Tactile response (1.1.6)

Validated locally on 2026-09-18. The v1.1.5 source/tag and release artifacts are preserved.

The UI now shows one full-width white/amber/red **Tactile response / 触觉响应** map per sensor, with its recorded aspect ratio and orientation, a Weak–Strong legend, default 8× gain, and an optional Show all changes switch. Normal and expanded views hide the original image while retaining decoding. The filter combines 3×3 and 9×9 spatial evidence, robust median/MAD background estimates, connected-region area and accumulated excess change. It no longer requires a strong core. The first-frame reference stays fixed.

### Reported capping frame and sample phases

At episode `0070_20260917-114140_likun_umi_none`, 18.8 seconds, the left-hand right sensor shows 13,716 response pixels in Chrome software decoding and 14,579 in Firefox native decoding. Both untouched right-hand sensors remain exactly white. The left-hand left sensor has no sufficiently separable response at that frame; no response is fabricated from the visible grasp. Small differences in decoder RGB conversion can change mask boundaries.

Wrist-camera contact sheets were reviewed for approach, grasp, sustained hold and release context. A repeatable read-only sample regression checks 49 sensor frames across capping 0070, folding 0055 and sorting 0066: 34 expected clean frames are exactly white and 15 frames with measurable contact have more than 500 response pixels. Cases include capping approach at 2 s, weak contact at 18.8 s, hold at 60 s and release at 115.3 s; folding grasp at 10 s, right-hand hold at 18.8/20 s and release at 25/150.2 s; sorting approach at 2/5 s, left-hand grasp/hold at 10/18.8/20 s and release at 25 s. Returning to each identical decoded frame after another render produces byte-identical output.

These checks do not establish a perfect physical contact classifier. Some visibly held objects have no separable tactile-image signal in particular sensors or frames. Lighting changes or residual sensor deformation can also produce coherent image response. White means no detected image response; colors are not pressure. Diagnostics never feed RGB or gripper values into the tactile filter.

Evidence: `artifacts/response-1.1.6/response-samples/results.json`; Chrome `tactile-browser/results.json` and `contact.png`; Firefox `firefox/response-controls-cleanup.json`. No recordings or diagnostic images are included in the customer ZIP.

### Playback and controls

All runs used isolated profiles with the standalone local HTML file. Chrome 152.0.7977.64 used the bundled software decoder for these HEVC samples; Firefox 154.0.1 used native decoding, with an additional forced-software folding check. Source tactile images had `display:none` throughout. Native updates use the media clock independently of video compositor callbacks.

- Chrome: 24-second uninterrupted checks passed for all three supplied TAR tasks. Sorting contact was visible in 14/14 samples on both left sensors; capping weak contact in 4/4 samples; folding hold in 11/11 samples on both right sensors. Each map painted about 706–711 times. Each run had one startup busy sample and no further buffering, no page exceptions, and no outbound page requests.
- Firefox native: sorting folder and capping TAR checks passed with zero busy samples and no runtime errors. Sorting contact was visible in 14/14 samples per left sensor, capping in 4/4 weak-contact samples. Tactile maps painted 523–563 times over approximately 24 seconds.
- Firefox delayed render: a 160 ms delay on tactile worker replies still showed contact in 14/14 samples on both left sensors, with 122–124 map paints, zero busy samples and no runtime errors. The previous white-during-playback failure did not recur.
- Firefox software fallback: folding passed with 11/11 visible hold samples on each right sensor, 705–708 paints, zero busy samples and no runtime errors.
- Chrome software and Firefox native controls passed: pause, next/previous frame, repeated seeks, expansion, gain 1×/8×/16×, Show all changes, and return to white. Response pixels exactly matched the shared filter on each browser's decoded frames. Settings redraws for software frames also run in a coalesced worker; a synchronous compatibility path remains for browsers lacking offscreen bitmap support.

Evidence under `artifacts/response-1.1.6/`: `live-tactile/chrome-{sorting,capping,folding}.json`, `firefox/response-{native,capping,delayed,folding-software}-live.json`, and the controls reports above. Reports include wall-clock advance, paint counts, live canvas samples and exceptions. These measurements are specific to this computer and the supplied recordings.

### Automated checks and local package

`npm run build`, `npm test` (33 JavaScript cases across five files), and `npm run test:python` (8 cases) passed. Filter regressions cover weak coherent patches without a strong center, isolated bright noise, broad contact, background drift, gain changes, release, held contact, repeated seeks, odd dimensions and portrait orientation. Existing playback regressions continue to cover delayed renders, stale seeks/settings, pause and disposal.

Reproduce sample checks with `python tools/check-tactile-samples.py /path/to/extracted-task-folders` in a Python environment with OpenCV/numpy. Fixtures remain in ignored `artifacts/response-samples` and are processed by the actual TypeScript filter. Browser checks accept `RDV_TASK=capping|folding` or Firefox `--task capping|folding`; the default is sorting. Set `RDV_ARCHIVE` or `--source` to the original task TAR/folder. Firefox sandboxed installations need a viewer/profile path visible to Firefox.

The local portable ZIP includes the standalone viewer, updated EN/ZH guides and source/license material. It requires no data conversion or schema change. ZIP integrity, embedded viewer equality, version labels and absence of sample recordings are checked before handoff.

## Earlier validation history

Validated locally on 2026-09-18 (viewer 1.1.5) with the standalone `file://` viewer in isolated Chrome 152.0.7977.64 on Linux. Browser HTTP/HTTPS/WebSocket requests were blocked. Recordings were read directly from their existing locations.

## Live tactile rendering (1.1.5)

The native tactile renderer previously discarded a completed image whenever the video had advanced by 100 ms or more since the render began. That condition could starve the display during continuous playback when capture, processing, or message delivery was delayed, leaving the initial white image on screen. Pausing or seeking allowed a result to arrive before the cutoff, which made contact appear again.

A normal 24-second Firefox run at a 4197 × 2322 window size displayed live contact. A controlled 160 ms delay applied only to tactile-frame replies reproduced the reported failure: the videos kept playing, 540 tactile replies completed, and all four tactile canvases stayed at one initial paint. Both left sensors were blank in all 15 sampled contact moments. This is a controlled reproduction of the cutoff failure; it does not measure the delay on the user's personal browser session.

The renderer now permits the latest completed image from the current playback sequence. It keeps one request in flight and coalesces incoming updates to the newest video position. Explicit generations invalidate images captured before a seek or display-setting change; disposal also prevents stale painting. This preserves seek correctness without requiring continuous playback to stop for tactile images to appear. Filtering, the fixed first-frame reference, and source recordings are unchanged.

The same delayed Firefox test passed after the fix: both left sensors showed contact in all 15 sampled contact moments, and each tactile canvas painted 132–133 times in 24 seconds. There were zero busy samples and no runtime errors. Delayed rendering can reduce tactile display cadence; it no longer freezes the display white or pauses video playback.

A 74-second Firefox run at the screenshot's 4197 × 2322 window size advanced 74.05 seconds in 74.05 seconds, with no busy samples or runtime errors. Tactile canvases updated 1,647–1,671 times and showed the later grasping activity around 68–70 seconds during continuous playback. The initial contact windows were visible in 15/15 samples for the left-hand left sensor and 14/15 for the left-hand right sensor.

The Chrome software path also passed a 24-second live-image check: each tactile canvas updated 713 times, and the two left sensors showed contact in 16/16 and 15/16 samples. Its only busy sample occurred during startup at time zero. No page exceptions or outbound requests occurred. Evidence: `artifacts/firefox/fixed-live-large-live.json` and `artifacts/live-tactile/chrome.json`, plus raw samples.

The existing Firefox tactile-controls regression also passed: paused contact, white background after release, the unfiltered switch, and fixed-reference image parity after seeking. Evidence: `artifacts/firefox/live-fix-controls-cleanup.json`.

Six new scheduling regressions cover delayed results during continuous playback, bounded requests, seeks away and back to the same timestamp, seek-in-progress handling, display-setting changes, the final paused frame, disposal, and obsolete failures. All 30 JavaScript cases and the TypeScript/production build passed.

Evidence: `artifacts/firefox/baseline-live-large-live.json`, `baseline-live-delayed-live.json`, and `fixed-live-delayed-live.json`, with time-series samples alongside the reports. Live checks sample the actual tactile canvases while playback continues through recorded grasping intervals.

## Tactile noise cleanup (1.1.4)

The 8× RGB-difference display amplified low-level background fluctuations into colored speckles. The new shared spatial filter averages absolute RGB-change energy on a grid of at most 160 cells on its longer edge, smooths neighborhoods, estimates the lower-distribution background spread, and retains connected regions with a stronger core. Region size and core size scale with the grid. Threshold caps preserve broad strong changes. A feathered mask is applied before display gain. Suppressed pixels are exactly opaque white.

Cleanup is enabled by default and can be disabled in each tactile panel's display settings. Its reference never adapts to subsequent frames, so held changes remain visible, and seeking or changing display settings does not leave history-dependent traces. Original tactile videos and numeric channels are unchanged. Native and software workers and the temporary settings redraw share `src/tactileFilter.ts`; no runtime image-processing dependency was added.

Five new regression cases cover isolated bright pixels, diffuse noise at 16× gain, concentrated and equal-mean color changes, held contact and release, seek-order independence, source immutability, unfiltered RGB parity, broad strong changes, odd frame sizes, and invalid dimensions (24 JavaScript cases total). The TypeScript/production build passed.

A sample check processed 56 tactile frames from all four sensors in NAS episode 0066. All 36 frames selected as open-gripper checks became exactly white. All ten selected left-gripper grasping frames retained more than 100 strongly changed pixels; representative contact regions occupied approximately 4–10% of the left sensor image. Forty of the 56 sampled outputs were entirely white. These are checks on specific supplied frames, not a claim of perfect physical contact detection for every recording.

In isolated Chrome software decoding, all four open-gripper channels at 2 seconds were exactly white. At 10 seconds the two left channels retained 5,480 and 4,537 pixels with intensity change of at least 80, while the two right channels stayed white. Disabling cleanup restored the original unfiltered formula pixel-for-pixel (over 226,000 changed pixels per sensor at 2 seconds). Gain changes at 1×/16×/8×, changing cleanup during playback, expansion, repeat seeking, returning to a white background, and English/Chinese settings passed. The source image stayed unchanged when cleanup was toggled.

Firefox native decoding independently passed clean-background, concentrated-change, and unfiltered pixel-parity checks. Its subsequent 30-second run advanced 30.17 seconds in 30.16 seconds, with zero busy samples, zero synchronization status changes, no automatic seeks, and no runtime errors. Native counters reported 905–906 frames and zero dropped frames per channel; callback sampling is a separate measurement.

The 30-second Chrome software-decoder run advanced 29.83 seconds in 30.05 seconds, with all busy samples limited to startup at episode time zero. Channels displayed 894–896 frames, with zero or one skipped source frame per channel. No repeated synchronization pauses or runtime errors occurred. The 95th-percentile decoder batch time was 43.4 ms, and normal playback performed no pixel readbacks or filtering on the UI thread. Evidence: `artifacts/playback-profile/clean-chrome-folder.json` and its raw samples.

All eleven original-data browser regression groups also passed with cleanup enabled: UMI TAR and ARX5/UMI folders, the 152-episode local library, every playback speed, endpoint/rapid seeks, fixed-reference repeatability, decoder cleanup, and mixed-frame-rate H.264. Evidence: `artifacts/direct-browser/results.json`.

Evidence: `artifacts/tactile-clean/filter-results.json`, `artifacts/tactile-browser/results.json`, `artifacts/firefox/clean-native-folder-cleanup.json`, and `artifacts/firefox/clean-native-folder.json`, plus adjacent screenshots. Runtime checks use isolated browser profiles. Validation frames and reports are excluded from the customer ZIP.

Cleanup deliberately suppresses very weak, small, or diffuse changes. The unfiltered switch remains available for inspection. Spatial image change cannot distinguish all possible lighting/motion artifacts from physical contact; this is a visualization filter, not a contact classifier or a force estimate. It retains the existing first-frame-reference convention.

## Raw capture timestamps (1.1.3)

The operator confirmed that these ARX5 demonstrations are recorded by physically guiding the arms. Training preparation intentionally pairs observations with following actions. Across all five supplied NAS episodes and all 35 camera/tactile video channels, `timestamps.csv` equals `timestamps_raw.csv` without its last row. The complete raw timestamp count matches the actual MP4 frame count, with valid nonnegative, monotonic values. This is an intentional training convention, not evidence that the recording lost a timestamp.

The direct reader now prefers a complete, valid `timestamps_raw.csv`, then tries `timestamps.csv`, and only estimates alignment if neither is usable. No timestamp is added, shifted, or changed. Existing state/signal reading and training action files are unaffected.

Three additional regression cases cover raw capture timing with shortened training rows, absent/invalid raw-file fallback, and genuinely incomplete timing that must remain estimated (19 JavaScript cases total). TypeScript and the standalone production build passed. The real source reader matched all 35 channels to every raw timestamp. The original six-channel UMI TAR also loaded with capture alignment and both trajectories.

In isolated Chrome, all five ARX5 episodes displayed “Timestamp alignment” through both the folder and TAR paths; the four notices about empty numeric tactile channels remained. The original UMI TAR, playback, and seeks to the middle, end, and beginning passed. The test TAR was rebuilt from the existing extracted files because the original NAS TAR had been removed. Source recordings were read only. No uncaught page exceptions or outgoing page requests occurred.

The 30-second Chrome software-decoder folder run advanced 29.82 seconds in 30.11 seconds, with only startup buffer fill and no subsequent synchronization pauses. Channels displayed 894–895 frames, with zero or one skipped source frame. With raw capture timing, the observed 95th-percentile frame gap was approximately 50 ms; capture timing and screen refresh need not produce identical frame intervals.

The 30-second Firefox native folder run advanced 30.05 seconds in 30.05 seconds, with zero busy samples, zero status transitions, no automatic seeks, and no runtime errors. Native video counters reported 902–903 frames and zero dropped frames per channel; sampled frame callbacks are a separate measurement and do not prove every frame reached the screen.

Evidence: `artifacts/alignment/source-check.json`, `artifacts/alignment-browser/results.json`, `artifacts/playback-profile/raw-timestamps-chrome-folder.json`, and `artifacts/firefox/raw-timestamps-native-folder.json`, with screenshots and raw playback samples alongside the reports.

## Firefox timing and tactile contrast (1.1.2)

The follow-up report was reproduced in Firefox 154.0.1 using the same seven-stream NAS sample. With the software decoder, version 1.1.1 changed between Playing and Synchronizing 81 times in 30 seconds. A separate native-video test inserted a 180 ms UI delay every 2.5 seconds: the old clock triggered 833 video seeks across the seven streams and advanced only 20.1 seconds during 25.3 seconds of wall time.

The shared clock now retains elapsed time across UI delays. Native playback corrects small drift through bounded playback-rate adjustment, with seeks reserved for explicit navigation or large drift. Software playback continuously decodes ahead, including while paused, and fills a reserve before resuming after an underrun. Its queue targets 1.2 seconds and is bounded by frame count and an approximate 64 MiB image budget per stream (plus the current decode batch). Decoded YUV frames stay inside WASM, and redundant per-frame tactile copies are removed.

Image change now defaults to 8× display gain, adjustable from 1× to 16×. The first-frame reference and recorded imagery stay unchanged. Software buffers retain only display images; gain changes use the original reference to redraw any frames already buffered at the previous gain.

The final 90-second Firefox software-decoder folder run advanced 91.2 seconds in 91.2 seconds of wall time, with zero busy frames or status changes after opening. Sampled presentation was approximately 29 FPS; occasional source frames were skipped, so this is not a claim of zero dropped frames on every browser or computer. In the native Firefox UI-delay regression, the fixed viewer advanced 25.1 seconds in 25.1 seconds, with zero synchronization interruptions and zero automatic seeks (the old build issued 833). Native video counters reported 753 frames and zero dropped frames per channel.

The final Firefox native TAR run advanced 60.1 seconds in 60.1 seconds of wall time with zero busy frames, zero status changes, and no automatic seeks. Native counters reported 1,803 frames and zero dropped frames per channel; the separately sampled frame-callback cadence can be lower than the native presentation counter.

A 60-second Chrome folder run displayed 1,795–1,796 frames per channel (approximately 30 FPS). The only busy samples were during the initial buffer fill, at episode time zero; there were no synchronization interruptions after startup. The 95th-percentile frame gap was 36.2 ms. Five channels skipped one source frame; two skipped none.

The forced-software TAR stress run still had two later buffering intervals (four status transitions) in 60 seconds. At that time the shared 15 GiB machine had about 2.7 GiB available memory and almost all of its 8 GiB swap in use; seven batch replies were delayed together by about 1.07 seconds. That observation is consistent with resource pressure, but does not prove it was the only cause. The improvement removes the original repeated micro-stalls; it cannot guarantee uninterrupted seven-stream software decoding under all loads. The viewer continues to prefer native video when the browser supports the codec.

Evidence for this follow-up: `artifacts/firefox/baseline-software.json`, `baseline-native-jank.json`, `fixed-native-jank.json`, `reserve-software-folder.json`, `release-native-tar.json`, `release-software-tar.json`, and `artifacts/playback-profile/clock-chrome-folder.json`, with raw samples beside the reports.

The original NAS TAR was removed from Downloads during the follow-up validation. The final archive checks use a temporary TAR containing the existing extracted files, with the same `verified/` hierarchy. No source recordings were changed.

The Firefox folder test supplies actual files through WebDriver and assigns the relative paths normally supplied by the folder picker, because Gecko's WebDriver endpoint rejects directory paths. This exercises the real folder reader and playback; it does not automate the operating-system picker. Firefox and Chrome tests use isolated temporary profiles.

## Previous NAS rendering optimization (1.1.1)

The reported sample, `Downloads/task-e7244f5d-part-01-of-01.tar`, contains five ARX5 episodes of 离心管分拣_双臂. Each episode has seven 30 FPS HEVC streams: three 640 × 480 cameras and four 640 × 360 tactile videos. All five opened and played directly from the archive. In each 2.4-second check, playback advanced 2.38–2.40 seconds and displayed 72–73 frames on the measured camera.

Profiling identified repeated tactile canvas readbacks, pixel comparisons, and full trajectory reprojection on the UI thread. The decoder buffers were not starving. The first 12 seconds of the overview video also had no identical consecutive decoded frames. The fix computes tactile differences in workers, transfers display-ready image bitmaps, closes consumed/discarded bitmaps, bounds decode batches, and caches trajectory geometry and completed trail segments. Native video tactile processing also runs in a worker where the browser supports it.

A 12-second, seven-stream comparison used isolated headless Chrome with GPU acceleration disabled, a 1366 × 900 viewport, 1× playback, and JS CPU profiling enabled:

- Before: 360 displayed frames per channel, but uneven intervals; 95th-percentile frame gap 52.9 ms and maximum 95.6 ms.
- After: 360 displayed frames per channel, zero skipped source frames, no buffering pauses, 95th-percentile gap 36.9 ms and maximum 55.9 ms. No main-thread long tasks or repeated `getImageData`/`putImageData` calls occurred during steady playback.
- With Chrome's artificial 4× CPU slowdown, effective display rate improved from 12.7 to 24.8 FPS, and 95th-percentile gaps fell from 135.8 to 70.5 ms. This stress case still dropped frames; these measurements do not promise 30 FPS on every computer.

Additional browser checks compared every tactile RGB output pixel against the fixed-first-frame formula at 1× and 8× gain. Native and software paths passed, including seeking and expansion. Cached motion rendering was inspected in normal and expanded views. Original UMI/ARX5 folders, six-stream UMI TAR playback at all speeds, rapid seeks, decoder cleanup, and the 152-episode local-data library also passed again. No outbound page requests or uncaught page exceptions occurred.

Evidence: `artifacts/smooth-browser/results.json`, `artifacts/playback-profile/baseline.json`, `final.json`, `baseline-4x.json`, and `bitmap-4x.json` (the latter files are also in `artifacts/playback-profile/`). Raw frame samples, CPU profiles, and screenshots are alongside them. Results are local measurements, not a cross-platform benchmark; artifacts and recordings are excluded from the customer release.

## Original data

- `Downloads/episode_0012_20260807-131606_yanqiang_umi_none.tar`: all six original HEVC streams decoded inside the viewer, alongside trajectories, gripper signals, and tactile differences. No extraction or preprocessing was required.
- Original UMI `store_slippers_UMI` episode 0043 and ARX5 `pack_dental_instruments` episode 0060 folders opened directly, with six and seven video channels respectively.
- Selecting `QualityCheck/local-data` discovered 152 episodes. Episode search, selection, playback, and switching back to a TAR were exercised.
- Six-stream software playback passed at 0.25×, 0.5×, 1×, 1.5×, and 2×. In a 1.5-second test interval, recorded time advanced approximately 0.37, 0.75, 1.48, 2.22, and 2.95 seconds respectively.
- Seeking to 51.7 seconds placed all six streams within one source frame. Both endpoint seeks, forward/backward frame stepping, tactile panel expansion, and repeat seeking passed. Fixed-reference tactile difference pixels remained identical after returning to the same time.
- Rapid successive seeks finished on the latest requested frame. Switching sources terminated previous decoder workers, leaving exactly six active workers for the six-channel archive.
- Forced software H.264 playback also passed with mixed 15/30 FPS streams and a 100 ms capture offset.
- English/Chinese layouts were inspected at laptop and desktop sizes.

## Regression checks

- Production Vue/TypeScript check and standalone HTML build passed.
- Sixteen JavaScript cases cover timing, differences, TAR checksums/truncation/path handling, PAX/GNU names, CSV parsing, UMI references, folder discovery, empty tactile data, and malformed-channel isolation.
- Eight existing Python preparation tests passed for compatibility; Python is not used by direct opening.
- Fourteen native/prepared browser scenario groups passed, including native H.264 playback, prepared package compatibility, mixed 15/30 FPS alignment with a 100 ms offset, all playback speeds, missing/corrupt channels, malformed prepared data, signal-only episodes, and repeated switching.
- No uncaught page exceptions or outbound page requests occurred. The dependency audit found no known vulnerabilities after compatible build-dependency updates.

Evidence: `artifacts/direct-browser/results.json`, `artifacts/browser/results.json`, and adjacent screenshots. These artifacts contain local validation metadata and are excluded from the customer release.

## Limits

Firefox 154.0.1 and Chrome 152.0.7977.64 were tested on Linux. Windows/macOS and Edge were not directly tested in this environment. The fallback uses ordinary WebAssembly workers and does not require native HEVC support, a server, SharedArrayBuffer, or browser plugins. Performance still depends on the computer, recording dimensions, and number of channels.

Original samples whose raw and processed timestamp files both lack a valid timestamp per video frame show estimated alignment. The intentional one-row training difference in the supplied ARX5 samples is handled through their complete raw timestamps. The viewer does not alter the source timestamps or claim that estimated alignment is exact. Tactile differences represent image changes, not calibrated physical measurements.

The direct archive reader supports plain `.tar`, not compressed `.tar.gz` or ZIP files. Original video codecs supported by the bundled fallback are H.264 and HEVC.

## Repeat

```sh
npm test
npm run test:python
npm run build
node tools/browser-direct.mjs
node tools/browser-smooth.mjs
node tools/browser-tactile-clean.mjs
node tools/browser-live-tactile.mjs
RDV_SECONDS=60 node tools/profile-playback.mjs final
python3 tools/browser-firefox.py --software --seconds 90 --check
node tools/browser-check.mjs --fixtures /path/to/fixtures --package /path/to/prepared/package
```

The live tactile Firefox regression is `python3 tools/browser-live-tactile.py --source /path/to/task-folder --seconds 24 --touch-delay-ms 160 --check`; pass a viewer/profile directory accessible to Firefox if its installation is sandboxed. The Chrome live regression uses the same ARX5 task (`RDV_ARCHIVE` overrides its folder/TAR path).

The tactile cleanup browser check uses the supplied five-episode ARX5 folder (`RDV_FOLDER` can override its path). Firefox accepts `--tactile-clean-check` for the same episode's native rendering checks.

The capture-timing check can be repeated with `RDV_ARCHIVE=/path/to/rebuilt-task.tar node tools/browser-alignment.mjs`; it expects the five supplied NAS episodes and their extracted folder, plus the original UMI TAR. The Firefox check accepts `--expect-capture-timing` to require the recorded-timestamp badge.

The direct browser script uses this workspace's named original samples. The smooth-playback and profiling scripts default to the named NAS sample; set `RDV_ARCHIVE` to another compatible seven-stream task archive. Run performance profiling without other tests competing for CPU. All browser scripts use isolated temporary profiles, never a personal browser session.
