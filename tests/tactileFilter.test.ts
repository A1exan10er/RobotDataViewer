import test from 'node:test';
import assert from 'node:assert/strict';
import { TactileFilter } from '../src/tactileFilter.ts';
import { differenceRgb } from '../src/math.ts';

const width=640,height=360;
function reference(w=width,h=height) { const a=new Uint8ClampedArray(w*h*4);for(let i=0;i<a.length;i+=4){a[i]=a[i+1]=a[i+2]=110;a[i+3]=255;}return a; }
function noise() { const a=reference();let seed=789;for(let i=0;i<a.length;i+=4)for(let c=0;c<3;c++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;a[i+c]+=seed%9-4;}return a; }
function patch(a:Uint8ClampedArray,x0:number,y0:number,w:number,h:number,amount=25) { for(let y=y0;y<y0+h;y++)for(let x=x0;x<x0+w;x++){const i=(y*width+x)*4;a[i]+=amount;a[i+1]-=amount;} }
function darkness(a:Uint8ClampedArray,x:number,y:number) { const i=(y*width+x)*4;return 255-Math.min(a[i],a[i+1],a[i+2]); }

test('background fluctuations and isolated bright pixels stay exactly white even at 16x',()=>{
  const ref=reference(),current=noise(),out=new Uint8ClampedArray(ref.length);
  for(let y=8;y<height;y+=32)for(let x=8;x<width;x+=32){const i=(y*width+x)*4;current[i]=255;current[i+1]=0;}
  new TactileFilter(width,height,ref).render(current,out,16);
  assert.ok(out.every(v=>v===255));
});
test('concentrated color changes remain strong while unrelated background stays white',()=>{
  const ref=reference(),current=noise(),out=new Uint8ClampedArray(ref.length);
  patch(current,200,100,60,45);patch(current,400,180,24,32,18);
  new TactileFilter(width,height,ref).render(current,out,8);
  assert.ok(darkness(out,225,120)>150);assert.ok(darkness(out,412,195)>100);
  assert.equal(darkness(out,100,100),0);assert.equal(darkness(out,350,150),0);
});
test('held contact, release and seek order do not adapt or contaminate the fixed reference',()=>{
  const ref=reference(),original=ref.slice(),current=noise();patch(current,180,110,70,45);
  const currentCopy=current.slice(),filter=new TactileFilter(width,height,ref),out=new Uint8ClampedArray(ref.length);
  filter.render(current,out);const first=out.slice();
  for(let i=0;i<5;i++)filter.render(current,out);
  assert.deepEqual(out,first);filter.render(noise(),out);assert.ok(out.every(v=>v===255));
  filter.render(current,out);assert.deepEqual(out,first);assert.deepEqual(ref,original);assert.deepEqual(current,currentCopy);
});
test('cleanup is independent of gain and can be disabled to recover every raw RGB difference',()=>{
  const ref=reference(),current=noise();patch(current,160,80,70,45);
  const filter=new TactileFilter(width,height,ref),low=new Uint8ClampedArray(ref.length),high=low.slice(),expected=low.slice();
  filter.render(current,low,1);filter.render(current,high,16);
  assert.equal(darkness(low,100,100),0);assert.equal(darkness(high,100,100),0);
  assert.ok(darkness(high,185,100)>darkness(low,185,100));
  filter.render(current,high,8,false);differenceRgb(current,ref,expected,8);assert.deepEqual(high,expected);
  filter.render(current,high,1);assert.deepEqual(high,low);
});
test('broad strong changes survive adaptive thresholds, including odd frame sizes',()=>{
  const w=163,h=97,ref=reference(w,h),current=ref.slice(),out=ref.slice();
  for(let i=0;i<current.length;i+=4){current[i]+=40;current[i+1]-=40;}
  new TactileFilter(w,h,ref).render(current,out,8);
  for(let i=0;i<out.length;i+=4)assert.deepEqual([...out.subarray(i,i+4)],[0,0,255,255]);
  assert.throws(()=>new TactileFilter(w,h,new Uint8ClampedArray(4)));
  assert.throws(()=>new TactileFilter(w,h,ref).render(new Uint8ClampedArray(4),out));
});
