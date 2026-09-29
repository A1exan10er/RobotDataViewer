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
        f = torch.nn.functional
        features = self.net.ppm(self.net.encoder(x))
        heads = []
        for convs in (self.net.reg_convs, self.net.seg_convs):
            head = features
            for i, conv in enumerate(convs):
                head = f.relu(conv(head))
                if i < 3:
                    head = f.interpolate(head, scale_factor=2, mode='bilinear', align_corners=False)
            heads.append(head)
        # Bilinear 2x enlargement preserves the spatial mean. A pointwise affine
        # projection commutes with interpolation; sigmoid deliberately stays after it.
        normalized = self.net.force_head(self.net.force_pool(heads[0]).flatten(1))
        segmentation = torch.sigmoid(f.interpolate(self.net.seg_head(heads[1]), scale_factor=2,
            mode='bilinear', align_corners=False))
        segmentation = f.interpolate(segmentation, size=x.shape[2:], mode='bilinear', align_corners=False)
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
    with torch.inference_mode(): segmentation, expected = net(torch.from_numpy(x)); score = segmentation.amax()
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
    'zero':zero,'contactThreshold':.1,'referenceFrame':0,'opencv':'4.12.0','onnxruntime':'1.23.2',
    'graph':'commuted-final-heads-v1'}
(out/'model.json').write_text(json.dumps(manifest,indent=2)+'\n')
# Validate the exported graph separately on the existing decoded reference cases.
oracle = ROOT/'artifacts/force-reference/manifest.json'
if oracle.exists():
    inputs=[]; predictions=[]; scores=[]
    for case in json.loads(oracle.read_text()):
        x=np.fromfile(oracle.parent/(case['name']+'-input.f32'),np.float32).reshape(1,3,360,640)
        actual,score=session.run(None,{'input':x})
        np.testing.assert_allclose(actual[0]*scale,np.array(case['normalized'])*scale,atol=.001,rtol=.001)
        assert (float(score)>=.1)==(case['score']>=.1)
        inputs.append(x);predictions.append(case['normalized']);scores.append(case['score'])
        checks.append({'case':case['name'],'maxForceError':float(np.max(np.abs(actual[0]*scale-np.array(case['normalized'])*scale)))})
# Portable provider probes are synthetic; never distribute tensors derived from
# the user's recordings. The decoded recording oracles above stay in artifacts/.
inputs=[];predictions=[];scores=[]
y,x=np.mgrid[:360,:640].astype(np.float32);bump=np.exp(-((x-320)**2+(y-180)**2)/8000).astype(np.float32)
for i in range(8):
    sample=np.zeros((1,3,360,640),np.float32)
    if i:
        sample[0,0]=bump*(i-3)*.7;sample[0,1]=bump*(3-i)*.4;sample[0,2]=np.round(bump*(i-4)*.05,2)
    with torch.inference_mode():seg,pred=net(torch.from_numpy(sample))
    inputs.append(sample);predictions.append(pred.numpy()[0]);scores.append(float(seg.max()))
np.savez_compressed(out/'validation.npz',inputs=np.array(inputs),normalized=np.array(predictions),scores=np.array(scores))
hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in out.iterdir() if p.name in ('force.onnx','deepflow.js','deepflow.wasm','model.json','validation.npz')}
(out/'SHA256.json').write_text(json.dumps(hashes,indent=2)+'\n')
print(json.dumps({'model':manifest,'checks':checks},indent=2))
