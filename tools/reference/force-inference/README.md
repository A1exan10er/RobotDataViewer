# Supplied force inference reference

`NEW_sensor_inference_360.zip` is preserved byte-for-byte. SHA-256:
`bc1def406c4d9f90e9b35b9054c798867566803c09671fb701e9f2ec0c984d87`.
`upstream/` contains unchanged source/configuration extracts for review. The ZIP
also contains an older, different XYZ demonstration and Python bytecode; these
are not used or included in the portable runtime.

The viewer uses `PSP_deep_flow_diff_shear_valloss_0.6344`, following `main_new.py`:
resize original frames to 640×360, use the first frame as I0, DeepFlow with CLAHE
at scale 0.35, relative grayscale difference rounded to two decimals, and input
channels `[u, v, diff]`. Outputs are estimated shear magnitude and Fz in N, scaled
by 2.6 and 5.7, clamped nonnegative, and zeroed when both segmentation channels
are everywhere below 0.1. Initial `baseline_norm` is zero, as in the reference;
there is no implicit tare. In particular an unchanged image need not predict
exactly zero force. The opening frame can already contain contact.

The selected model does not output Fx/Fy directions or a pressure field. It uses
neither the older demo's perspective transform nor the viewer's heatmap mask or
display settings. Device-independent physical accuracy has not been established
by this software; values are labeled estimates.

Python preparation needs NumPy, OpenCV **contrib** (DeepFlow), ONNX Runtime and
FFmpeg/ffprobe. Exporting additionally needs PyTorch, torchvision and ONNX.
See [build/preparation instructions](../../force/README.md). For example:

```sh
python tools/force/prepare.py /path/to/recordings \
  --episode episode_0157_ --output /path/to/force-estimates.rdv-force.json
```

The supplied archive contains no license file. Its provenance is the user's
sensor inference reference; no third-party license is inferred for its weights.
Dependency licenses are included separately in the portable distribution.
