"""Export reviewed weights without executing checkpoint pickle constructors."""
from pathlib import Path
import hashlib
import json
import time
import numpy as np
import onnxruntime as ort
import torch
from model import ROOT, MODEL_ID, PIPELINE, load_torch

torch.set_num_threads(2)
net, weights_sha = load_torch()

class Export(torch.nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, x):
        segmentation, normalized = self.net(x)
        return normalized, segmentation.amax()

model = Export(net).eval()
out = ROOT/'vendor/force'; out.mkdir(parents=True, exist_ok=True)
torch.onnx.export(model, torch.zeros(1,3,360,640), str(out/'force.onnx'), input_names=['input'],
    output_names=['normalized','contactScore'], opset_version=17, dynamo=False)
options = ort.SessionOptions(); options.graph_optimization_level=ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED; options.intra_op_num_threads=2; options.inter_op_num_threads=1
session = ort.InferenceSession(str(out/'force.onnx'), options, providers=['CPUExecutionProvider'])
checks=[]; zero=None
for seed in range(3):
    x = np.zeros((1,3,360,640),np.float32) if seed==0 else np.random.default_rng(seed).normal(0,.1,(1,3,360,640)).astype(np.float32)
    started=time.perf_counter()
    with torch.inference_mode(): expected, score = model(torch.from_numpy(x))
    actual, actual_score=session.run(None,{'input':x})
    # Acceptance is in newtons, rather than relative error near a normalized zero.
    scale=np.array([2.6,5.7],np.float32)
    np.testing.assert_allclose(actual*scale,expected.numpy()*scale,atol=.001,rtol=.001)
    assert (float(actual_score)>=.1)==(float(score)>=.1)
    if seed==0:zero={'normalized':expected.numpy()[0].tolist(),'contactScore':float(score)}
    checks.append({'seed':seed,'maxNormalizedError':float(np.max(np.abs(actual-expected.numpy()))),'seconds':time.perf_counter()-started})
manifest={'model':MODEL_ID,'pipeline':PIPELINE,'weightsSha256':weights_sha,
    'onnxSha256':hashlib.sha256((out/'force.onnx').read_bytes()).hexdigest(),
    'input':[1,3,360,640],'outputs':['shear','fz'],'unit':'N','scales':[2.6,5.7],
    'zero':zero,'contactThreshold':.1,'referenceFrame':0,'opencv':'4.12.0','onnxruntime':'1.23.2'}
(out/'model.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'model':manifest,'checks':checks},indent=2))
