# Validation

## Portable 1.2.1: exclude the optical rim (final revision)

The user identified bright arc-shaped responses dominating the useful tactile
changes. The detected curve follows the **outer** optical rim; the old 14-pixel
horizontal inset did not exclude the full rim, particularly at its sloping ends.
The final display mask uses a **56-analysis-pixel Euclidean inward band** plus the
existing three erosion iterations. Endpoint continuation prevents small crescent
leaks at the top/bottom image boundaries. This guard is measured in the canonical
640×360 image and maps to the original frame without cropping or changing its
orientation. The region stays fixed throughout playback and settings changes.

The exclusion is applied before smoothing and after coloring, including Show all
changes. Detection, neighbor matching, baseline/noise statistics, gain, gamma and
coloring are unchanged. The calibration cache revision is advanced to reject old
masks. Strong interior contact is preserved, rather than globally reducing gain or
suppressing bright response values. Neighbor recovery rebuilds this same inner mask
from the current episode's foreground.

All 52 local baselines still pass. The 11 detector and 7 borrowed-mask NumPy goldens
were regenerated for the new mask geometry; fitted curves and confidence remain
unchanged. A new regression draws a bright, moving 50-pixel-wide rim around the
whole arc and requires opaque black output with smoothing both on and off. A
separate saturated interior patch retains its original color. Unit tests pass all
12 files, Python tests all eight cases, and the production build passes. Evidence:
`artifacts/rim-exclusion/{oracle,unit,python,baselines,build}-final.log`.

The reported 0157 recording was checked from the extracted final ZIP: cold joint
startup **1614 ms**, cached **666 ms**, with all four tactile panels visible.
Forcing every local arc result to fail requires actual neighbor recovery: cold
**1901 ms**, cached **733 ms**. The latter run also passes rapid seeks/stepping,
paused gain/Show all changes, rate changes, donor-cache reuse, different episode
orders, source replacement and cancellation during a delayed probe. Each sensor
samples exactly eight donor frames, and cached returns add no donor probes or
calibration work. Normal English and expanded Chinese views were inspected: the
bright arc is gone, with the interior image response retained. Evidence:
`artifacts/firefox/rim-final-{reported,recovery}.json`.

Forced-software playback from the parent folder passes at **1870 / 750 ms**
cold/cached; compatibility playback from TAR passes at **1954 / 617 ms**. All four
final-mode runs advance **5983–6001 ms in 6011–6016 ms**, with **680–718 tactile
paints** across four panels in six seconds. Host endpoints recorded **1723–3045 MiB
available RAM**, essentially full 8 GiB swap, and ten-second full-memory-stall
pressure **0–1.02%**. No other applications were stopped; browsers, builds and tests
ran serially. Earlier memory-pressure timing failures remain documented below;
these measurements are not a guarantee under arbitrary system load. Evidence:
`artifacts/firefox/rim-final-{reported,recovery,software,compat}.json`.

On identical episode-0157 inputs at six seconds, yellow/white rim pixels
(R ≥235, G ≥150) decrease **2433 → 0** and **2639 → 0** on the two left sensors.
Interior pixels beyond the eight-pixel blur footprint remain byte-identical.
Across all 52 baselines, the inner mask retains **88.5–90.8%** of the previous mask
area; all fitted curves and confidence values are unchanged. The final masks for
0156, 0157 and 0159 match the independent Python mask construction with **zero
pixel mismatches**. Representative responses from all 12 existing capping,
folding and sorting channels were also inspected. Evidence:
`artifacts/rim-exclusion/{before-after.png,response-final.log,local-contact-check.jpg,mask-oracle-final.json}`.

The final compatibility pixel/control suite with 120 ms delayed rendering replies
passes: identical inputs/models produce zero byte mismatches, outside-only changes
stay opaque black, and Show all changes never exposes the rim. Synthetic playback
has zero buffering samples and continued tactile updates. Evidence:
`artifacts/rim-final-pixels/results.json`.

**Final delivery:** `dist/RobotDataViewer-1.2.1.zip` (also `RobotDataViewer.zip`),
**20,243,766 bytes**. ZIP CRC and SHA-256 checks pass. The extracted viewer matches
the production build, packaged source files match the workspace, and rebuilding
those packaged sources reproduces the viewer byte for byte. No recordings,
diagnostics or credentials are included. Evidence:
`artifacts/rim-exclusion/{portable-integrity-final.json,source-build-final.log}`.

SHA-256: `141127439ab98453a6967c8a6f889f6575d04cb345ec3dfbddd28b462b2a38fb`.

The following recovery-candidate section is historical evidence from before this
requested mask refinement. Its masks, package hashes and package timings describe
that earlier candidate; the final package and measurements are recorded above it.
Historical failed runs remain failures.

## 1.2.1 recovery candidate, before rim exclusion (2026-09-28)

The local detector is unchanged for successful fits. A failed fit retries the full
reference search envelope before consulting up to four matching neighboring
recordings. Matching uses task, operator, robot, sensor channel, dimensions and
collector identity; missing identities require a shared recording session. The
selected episode's grayscale median and noise estimate are never borrowed. Only
independently validated curves and compact rim descriptors are reusable. Borrowed
masks use the current image's foreground component, inward margin and erosion.
Both the initial heatmap and subsequent rendering enforce that resolved mask.

Donor probing runs inside the existing two-job calibration scheduler. Each probe
uses a separate demuxer/decoder context in the same worker and reads at most eight
opening grayscale samples, without rewinding the selected decoder or loading any
neighbor RGB/trajectory data. Model and geometry entries share the 32 MiB LRU.
Source replacement cancels probes and clears both. Failure results are not cached.
A borrowed result cannot become an independent donor. The native capture path
creates a temporary probe worker only when it needs one, then releases it.

### Numerical and local-image checks

All **40 charger-task baselines** (episodes 0151–0160, four sensors each) and the
previous **12 capping/folding/sorting baselines** pass. A direct comparison against
checkpoint `e6ecf85` confirms all **49 previously successful detections** retain
byte-identical curves/masks and identical confidence. Contact sheets of all 52
masks were inspected: the right sensing surface is retained, while neighboring
rims and the outer background remain excluded. The previously failing right-hand
left sensor in **0156, 0157 and 0159** is recovered by the broader search, with
confidence **0.91457 / 0.91608 / 0.91550**. Each of these masks matches the independent
NumPy reference exactly; maximum curve difference is **0.000031 analysis pixels**,
well below the one-pixel tolerance. Evidence: `artifacts/region-validation/` and
`tools/check-region-baselines.mjs` (requires the local ignored baseline samples).

The broader fit now reuses candidate-row buffers instead of allocating a point
object for every supported row of every candidate. Existing successful fits and
numerical goldens remain unchanged. Eleven detection oracle cases cover curved and
neighboring rims, biased anchors, straight/weak/noisy edges, blank images, contact
and odd dimensions. Seven independent NumPy transfer cases check exact borrowed
masks, contrast changes, partial occlusion, remounting/shift, blank inputs and
vertical support. Unit tests also cover identity conflicts, missing IDs, sensor
channels, dimension filtering, four-candidate bounds, corrupt/absent donors,
short clips, unchanged inputs, stale cancellation, cache eviction/source lifetime,
non-transitive borrowing, and zero outside response with smoothing or Show all
changes. Actual worker orchestration tests verify separate donor contexts, eight
samples, short EOF, resource release and unchanged selected-decoder position.

`npm test` passes **12 files**, serially. `npm run test:python` passes **eight tests**.
`npm run build` passes type checking and produces the self-contained 1.2.1 viewer.
Evidence: `artifacts/region-{unit,python,build}-final.log`.

### Final portable playback and recovery checks

The extracted **1.2.1 ZIP's actual `viewer.html`** was opened in isolated Firefox 156,
with episode **0157 selected first** from the charger TAR or its extracted parent
folder. Tests deliberately forced all four local calibration replies to fail arc
detection, so successful panels must actually borrow validated neighbor geometry
before staging. This is stronger than merely observing that the broader fit now
works. The reported sensor, right-hand/left, borrowed episode **0158** successfully.

- Default native-RGB/sequential-tactile path, TAR, three cold starts:
  **1871 / 1787 / 1804 ms**; cached **586 / 638 / 637 ms**.
- Forced software for all seven channels, parent folder: **1777 ms** cold,
  **821 ms** cached.
- Compatibility pixels (OffscreenCanvas and createImageBitmap disabled), TAR:
  **1898 ms** cold, **521 ms** cached.
- Optional `?nativeTactile=1` diagnostic path: **3599 ms** cold, **323 ms** cached.
  It completes recovery and playback, and releases all four temporary probe
  workers, but **fails the three-second cold-start target**. H.264/HEVC tactile
  recordings use the faster sequential path by default.

Without fault injection, the reported 0157 episode starts in **1427 ms** cold and
**589 ms** cached. Its right-hand/left sensor uses the broader fit; the other three
retain their original local fits. An **18-second** run advanced **18017 ms in
18032 ms**, with **2160 tactile paints** and no preparation/reveal errors. Endpoint
available RAM was **1776–2778 MiB**, full-memory-stall pressure **0.08–0.40%**.
Evidence: `artifacts/firefox/region-portable-reported.json`.

Every successful run requires seven panels, the selected episode, a current-generation
staged tactile frame from all four sensors and simultaneous reveal. RGB and the
clock remain held until readiness. Every cached return has exactly four model
cache-hit events, no calibration start/sampling/fitting, and no additional donor
probe. Startup has zero selected-decoder rewinds. Steady workers are four (seven
with software RGB). Default eight-second playback advanced **7983–8001 ms in
8013–8018 ms** with **955–957 total tactile paints**. Software/compatibility six-second
playback advanced **6000 / 5983 ms** with **668 / 716 paints**, respectively. No page
errors or partial reveal were reported. Normal English and expanded Chinese views,
including recovery badges and the excluded black region, were visually inspected.
Evidence: `artifacts/firefox/region-portable-{neighbor,software,compat,native}.json`.

The passing portable runs recorded **1342–3023 MiB available RAM**, essentially
full 8 GiB swap on this 15 GiB host, and ten-second full-memory-stall pressure of
**0.03–0.79%**. Tests and builds were serial; no existing applications were closed.
Timings run from episode selection through joint presentation, including metadata,
calibration, probing and frame preparation. Folder/TAR indexing precedes this startup interval.

The dedicated forced-recovery control run completed cold/cached preparation in
**2046 / 581 ms**. It verifies rapid seeks, stepping (target 2504 ms; all tactile
frames 2500 ms), paused gain and Show all changes, rate changes, and different
browsing orders. Episodes 0154 and 0156 reuse cached independently detected donor
0155 geometry without new donor sampling. Source replacement clears that cache;
interrupting actual donor probes with delayed replies then switching episodes
releases obsolete workers and preserves queued Play cancellation. The final
selection returns to 0157 successfully. Evidence:
`artifacts/firefox/region-controls-session.json`.

The existing delayed-start/control browser suite also passes on this build:
five-second calibration delay holds RGB and the clock, settings/seek replies stay
current, four cache hits require no additional fitting, native RGB fallback
re-enters readiness, and synchronous canvas, redraw and pre-registration worker
failures remain panel-local. The browser made no network requests and raised no
page errors (`artifacts/region-joint-controls/results.json`).

The compatibility pixel/control suite reports **zero byte mismatches** and **zero
nonblack excluded pixels** on identical decoded inputs and models, including
settings changes during staging, gain, Show all changes, repeated seeks and
outside-only contact. Synthetic playback advanced **6200 ms in 6199.7 ms**, with
zero buffering samples, **191 paints per sensor** and visible contact in **10/10**
sampled contact moments (`artifacts/region-pixels-compat-checked/results.json`).
Its first attempt (`region-pixels-compat/results.json`) had an instrumentation
failure: the live counter watched only `drawImage`, while compatibility paints
through `putImageData`. Both APIs are now counted; the first run remains failed.

The bitmap software pixel/control run, with **120 ms delayed rendering replies**,
also has zero pixel/outside-mask mismatches and no page/network errors. It advances
**6200 ms in 6199.9 ms**, with zero buffering samples, **191 paints per sensor** and
visible contact in **10/10** samples. Evidence:
`artifacts/region-pixels-software/results.json`.

A final instrumented portable cache check measured **1968 / 589 ms** cold/cached.
It requires exactly **four donor probes**, exactly **eight sampled donor frames per
sensor**, and **no additional donor probes** on cached return, alongside the four
model cache-hit events (`artifacts/firefox/region-portable-cache-check.json`).

### Portable package integrity

`dist/RobotDataViewer.zip` is **20,240,298 bytes**, version **1.2.1**. ZIP CRC checks
pass, and the extracted viewer is byte-identical to the production build. The app
source archive contains the new recovery implementation; the distribution includes
both quick starts, notices, decoder sources and rebuild instructions, and contains
no recordings, diagnostic artifacts, credentials or installed dependency directory.
Evidence: `artifacts/region-portable-integrity.json`.

SHA-256: `61ed410a71520f648a6aefa34a177826023cb7d9146aa835be2686c937856deb`.

### Timing failures retained

A pre-allocation-fix normal series measured cold **1484 / 1455 / 1467 / 1358 /
5491 ms**, cached **600 / 642 / 650 / 635 / 822 ms**. The last cold start failed the
three-second target, at about **715 MiB available RAM**, full swap and **7.11%**
ten-second full-memory-stall pressure. The five-run final-code normal series also
**failed** its performance gate: cold **6850 / 9242 / 1417 / 1484 / 1439 ms**, cached
**4983 / 1005 / 591 / 635 / 677 ms**. Functional joint readiness and continued
playback completed, but the slow repetitions are not passes. The allocation change
therefore does not establish a universal three-second guarantee under host memory
pressure. Evidence: `artifacts/firefox/region-broader-{five,final}.json`.

A pre-allocation-fix forced-neighbor series completed five cold starts in **1997 /
1912 / 1788 / 1922 / 1816 ms**, cached **670 / 682 / 623 / 750 / 655 ms**, with all four
sensors borrowing episode 0158 and six-second playback advancing 5983–6017 ms.
Its per-run `hostBefore` fields were overwritten by a harness variable error;
global before and per-run after memory snapshots are valid (after: 1070–1199 MiB
available). These are candidate-build measurements, not final-package timings.

Harness failures are preserved separately: `region-neighbor-smoke.json`
selected 0151 because an isolated JavaScript realm's sort was patched instead of
`window.Array`, so it is not evidence for opening 0157 first. `region-controls-final.json`
completed actual frame preparation but its wait lost staged paint marks when the
app's bounded diagnostic history cleared. The corrected harness records actual
staged acknowledgements independently and counts every paint, while still requiring
the selected episode, expected panel count, current generation and simultaneous
reveal. Two further control-harness attempts (`region-controls-checked.json` and
`region-controls-isolated.json`) used incorrect fixture assumptions for donor-cache
reuse: the first-selection sort override initially affected later donor ordering,
and 0159 actually prefers 0160 by capture time, not 0158. The override now restores
the original sort immediately after initial selection, and the cache check uses
0154/0156, whose actual nearest donor is 0155. None of these failed harness runs is
counted as a passing control run.

## Portable 1.2.0: sequential tactile startup (2026-09-28)

The portable viewer now keeps native RGB playback where available and selects the
bundled sequential decoder for H.264/HEVC tactile panels before any video element
is mounted. Two calibration jobs run alongside camera buffering. Opening grayscale
samples seed playback rather than being decoded a second time; the first frame and
0.65-second reserve are prepared before joint reveal. Tactile frames transfer only
grayscale source data and the response image. Paused settings reuse the decoder
worker. A compiled WebAssembly module is shared across workers with a byte-based
fallback. The fixed baseline, noise statistics, arc mask and color calculation are
unchanged; no raw placeholder or early camera playback was introduced.

### Investigation and measured startup

The former Firefox path performed 240 calibration seeks across four sensors.
Measured seek time was 781–895 ms per sensor, plus 166–240 ms of sampling replies
and 218–373 ms of statistics/arc processing. A native run took 2,641 ms cold, while
a later resource-constrained run took 7,870 ms. A test-only mixed-path experiment
reached 1,617 ms cold / 999 ms cached; it was feasibility evidence, not a release
acceptance run. Firefox 156 on this host exposes VideoDecoder but reports the
recordings' HEVC configuration unsupported, so the optimization does not depend on
WebCodecs HEVC availability or changing the user's browser settings.

Repeated episode-selection-to-joint-reveal measurements in Firefox 156, including
metadata and cold calibration, are:

- Capping, six streams, five cold starts: **1,224 / 1,147 / 1,153 / 1,315 / 1,163 ms**.
  Cached returns: **635 / 641 / 688 / 621 / 628 ms**.
- Folding, six streams, five cold starts: **1,389 / 1,213 / 1,228 / 1,188 / 1,192 ms**.
  Cached returns: **654 / 608 / 653 / 631 / 653 ms**.
- Sorting, seven streams, five cold starts: **1,344 / 1,180 / 1,461 / 1,701 / 2,290 ms**.
  Cached returns: **619 / 773 / 785 / 726 / 735 ms**.

All 15 repetitions in the completed acceptance runs satisfy the 3,000 ms limit. Every run requires the
expected panel count, selected episode, current generation, accepted tactile frame
acknowledgements and joint reveal. No clock/RGB movement precedes readiness.
Telemetry verifies zero startup rewinds, 60 baseline samples per sensor, no native
tactile video elements, four workers, and four cache hits with no new sampling or
fitting on every cached return. Initial folder/TAR indexing is outside this
selection-to-presentation measurement and is not hidden inside the reported times.

One earlier sorting repetition **failed** at **3,036 ms** after four 1,236–1,366 ms
starts. Available RAM declined from about 1,800 to 593 MiB across navigation-heavy
runs. The harness had created additional viewer history entries between cold runs;
the final sorting check refreshes the same entry to avoid retaining prior viewer
documents in browser history. The failure is preserved in
`artifacts/firefox/fast-sorting-startup.json`; it has not been reclassified as a pass.
The new measurements are host-specific, not a guarantee under arbitrary resource
pressure. Passing repeated runs had **667–2,240 MiB available RAM**, essentially
full 8 GiB swap, and full-memory-stall ten-second averages of **0–3.01%**. No other
applications were closed. Only isolated test browsers were started and stopped.

### Playback from the portable ZIP

The final ZIP was extracted and its actual `viewer.html` used for each 24-second
Firefox playback test after the RGB bitmap-reuse and prepared-package fixes below.
All 12 local sensor baselines detected their sensing regions.

- Sorting advanced **23,717 ms in 23,712 ms**, with zero buffering samples,
  **717 paints per tactile panel**, and contact visible in **14/14** sampled
  moments on both active left sensors. Cold/cached startup: **1,379 / 653 ms**.
- Capping advanced **23,734 ms in 23,729 ms**, with zero buffering samples,
  **717 paints per panel**, and active contact visible in **4/4** sampled moments.
  Cold/cached startup: **1,312 / 602 ms**.
- Folding advanced **23,799 ms in 23,782 ms**, with zero buffering samples,
  **719 paints per panel**, and contact visible in **11/11** sampled moments
  on both right sensors. Cold/cached startup: **1,264 / 698 ms**.

There were no page errors in these runs. Evidence is under
`artifacts/firefox/fast-{capping,folding}-startup.json`,
`artifacts/firefox/fast-sorting-startup-final.json`, and
`artifacts/firefox/portable-final-{sorting,capping,folding}-live{,-raw}.json`.
The final ZIP runs had **1,187–2,315 MiB available RAM** at the recorded endpoints,
nearly full 8 GiB swap, and full-memory-stall ten-second averages of **0–0.24%**.
Earlier candidate-ZIP runs are retained as
`artifacts/firefox/portable-{sorting,capping,folding}-live-live{,-raw}.json`.

The synthetic pixel/control run (`artifacts/fast-pixels/`) produced **zero byte
mismatches** between displayed responses and the shared filter on identical
samples/models, including paused settings, staged seeks, gain changes, expansion,
Show all changes and outside-only contact. Continuous playback advanced 6,200 ms
in 6,199.8 ms, with zero buffering, 191 paints per panel and visible contact in all
ten sampled moments. Normal and expanded English/Chinese views were inspected.

`npm test` passes all **11 files**, including actual worker orchestration tests for
opening-frame reuse, no duplicate decode/rewind, short clips, seeks, cached starts,
and settings redraw ownership, plus the existing numerical/mask/cache/staleness
regressions. `npm run test:python` passes **eight cases**. Type checking and the
self-contained build pass.

Final forced-software and pixel compatibility startup checks also pass
(`artifacts/fast-startup-software-final/` and `artifacts/fast-startup-compat/`).
With five seconds deliberately added to each calibration job, RGB and the clock
remain held until all successful tactile frames are staged. Cached reopening
takes **124.2 / 145.9 ms**, respectively, with four cache hits and no new baseline
sampling or fitting. These runs cover queued Play cancellation, pause, seeks,
stepping, speed changes, delayed settings replies, rapid episode switches, source
replacement, cleanup and panel-local failures. The mixed-path check in
`artifacts/fast-startup-mixed/` also exercises native RGB decoder fallback.
The final offset fixture passes with 250–1000 ms channel offsets and 0.9–1.1
capture-time scales (`artifacts/fast-offsets/`): staged frames match the mapped
timestamp, delayed generations/settings are rejected, and cached readiness takes
**146.4 ms**. The retained native tactile compatibility path passes the same
startup/control/fallback/failure suite (`artifacts/fast-native-compat/`), including
the five-second calibration delay; cached readiness takes **112.5 ms**. All browser
runs are sequential. The isolated test browser/driver processes exited afterward.

The first forced-software run **failed** because restaging an already presented
RGB frame attempted to transfer its consumed ImageBitmap a second time. The
transport now acknowledges the existing RGB canvas when reusing that frame;
tactile frames still restage from their retained grayscale input. A focused unit
regression and the complete forced-software rerun pass. The failed report remains
in `artifacts/fast-startup-software/`.

Final checks additionally pass for three-frame clips (`fast-short`), injected
calibration failures (`fast-failure`), missing arcs through playback/settings/
expansion in both languages (`fast-missing-final`), and older prepared packages
whose manifests omit codec metadata (`fast-prepared`). The latter probe selected
tactile MP4 headers before mounting, so these packages use the same fast path.
The final compatibility pixel/control check (`fast-pixels-compat`) remains
byte-identical with ImageBitmap and OffscreenCanvas disabled. The earlier
`fast-missing` directory is an ordinary pixel run invoked with an incorrect flag;
only `fast-missing-final` supplies missing-arc evidence.

### Portable contents

`dist/RobotDataViewer.zip` contains version **1.2.0**, a self-contained viewer,
bilingual START_HERE and quick starts, format documentation, notices, decoder
sources and frontend rebuild inputs. It contains no recordings, test artifacts,
node_modules or customer sample files. Archive CRC checks pass; the extracted
viewer matches the built HTML byte for byte. `RobotDataViewer.zip.sha256` is supplied
beside the ZIP. Recipients extract the complete archive and open `viewer.html`;
no installation, server, Python, external codec or internet connection is required.
The shipped frontend source archive was extracted separately and rebuilt with the
installed locked dependencies. Type checking and the build pass, and the rebuilt
viewer is byte-identical to the distributed HTML (SHA-256
`f260fbd415120333339cbed732072d45f16dfa1f2f8032e12b711455b5bca217`).
Evidence: `artifacts/release-source-rebuild.log`.

## Synchronized RGB and tactile startup (2026-09-28)

RGB and tactile now stage their mapped current frames behind opaque preparation
overlays. The coordinator knows every expected channel before any decoder is
created. It holds the shared clock until every successful channel has acknowledged
its frame for the current playback generation, then reveals the views together and
releases queued Play on the next animation frame. Pause cancels queued Play. Seeks,
stepping, rate changes and native-to-software fallback re-enter the same barrier.
Failures are visible terminal exceptions, not missing entries in readiness.

Native automatic seek/pause rendering is detached during staging. A coalesced
staging request checks playback generation, captured source time, settings revision
and paint ordering before acknowledging readiness. This fixes the reproduced race
where an automatic seek render used an old gain while the staged render used the
new gain. Synchronous seek, buffer, canvas and renderer-construction errors are
contained within their panel. Failure callbacks are bound before worker creation;
even throwing cleanup cannot skip the notice or stop the other channels' clock.
Paused settings-worker construction is covered as well. The two-job calibration
limit, fixed filter/mask model and 32 MiB LRU cache remain unchanged.

### Deterministic checks

- Native, forced-software and RGBA compatibility startup checks pass with a
  five-second delay injected into each uncached calibration reply. Four tactile
  channels require two job waves: joint readiness takes **10,939 / 10,746 / 10,938
  ms**, respectively. During preparation there is no RGB playback or shared-clock
  advancement. These deliberately delayed times are not normal startup timings.
- Cached joint readiness takes **119 / 323 / 131 ms**. Play after readiness starts
  clock movement in **23 / 25 / 23 ms**. Every cache return records four hits,
  unchanged sampling/fitting counts and the expected worker count after reopening
  completes. Rapid switches and replacing the recording source release obsolete
  work; replacement clears cached models.
- Browser waits require the expected number of panels, the selected episode,
  current generation, per-channel readiness acknowledgements and actual tactile
  canvas paints. Delayed seeks/settings, queued Play cancellation, stepping, speed
  changes, fallback and synchronous canvas/worker failures pass. The additional
  paused settings-worker failure check passes in forced-software mode.
- Native and software offset fixtures pass with channel starts staggered by
  250–1000 ms and capture-time scales of 0.9–1.1. First rendered frames match the
  independently calculated mapped target within one source-frame interval; no
  future frame is admitted. Both paths also pass three-frame clips.
- Native, software and compatibility pixel/control checks pass, including a
  settings change during a staged seek with delayed replies. Identical decoded
  input/model pairs produce byte-identical displayed RGBA. All excluded pixels
  remain opaque black, including Show all changes and outside-only contact.
  Missing arcs and injected calibration failures remain visible while other
  channels continue. English/Chinese normal, preparation, settings and expanded
  views were inspected.
- Sustained synthetic software playback advances **6,200 ms in 6,199.7 ms**, with
  zero buffering samples, 191 paints per tactile panel and contact visible in all
  ten sampled contact moments.
- `npm test` passes all ten test files, including existing numerical/mask goldens
  and new staging/failure regressions. `npm run test:python` passes eight cases;
  `npm run build` and `git diff --check` pass. Unit files now run serially to reduce
  peak memory use. Browser tests and builds are run separately.

### Local recordings and host conditions

The seven-stream sorting recording reaches joint readiness in **1,655.6 ms cold /
853.7 ms cached** using Chrome software decoding, with no artificial calibration
delay. Its uninterrupted run advances **23,799 ms in 23,787.8 ms**, with zero
buffering samples, 719 tactile paints per panel and contact visible in all 16
sampled moments on both left sensors. There are no page exceptions or outbound
requests.

Firefox native decoding on the same recording, with tactile replies delayed
160 ms, reaches joint readiness in **3,028 ms cold / 495 ms cached**. Playback
advances **23,850 ms in 23,838 ms**, with zero buffering samples, 134–135 paints per
panel and visible contact in all 15 sampled moments on both left sensors. This
also verifies that useful delayed results continue painting rather than being
rejected merely because the playback clock advances.

The six-stream capping recording reaches native joint readiness in **2,831 ms
cold / 306 ms cached** and advances **23,816 ms in 23,803 ms**. It has zero
buffering samples, 600–604 paints per tactile panel and visible contact in all four
sampled moments on the active left-right sensor. The six-stream folding recording
reaches native joint readiness in **2,742 ms cold / 326 ms cached** and advances
**23,734 ms in 23,737 ms**. It has zero buffering samples, 600–604 paints per panel
and visible contact in all 11 sampled moments on both right sensors. These two runs
use normal render replies, without artificial delay. All 12 local tactile panels
across the three recordings prepare and continue updating; none reports a missing
arc or rendering failure.

Software joint startup also passes on the two six-stream recordings: capping
measures **1,786.9 ms cold / 807.7 ms cached**, and folding **2,077.7 ms cold /
910.8 ms cached**, without injected calibration delay. Both return four cache hits,
no new sampling/fitting and exactly six live workers after completed reopening.
Their 2.2-second continuation samples advance in real time; the full 24-second
software stress measurement above is specifically the seven-stream sorting run.

The interrupted implementation run produced no completed browser report and is
not counted as passing. A later sequential test wrapper exited with code 143 after
writing the native offset report; direct native and software offset reruns both
completed successfully and verified cleanup. The first new Firefox local run
failed in its reporting helper because timestamp rounding excluded the selection
mark. The filter now includes the exact selection timestamp; only the corrected
completed run is counted above. These harness interruptions do not establish a
viewer failure or a successful test by themselves.

At the earlier interruption the host had about **446 MiB available RAM**, full
8 GiB swap, and a **68%** ten-second full-memory-stall average. That is observed
resource pressure, not proof of the freeze's cause. The final deterministic startup
runs began with **2,869–2,932 MiB** available and ended with **1,966–2,314 MiB**;
full-memory-stall averages were 0–0.56%. All measurements are host-specific.
No user applications were closed. Historical failed software stress runs below
remain failures; the new successful run does not retroactively change them.

Evidence: `artifacts/joint-{native-final,software-hardened,compat-final}/`,
`artifacts/joint-pixels-{native,software,compat}/`, `artifacts/joint-short-*`,
`artifacts/joint-missing-software/`, `artifacts/joint-baseline-failure/`,
`artifacts/joint-offsets-{native,software}-final/`,
`artifacts/joint-real-software-{startup,capping,folding}/`,
`artifacts/live-tactile/joint-real-software-live*.json`, and
`artifacts/firefox/joint-real-native-{sorting-final,capping,folding}-live*.json`.

## Superseded camera-only startup experiment (2026-09-28)

Historical behavior, superseded by synchronized startup: camera readiness was independent of tactile calibration and catch-up. Two
background jobs at most prepare fixed baseline/noise/mask models; a 32 MiB LRU
cache reuses completed models for the same source Blob and decoding path. A private
seek and a buffered current frame admit each tactile panel without restarting the
shared clock. Catch-up releases expired frames without painting, and fails locally
after 30 seconds of unsuccessful work. Explicit seek generations and paint ordering
reject obsolete replies while retaining useful completed renders during playback.
Compatibility capture sends one RGBA frame per asynchronous worker request; median
statistics, arc fitting and filtering do not run on the UI thread.

The earlier `artifacts/startup-native/results.json` contains **invalid cache and
rapid-switch success claims**: its readiness predicate accepted an empty panel list.
Only that run's initial 30 ms Play measurement and continuous-update observation
were valid. Replacement checks require four mounted panels, four actual response
paints after the current episode selection, four cache hits, unchanged sampling/fit
counts, and the exact expected live worker count. The first real-recording attempt
also exposed a test selector that vanished during metadata loading; the corrected
run uses the persistent episode button. A short-clip attempt supplied a relative
fixture path and timed out before readiness; fixture paths are now resolved and the
native/software short-clip checks pass. Neither failed test attempt is counted as a
completed validation run.

- Final Chrome 152 deterministic startup checks inject a five-second calibration
  delay. Play-to-clock movement is **25.1 ms native, 98.7 ms software, and 21.6 ms
  compatibility**. Cold first-camera frames appear 78/336/79.5 ms after
  selection. All are below the
  one-second acceptance threshold. Tactile calibration remains visible for two
  delayed job waves, about 10.8–11.1 seconds in total, without holding the camera.
- Cached returns paint all four tactile maps within **131.2/361.3/144.8 ms** of
  selection respectively. All runs record exactly four hits, no additional baseline
  samples or fits, and 4/5/4 live workers after both cached returns and rapid reopen.
  Replacing the source invalidates the cache. First responses join the moving clock
  within one source frame; the second delayed pair joins at the stopped end of the
  eight-second clip. Controls, speed changes, expansion, both languages, and continued
  painting pass with zero page exceptions or outbound requests.
- Thirteen startup/cache/order unit cases and three actual decoder-lifecycle cases
  cover LRU eviction, Blob/path/parameter separation, detached copies, two-job
  scheduling, queued/running cancellation, full catch-up buffers, frame ownership,
  no future-frame paint, obsolete refill errors, seek/rate invalidation, offsets,
  short clips, timeout/disposal and idempotent failures. Existing NumPy/OpenCV
  numerical and sensing-mask goldens remain unchanged. `npm test` passes all ten
  test files; `npm run test:python` passes eight cases; `npm run build` and
  `git diff --check` pass.
- Native, software and compatibility pixel/control checks pass, including delayed
  native/settings replies, paused gain/Show all changes, frame stepping, repeatable
  seeks, expansion and English/Chinese text. Identical decoded inputs and captured
  models produce identical displayed RGBA values. Outside-only changes remain black.
  Three-frame recordings pass both decoders. Injected calibration failure and
  missing-arc cases remain confined to their panels; other channels keep playing.
  Normal, expanded and preparation views were visually inspected in both languages.
- Continuous synthetic software playback advances **6,200 ms in 6,199.9 ms**, with
  zero buffering samples, 191 paints per tactile panel and visible contact in all
  ten sampled contact moments.

On the local seven-stream sorting recording, Chrome software startup takes **208.4
ms from Play to clock movement**. Metadata loads in 130 ms; the three camera frames
appear 511–514 ms after selection, and all tactile panels join by 2,476 ms. Individual
calibrations take 406–484 ms. A cached return needs no fitting and paints all tactile
panels by 854 ms (camera frames by 483 ms). These are measured local timings, not
cross-machine guarantees.

Firefox 156 native playback on the same recording starts its clock in **139 ms**;
first cameras appear 321–335 ms after selection. With tactile render replies delayed
160 ms, all tactile panels paint by 3,423 ms cold and **585 ms cached**. Cached Play
starts in 20 ms. Uninterrupted playback advances **24,333 ms in 24,223 ms**, with zero
buffering samples, 129–130 tactile paints per panel, no page errors and visible
contact in all 15 sampled moments on both left sensors.

The corresponding real **seven-stream software stress check failed**: it advanced
15,083 ms in 26,222.9 ms with 19 buffering samples. All tactile maps continued to
update (167–170 paints), contact was visible in all seven observed contact moments,
and there were no page exceptions or outbound requests. This does **not** establish
smooth sustained software playback on this host. Memory available to that run fell
from 1,162 MiB to 395 MiB; the 8 GiB swap area was full, and the final 10-second full
memory-stall average was 18.93%. Resource pressure was observed, but has not been
proved the sole cause. The prior arc-change stress failure is retained below.

The host has 14.7 GiB RAM. Final synthetic startup runs began with 1,338–1,399 MiB
available and ended with 657–1,045 MiB; the native real-recording run went from
1,483 MiB to 820 MiB available. Browsers were run sequentially, each in an isolated
profile. No other applications were closed or source recordings modified. Full
`/proc/meminfo` and memory-pressure snapshots accompany the startup and real live
reports. Do not interpret the synthetic passes or fast camera startup as a pass of
the failed real software stress test.

Evidence: `artifacts/startup-{native,software,compat}-final/`,
`startup-controls-{native,software,compat}/`, `startup-controls-software-final/`,
`startup-short-{native,software}/`, `startup-failure-native/`,
`startup-missing-{software,compat}/`, `startup-real-software-final/`,
`artifacts/firefox/startup-real-native-live{,-raw}.json`, and
`artifacts/live-tactile/startup-real-software-live{,-raw}.json`.
Use `node tools/browser-startup.mjs` (forced software by default), `RDV_NATIVE=1`
for native and `RDV_NATIVE=1 RDV_COMPAT=1` for compatibility. The default delay is
5,000 ms; real measurements use `RDV_REAL=1 RDV_CALIBRATION_DELAY=0 RDV_FOLDER=...`.
`tools/browser-live-tactile.py --startup-check --check` measures native cold/cached
startup and uninterrupted real playback together. Keep browser runs sequential.

## Arc-masked sensing region (2026-09-28)

The fixed opening median now also calibrates a sensing mask. The bundled detector
ports FlawDetection's anchored curve fit, dominant foreground, 14-pixel inward
margin and three erosion iterations. Surface verification to the right of candidate
points and confidence/curvature gates reject the neighboring rim, straight edges
and bright blank images. The unchanged reference is documented under
`tools/reference/`; the original FlawDetection project was not modified.

- All ten synthetic detector goldens match the independent NumPy oracle's masks
  exactly, including odd dimensions, existing contact, neighboring rims and six
  rejection cases. Twelve detector/filter cases additionally check source-array
  immutability, one-frame calibration, deterministic repeated rendering, saturated
  changes immediately outside/inside the mask, Show all changes, return to baseline
  and opaque-black failure output. `npm test` passes all eight test files;
  `npm run test:python` passes eight cases; `npm run build` and `git diff --check` pass.
- All 12 real sensor baselines from the capping, folding and sorting recordings
  detect successfully. Every mask byte matches Python; the largest curve-coordinate
  difference is 0.000046 analysis pixels. Confidence ranges from 0.8950 to 0.9319;
  retained areas range from 79.65% to 82.36%. Standalone Node arc detection takes
  80.6–456.3 ms per 640×360 baseline (median 105.7 ms), once during calibration;
  this excludes decoding and median/noise estimation and is not a startup guarantee.
  All twelve mask overlays were visually inspected.
- With identical oracle masks and decoded inputs, 72 real frames differ from OpenCV
  in only 12 of 66,355,200 RGBA values, each explained by an adjacent pre-gamma
  quantization bin. The largest channel difference is 25 at the black cutoff.
  Every excluded output pixel is opaque black; repeated renders are byte-identical.
- Chrome 152 passes native, forced-software and synchronous compatibility controls:
  gain, Show all changes, paused redraw, frame stepping, repeat seeks, expansion,
  English/Chinese text and outside-only changes. Captured models reproduce displayed
  pixels exactly on their respective decoder paths. Three-frame clips pass native
  and software checks. Missing-arc fixtures leave one map black with the localized
  notice through settings changes and playback while the other channels continue,
  on all three paths. Native/software rapid episode changes during calibration,
  native replies delayed 160 ms, and an injected baseline failure also pass. All
  control runs report zero page exceptions and zero outbound page requests.
- The real capping recording passes Chrome software controls. Normal/expanded maps,
  English/Chinese settings and the black failure notice were visually inspected.
  The longer settings content exposed clipping in small cards; the popover now
  extends outside the card and its visibility is checked in both languages.
- Firefox 156 native playback with tactile replies delayed 160 ms advances 23,817 ms
  in 23,805 ms, with zero sampled buffering and zero page errors. Each map paints
  131–132 times; both left sensors show response in all 15 sampled contact moments.
  Completed tactile frames continue painting despite replies arriving slowly.

The real seven-stream Chrome software stress run did **not** pass on this host:
it advanced only 3,600 ms in 46,046 ms, with 18 busy samples, before reaching any
contact window. There were no page exceptions or outbound page requests. Host swap
was full and memory-pressure counters showed sustained stalls. A subsequent
profiling attempt timed out evaluating the page, with only 422 MiB available and
41% full memory stalls over the preceding minute. These observations limit the
real-recording software-performance result; they do not establish smooth playback
under memory pressure or prove that resource pressure was the only cause. No other
applications were closed and no source recording was changed. A later small-fixture
continuous-software check could not start Chrome (`Browser.getVersion` timed out
before the viewer loaded). At that point only 363 MiB was available and full memory
stalls averaged 45.8% over a minute. No isolated test browsers remained after cleanup.
The earlier synthetic software controls passed; the optional `RDV_LIVE=1` continuous
check is available for repeating on a host with sufficient resources.

Evidence: `artifacts/response-roi/{roi-results,results}.json` and
`mask-contact-sheet.jpg`; `artifacts/roi-native/`, `roi-software/`, `roi-compat/`,
`roi-short-{native,software}/`, `roi-missing-{native,software,compat}/`,
`roi-rapid-delayed/`, `roi-rapid-software/`, `roi-baseline-failure/`,
`roi-real-capping/`; `artifacts/firefox/roi-native-delayed-live.json`; and
`artifacts/live-tactile/roi-sorting-software.json` (the failed stress run).

Regenerate detector goldens with `python3 tests/make_tactile_roi_reference.py` and
browser recordings with `python3 tests/make_tactile_browser_fixture.py`. Run
`node tools/browser-tactile-clean.mjs` with `RDV_NATIVE=1`, `RDV_COMPAT=1`,
`RDV_NO_ARC=1` or `RDV_LIVE=1` for the corresponding path/scenario; compatibility
requires native mode. Real-sample comparisons use
`python3 tools/check-tactile-samples.py artifacts/tactile-real`. Native and software
decoders can produce different baselines/colors; exact comparisons always use the
same decoded inputs. Detection intentionally hides responses when a reliable arc
is unavailable. Source framing and orientation, recording formats and timestamps
are unchanged, and no runtime dependency or network service was added.

## Calibrated Inferno tactile display (2026-09-28)

The viewer now follows the supplied `tools/reference/render_tactile_diff.py`: fixed opening-frame median, per-pixel 99th-percentile noise, a 2-level margin, sigma-2 Gaussian smoothing, default 10× gain, gamma 0.7 and Inferno on opaque black. The Python reference was moved unchanged; its SHA-256 is `6946de24f9d0207d8907bcaccb8833cf38cfc5430fbe0bf898bec568ddbf36e4`. Native and software playback prepare their own fixed models using their decoded pixels. No recording format changed.

- `npm test` passed all seven test files; `npm run test:python` passed all eight cases; `npm run build` passed TypeScript checking and produced the standalone HTML. New tests cover independent NumPy/OpenCV goldens, grayscale coefficients, median truncation, fractional percentiles, reflected Gaussian borders, saturation, the gamma cutoff, short clips, portrait/tiny frames, fixed-baseline repeatability, native readiness and calibration cancellation.
- The real-sample comparison processes 72 frames across twelve sensors in the existing capping, folding and sorting recordings. Only 13 of 66,355,200 RGBA values differ from OpenCV, all explained by one neighboring pre-gamma quantization bin at floating-point boundaries. Some color-channel differences reach 25 at the explicit black cutoff. Every other value matches exactly; repeated rendering is byte-identical. This validates the reference calculation, not physical contact classification. Sources were read only.
- Chrome 152 synthetic controls passed native playback, forced software playback and the synchronous compatibility path with OffscreenCanvas disabled. Captured baseline models reproduce the actual displayed pixels exactly on each path. Tests cover default 10×, gains 1×/16×, Show all changes, paused redraw, toggling during playback, frame stepping, repeated seeks, expansion and English/Chinese labels. Three-frame clips use all three frames on both decoder paths. The real capping recording also passed Chrome software and Firefox native controls; normal and expanded Inferno maps and the Chinese settings layout were visually inspected. Rapid recording switches during calibration with 160 ms delayed rendering passed; an injected baseline failure stayed visible in one native panel while the other channels continued playback.
- Chrome software decoding of the real seven-stream sorting TAR advanced 23,999 ms in 23,994 ms with zero sampled buffering, 719–720 paints per tactile map, visible response in all 16 sampled contact moments on both left sensors, no page errors and no outbound requests. Firefox 156 native playback with tactile replies delayed by 160 ms advanced 23,816 ms in 23,814 ms, with zero sampled buffering, 127–128 paints per map and response in all 15 contact samples on both left sensors.

Earlier live checks that read full-size display canvases repeatedly showed intermittent software buffering. The machine had approximately 1.6 GiB available memory and full swap. An independent playback profile (without those readbacks) had no steady-state underruns or main-thread long tasks; worker batches had a 46 ms median and 64 ms 95th percentile. Live probes now sample small, separate canvases to avoid imposing repeated full-size readback on the display. The subsequent live run passed; this does not guarantee real-time software decoding on every machine. Full-resolution pixel comparisons remain in paused control tests.

Evidence: `artifacts/response-samples/results.json`, `artifacts/tactile-native/`, `artifacts/tactile-browser/`, `artifacts/tactile-compat/`, `artifacts/tactile-short-native/`, `artifacts/tactile-short-software/`, `artifacts/tactile-rapid-delayed/`, `artifacts/tactile-failure/`, `artifacts/tactile-real-capping/`, `artifacts/firefox/inferno-capping-controls-cleanup.json`, `artifacts/live-tactile/inferno-sorting-final.json`, `artifacts/firefox/inferno-native-delayed-live.json`, and `artifacts/playback-profile/inferno-profile.json`. Historical validation below describes earlier display algorithms.

Reproduce synthetic checks with `python3 tests/make_tactile_browser_fixture.py`, then `node tools/browser-tactile-clean.mjs` (software) or `RDV_NATIVE=1 node tools/browser-tactile-clean.mjs`. Add `RDV_COMPAT=1` with native mode for the compatibility path. Use `RDV_FOLDER` and `RDV_CONTACT_MS` for other recordings, or `RDV_SHORT=1` with the generated `short` folder. NumPy/OpenCV goldens can be regenerated with `python3 tests/make_tactile_reference.py`; real reference comparisons use `python3 tools/check-tactile-samples.py /path/to/extracted-task-folders`. Diagnostic recordings and screenshots remain in ignored artifacts and are not shipped.

## Head-camera companion exports (1.1.7)

Validated locally on 2026-09-23. Read-only inspection of the supplied remote `T1E1` export confirmed `ego-headcam-companion-1`, two 1920×1080 H.264 head videos at 60 fps, two 640×480 HEVC wrist videos and four 640×360 HEVC tactile videos at 30 fps inside `umi`. Both head CSVs contain 2,636 timestamps for 2,636 frames; every UMI raw CSV contains 1,329 timestamps for 1,329 frames. All eight timelines are nonnegative and monotonic. Head capture times span 7.648807–44,312.817874 ms. The processed UMI files intentionally contain 1,328 rows. No source files were modified.

The real recording was not copied or played locally: automatic approval review rejected transfer of both the full recording and a four-second excerpt. Browser checks therefore use **synthetic** eight-stream exports with matching codecs, dimensions, frame rates, nested layout, fractional capture timestamps, source indexes beginning at 580, and shortened UMI training timestamps. This establishes reader/control compatibility and measures synthetic playback, not real-recording image content or full-episode performance.

- Six new source regressions exercise actual MP4 probing through folder and TAR inputs, one combined episode, nested UMI task/pose metadata, correct head/UMI CSV precedence, fractional offsets, irregular timing, source-index independence, repeat loads, separate episodes, UMI-only selection, partial/corrupt media, missing timestamps, unsafe links, and nested directory conventions. All 39 JavaScript cases across six test files and all eight Python cases passed; production TypeScript/build checks passed.
- Chrome 152: normal folder playback advanced 5,466 ms in 5,494 ms; TAR playback advanced 5,467 ms in 5,514 ms. Both had zero busy samples after startup. Head videos used native H.264 playback; the six UMI streams used software HEVC decoding. No runtime exceptions or outbound page requests occurred.
- Firefox 156: native TAR playback advanced 6,050 ms in 6,049 ms, with zero busy samples, zero status transitions, no runtime errors, and no dropped frames reported by the video elements. Each head stream reported 361 frames, and each UMI stream 182. The folder run advanced 6,000 ms in 6,008 ms, also without buffering or errors; head elements reported two dropped frames each out of 358, and UMI elements zero. Callback sampling is not a frame-drop measurement.
- Chrome and Firefox folder/TAR checks passed one-episode/eight-channel display, timestamp alignment, pause, repeated seek, next/previous frame, head-view expansion, English/Chinese labels, and no horizontal overflow. Screenshots were inspected. Chrome's forced-software mode also passed decode/control checks, but advanced only 2,183 ms in 5,480 ms with repeated buffering. Two full-HD 60 fps software streams exceed this test computer's real-time capacity; normal browser selection keeps head video native. No claim of smooth all-software playback is made.

Reproduce synthetic browser checks with `python3 tests/make_headcam_fixture.py`, `node tools/browser-headcam.mjs`, and `python3 tools/browser-firefox.py --headcam --expect-capture-timing --source /path/to/headcam.tar --seconds 6 --check`. Firefox's sandbox requires accessible viewer, input and profile paths. Unit MP4 fixtures are three-frame generated solid colors; no customer recordings are committed or included in the portable ZIP.

Evidence: `artifacts/headcam-1.1.7/remote-timing-check.json`, `artifacts/headcam-browser/results.json`, and `artifacts/firefox/headcam-native-*.json` with screenshots alongside. Previous releases remain available.

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
