These tiny, synthetic three-frame MP4s test actual MP4 probing and per-camera timestamp assignment without any customer recordings. Generate each with FFmpeg, replacing RATE with 30 or 60:

`ffmpeg -f lavfi -i color=c=navy:size=96x64:rate=RATE -frames:v 3 -c:v libx264 -pix_fmt yuv420p -threads 1 -movflags +faststart timing-RATEfps.mp4`

`tactile-reference.json` contains synthetic RGBA inputs and independent NumPy/OpenCV baseline, noise, grayscale and heatmap goldens. Regenerate it with `python3 tests/make_tactile_reference.py` (NumPy/OpenCV required only for regeneration). `python3 tests/make_tactile_browser_fixture.py` creates native/software browser recordings and a three-frame edge case under ignored `artifacts/tactile-fixtures/`.

`tactile-roi.json` contains ten independent NumPy arc/mask goldens, compressed
with zlib/base64. Regenerate with `python3 tests/make_tactile_roi_reference.py`
(NumPy/Pillow required only for regeneration). Cases include curved/neighboring
rims, existing contact, odd dimensions, blank images, a straight edge, noise,
weak boundaries and obscured arcs. Browser fixtures include a realistic fixed
arc, inside/outside changes, and a `missing-arc` episode where one panel must stay
black with a notice while the other channels play. No real recordings are stored
in these committed fixtures.

The `offsets` browser fixture reuses those encoded frames with per-channel start
offsets of 250–1000 ms and capture-time scales of 0.9–1.1. Generate only that
variant from existing fixtures with `python3 tests/make_tactile_browser_fixture.py --offsets-only`;
run it with `RDV_OFFSETS=1 node tools/browser-startup.mjs`. Expected media timestamps
are calculated independently from these constants in the browser check.

The tactile browser fixture generator also emits `artifacts/tactile-fixtures/prepared`,
a version-1 manifest using the same encoded frames without codec metadata. This
checks automatic codec probing and the sequential tactile path for older packages.
