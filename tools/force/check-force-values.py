"""End-to-end numerical acceptance for identical decoded inputs, in newtons."""
import json
import numpy as np
import onnxruntime as ort
from model import ROOT, forces
options=ort.SessionOptions();options.graph_optimization_level=ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED;options.intra_op_num_threads=2;options.inter_op_num_threads=1
session=ort.InferenceSession(str(ROOT/'vendor/force/force.onnx'),options,providers=['CPUExecutionProvider'])
folder=ROOT/'artifacts/force-reference';results=[]
for c in json.loads((folder/'manifest.json').read_text()):
    x=np.fromfile(folder/(c['name']+'-wasm.f32'),np.float32).reshape(1,3,360,640)
    normalized,score=session.run(None,{'input':x})
    values=forces(normalized[0],float(score));expected=c['forces']
    error=np.abs(np.array(values)-expected)
    assert (float(score)>=.1)==(c['score']>=.1),c['name']
    np.testing.assert_allclose(values,expected,atol=.001,rtol=.001,err_msg=c['name'])
    results.append({'name':c['name'],'expected':expected,'actual':values,'errorN':error.tolist()})
(folder/'force-results.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results,indent=2))
