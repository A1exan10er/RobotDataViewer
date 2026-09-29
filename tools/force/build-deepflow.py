"""Build the small DeepFlow WASM wrapper; see tools/force/README.md."""
import argparse
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
p = argparse.ArgumentParser()
p.add_argument('--work', type=Path, default=root / 'artifacts/force-build')
args = p.parse_args()
work = args.work.resolve()
emsdk = work / 'emsdk'
em = emsdk / 'upstream/emscripten'
env = dict(os.environ, PATH=str(em) + os.pathsep + os.environ['PATH'], EM_CONFIG=str(emsdk / '.emscripten'))
build = work / 'opencv-wasm'
subprocess.run([str(em/'emcmake'), 'cmake', '-S', str(work/'opencv'), '-B', str(build), '-G', 'Ninja',
    '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_LIST=core,imgproc,video', '-DBUILD_SHARED_LIBS=OFF',
    '-DBUILD_opencv_dnn=OFF', '-DBUILD_TESTS=OFF', '-DBUILD_PERF_TESTS=OFF', '-DBUILD_EXAMPLES=OFF',
    '-DBUILD_opencv_apps=OFF', '-DWITH_IPP=OFF', '-DWITH_OPENCL=OFF', '-DWITH_PTHREADS_PF=OFF',
    '-DWITH_ITT=OFF', '-DWITH_LAPACK=OFF', '-DWITH_EIGEN=OFF', '-DWITH_PROTOBUF=OFF',
    '-DCV_ENABLE_INTRINSICS=ON', '-DCPU_BASELINE=', '-DCPU_DISPATCH=',
    '-DCMAKE_CXX_FLAGS=-msimd128 -ffp-contract=off -fexceptions',
    '-DCMAKE_C_FLAGS=-msimd128 -ffp-contract=off'], env=env, check=True)
subprocess.run(['cmake', '--build', str(build), '--parallel', '2'], env=env, check=True)
upstream = (work/'opencv_contrib/modules/optflow/src/deepflow.cpp').read_text()
algorithm = work/'deepflow-algorithm.cpp'
algorithm.write_text(upstream.replace('#include "precomp.hpp"', '#include <opencv2/core.hpp>\n#include <opencv2/imgproc.hpp>\n#include <opencv2/video.hpp>'))
output = root/'vendor/force'; output.mkdir(parents=True, exist_ok=True)
subprocess.run([str(em/'em++'), str(root/'tools/force/deepflow.cpp'), str(algorithm),
    '-I'+str(work/'opencv/modules/core/include'), '-I'+str(work/'opencv/modules/imgproc/include'),
    '-I'+str(work/'opencv/modules/video/include'), '-I'+str(build),
    str(build/'lib/libopencv_video.a'), str(build/'lib/libopencv_imgproc.a'), str(build/'lib/libopencv_core.a'),
    str(build/'3rdparty/lib/libzlib.a'),
    '-O3', '-msimd128', '-ffp-contract=off', '-fexceptions', '-sDISABLE_EXCEPTION_CATCHING=0',
    '-sMODULARIZE=1', '-sEXPORT_NAME=DeepFlowFactory', '-sENVIRONMENT=web,worker,node',
    '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=33554432', '-sFILESYSTEM=0',
    '-sEXPORTED_FUNCTIONS=["_malloc","_free","_force_reset","_force_input","_force_error"]',
    '-sEXPORTED_RUNTIME_METHODS=["HEAPU8","HEAPF32","UTF8ToString"]',
    '-o', str(output/'deepflow.js')], env=env, check=True)
