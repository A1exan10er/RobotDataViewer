import test from 'node:test';
import assert from 'node:assert/strict';
import { DecoderTransport, type DecodedFrame } from '../src/softwareTransport.ts';
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
class WorkerStub {
  onmessage:((event:{data:unknown})=>void)|null=null;onerror:(()=>void)|null=null;
  requests:{id:number;method:string;args:any}[]=[];terminated=0;
  postMessage(request:any){this.requests.push(request);}
  terminate(){this.terminated++;}
  reply(id:number,result:unknown){this.onmessage?.({data:{id,result}});}
  reject(id:number){this.onmessage?.({data:{id,error:'delayed old failure'}});}
}
function frame(time:number){let closed=0;return {time,width:2,height:1,gain:10,cleanup:true,image:{close(){closed++;}},get closed(){return closed;}} as unknown as DecodedFrame&{closed:number};}
async function setup(){
  const worker=new WorkerStub(),draws:number[]=[],failures:unknown[]=[];
  const player=new DecoderTransport(worker as unknown as Worker,new Uint8Array(),new Blob(),Array.from({length:600},(_,i)=>i/30),30,f=>draws.push(f.time),e=>failures.push(e),true);
  worker.reply(worker.requests[0].id,{});await player.initialized;
  return {worker,draws,failures,player};
}
test('private catch-up drains expired frames, refills a full queue, and never paints a future frame',async()=>{
  const {worker,draws,player}=await setup();const sought=player.seek(3,false);await settle();
  const frames=Array.from({length:36},(_,i)=>frame(3+i/30));worker.reply(worker.requests.at(-1)!.id,{frames,eof:false});await sought;
  assert.deepEqual(draws,[]);assert.equal(player.prepare(3.55,.65),false);const requests=worker.requests.length;
  assert.equal(player.prepareCatchUp(3.55,.65),false);assert.equal(worker.requests.length,requests+1);assert.equal(frames.filter(f=>f.closed).length,16);
  worker.reply(worker.requests.at(-1)!.id,{frames:Array.from({length:16},(_,i)=>frame(4.2+i/30)),eof:false});await settle();
  assert.equal(player.prepareCatchUp(3.55,.65),true);assert.deepEqual(draws,[]);
  player.present(2.9,1,false);assert.deepEqual(draws,[]);player.present(3.55,1,false);assert.equal(draws[0],3+16/30);
  player.dispose();assert.ok(frames.every(f=>f.closed===1));
});
test('late refill errors after an explicit seek cannot fail the new playback generation',async()=>{
  const {worker,draws,failures,player}=await setup();const first=player.seek(1,false);await settle();
  worker.reply(worker.requests.at(-1)!.id,{frames:[frame(1)],eof:false});await first;player.prepare(1,.65);const obsolete=worker.requests.at(-1)!;
  const second=player.seek(7);await settle();worker.reply(worker.requests.at(-1)!.id,{frames:[frame(7)],eof:true});await second;
  worker.reject(obsolete.id);await settle();assert.equal(player.error,false);assert.deepEqual(failures,[]);assert.deepEqual(draws,[7]);player.dispose();
});
test('disposal abandons pending work and closes late reply bitmaps',async()=>{
  const {worker,player,failures}=await setup();const seek=player.seek(1,false);await settle();const request=worker.requests.at(-1)!;
  player.dispose();player.dispose();await seek;assert.equal(worker.terminated,1);assert.equal(player.ready,false);assert.deepEqual(failures,[]);
  const late=frame(1);worker.reply(request.id,{frames:[late],eof:false});assert.equal(late.closed,1);
});

test('staging seeks reuse buffered frames and preserve a valid in-flight refill',async()=>{
  const {worker,draws,player}=await setup();const seek=player.seek(0,false);await settle();
  const frames=[frame(0),frame(1/30),frame(2/30),frame(3/30)];worker.reply(worker.requests.at(-1)!.id,{frames,eof:false});await seek;
  player.prepare(0,.65);const pending=worker.requests.at(-1)!,count=worker.requests.length;
  await player.seek(1/30,false);assert.equal(worker.requests.length,count);assert.deepEqual(draws,[]);
  worker.reply(pending.id,{frames:[frame(4/30)],eof:true});await settle();
  assert.equal(player.prepare(1/30,.65),true);player.present(1/30,1,false);assert.deepEqual(draws,[1/30]);player.dispose();
});
test('preparation fills only the requested reserve, and ordinary playback resumes prefetch',async()=>{
  const {worker,player}=await setup();const seek=player.seek(0,false);await settle();
  worker.reply(worker.requests.at(-1)!.id,{frames:Array.from({length:4},(_,i)=>frame(i/30)),eof:false});await seek;
  assert.equal(worker.requests.length,2);player.prepare(0,.65);
  for(let i=4;i<20;i+=4){worker.reply(worker.requests.at(-1)!.id,{frames:Array.from({length:4},(_,j)=>frame((i+j)/30)),eof:false});await settle();}
  const count=worker.requests.length;assert.equal(player.prepare(0,.65),true);await settle();assert.equal(worker.requests.length,count);
  player.present(0,1,true);player.prepare(0);assert.equal(worker.requests.length,count+1);player.dispose();
});
test('settings redraw reuses the decoder, preserves grayscale bytes and closes late output',async()=>{
  const {worker,player}=await setup();const gray=new Uint8Array([17,82]),input={...frame(0),gray:gray.buffer};
  const pending=player.redraw(input,16,false),request=worker.requests.at(-1)!;
  assert.equal(request.method,'redraw');assert.notEqual(request.args.gray,gray.buffer);assert.deepEqual([...gray],[17,82]);
  const rendered=frame(0);worker.reply(request.id,{frames:[rendered]});assert.equal(await pending,rendered);
  const lateCall=player.redraw(input,2,true),lateRequest=worker.requests.at(-1)!;player.dispose();await assert.rejects(lateCall,/disposed/);
  const late=frame(0);worker.reply(lateRequest.id,{frames:[late]});assert.equal(late.closed,1);
});

test('RGB staging never retransfers the bitmap already displayed on its canvas',async()=>{
  const worker=new WorkerStub(),draws:number[]=[];
  const player=new DecoderTransport(worker as unknown as Worker,new Uint8Array(),new Blob(),[0,1/30,2/30],30,f=>{assert.ok(!draws.includes(f.time),'bitmap was consumed');draws.push(f.time);},()=>assert.fail('channel failed'));
  worker.reply(worker.requests[0].id,{});await settle();
  worker.reply(worker.requests.at(-1)!.id,{frames:[frame(0),frame(1/30),frame(2/30)],eof:true});await player.initialized;
  const requests=worker.requests.length;await player.seek(0,false);player.present(0,1,false);
  assert.deepEqual(draws,[0]);assert.equal(player.currentTime,0);assert.equal(worker.requests.length,requests);
  await player.seek(1/30,false);player.present(1/30,1,false);await player.seek(1/30,false);player.present(1/30,1,false);
  assert.deepEqual(draws,[0,1/30]);player.dispose();
});
