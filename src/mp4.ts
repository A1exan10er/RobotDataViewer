import { createFile } from 'mp4box';
export type MovieInfo = { width:number; height:number; duration:number; fps:number; pts:number[]; codec:string };
export async function probeMovie(blob: Blob, signal?: AbortSignal): Promise<MovieInfo> {
  const mp4 = createFile(); let info: MovieInfo | undefined, failure: unknown;
  mp4.onError = () => { failure = new Error('invalidVideo'); };
  mp4.onReady = data => {
    const track = data.videoTracks[0];
    if (!track?.video) { failure = new Error('invalidVideo'); return; }
    const samples = mp4.getTrackSamplesInfo(track.id);
    const pts = samples.map(s=>s.cts / s.timescale).sort((a,b)=>a-b);
    const first = pts[0] || 0;
    const duration = samples.reduce((end,s)=>Math.max(end,(s.cts+s.duration)/s.timescale),0) - first;
    info = {width:track.video.width,height:track.video.height,duration,fps:pts.length/duration,pts:pts.map(t=>t-first),codec:track.codec};
  };
  try {
    let offset = 0;
    while (offset < blob.size && !info && !failure) {
      signal?.throwIfAborted();
      const bytes = await blob.slice(offset, Math.min(blob.size, offset + 1024*1024)).arrayBuffer();
      const chunk = Object.assign(bytes, {fileStart:offset});
      const next = mp4.appendBuffer(chunk);
      offset = next > offset ? next : offset + bytes.byteLength;
    }
    if (failure) throw failure;
    if (!info || !info.pts.length || !Number.isFinite(info.duration) || info.duration <= 0) throw new Error('invalidVideo');
    return info;
  } finally { mp4.stop(); }
}
