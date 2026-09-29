export type Language = 'en' | 'zh';
export type Vec3 = [number, number, number];
export type Issue = { code: string; channel?: string; count?: number; detail?: string };
export type Media = {
  id: string; kind: 'rgb' | 'tactile'; path: string; original: string;
  width: number; height: number; fps: number; frames: number; duration: number;
  codec?: string; failed?: boolean;
};
export type CaptureContext = { task:string; operator:string; device?:string; session?:string; time?:number };
export type Episode = {
  capture?: CaptureContext;
  id: string; title: string; robot: string; durationMs: number; data: string;
  media: Media[]; issues: Issue[]; sourceName: string;
  /** Original companion exports keep UMI metadata and numeric channels here. */
  stateRoot?: string;
};
export type Manifest = { format: 'robot-data-viewer'; version: 1; episodes: Episode[] };
export type Timing = { media: number[]; episode: number[]; estimated: boolean };
export type Pose = { t: number; p: Vec3; axes: Vec3[] | null; g: number | null };
export type Trajectory = { side: 'left' | 'right' | 'single'; frame: 'shared' | 'recorded'; points: Pose[] };
export type Signal = { id: string; name: string; unit: string | null; t: number[]; values: number[] };
export type EpisodeData = { timings: Record<string, Timing>; trajectories: Trajectory[]; signals: Signal[] };
