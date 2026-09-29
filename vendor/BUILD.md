# Bundled decoder build

The committed `decoder.wasm`, `libav.js`, and `libav-factory.js` support offline H.264/HEVC decoding. The frontend build assembles the worker with `tools/prepare-decoder.mjs`; it compiles the embedded WebAssembly once per viewer session and shares that module with workers (with a byte-based fallback), avoiding file-origin fetches, SharedArrayBuffer, and cross-origin-isolation requirements.

Pinned upstreams:

- libav.js `v6.9.8.1`, commit `65ce461de1add4c96bc74fac52bd239f900ec11f`
- FFmpeg `8.1`
- emfiberthreads `1.3`
- Emscripten `4.0.22`

Corresponding libav.js, FFmpeg and emfiberthreads source archives are in `sources/`. The libav.js archive includes the exact `viewer` configuration, upstream patches, and build scripts. Emscripten is a development compiler, not a customer requirement.

The release also includes `sources/RobotDataViewer-source.tar.gz` with the frontend source and build inputs needed to relink the app. Extract it and run `npm ci` before replacing decoder files. In version 1.3.0, restore the optional force binaries from the portable package first with `python3 tools/force/unpack-runtime.py /path/to/RobotDataViewer/force-runtime.js`. This avoids storing the same model twice in the ZIP. See `tools/force/README.md` for rebuilding those components from source.

To rebuild the decoder, extract the libav.js archive into a build directory, install/activate Emscripten 4.0.22, and source its `emsdk_env.sh`. Place the supplied FFmpeg and emfiberthreads archives in that directory's `build/` folder. Then run:

```sh
cd configs
./mkconfig.js viewer '["avformat","avcodec","demuxer-mov","parser-h264","decoder-h264","parser-hevc","decoder-hevc","swscale"]'
cd ..
make -j8 OPTFLAGS=-O3 dist/libav-6.9.8.1-viewer.js dist/libav-6.9.8.1-viewer.wasm.js
```

Copy `dist/libav-6.9.8.1-viewer.js` to `vendor/libav.js`, `dist/libav-6.9.8.1-viewer.wasm.js` to `vendor/libav-factory.js`, and `dist/libav-6.9.8.1-viewer.wasm.wasm` to `vendor/decoder.wasm` in RobotDataViewer. Run `npm run build` to relink the standalone viewer with the replacement library. The app contains no restrictions on replacing or debugging the library.

Only demuxing, parsing, decoding and pixel conversion are enabled. No encoders, network protocols, pthread workers or command-line transcoding runtime are used.

### Native 1.4.0 force runtime

`tools/force/export-model.py` exports the final-head operation reordering and
checks the result against the unchanged supplied PyTorch model. It also creates
`vendor/force/validation.npz` from eight deterministic synthetic input tensors;
these bundled probes contain no recording frames. The existing real decoded
oracles remain under `artifacts/` for independent validation only. Run the
export before `tools/force/build-assets.mjs` and verify `vendor/force/SHA256.json`.
Native build, platform packaging, FFmpeg source build, GPU add-ons and extracted
smoke tests are documented in `docs/NATIVE_FORCE.md`.
