import type { AudioCue } from "../lib/storyboard";

export const systemSculptOverviewAudioCues = [
  { id: "cue-01", frame: 0, type: "downbeat" },
  { id: "cue-02", frame: 150, type: "whoosh" },
  { id: "cue-03", frame: 320, type: "impact" },
  { id: "cue-04", frame: 500, type: "impact" },
  { id: "cue-05", frame: 680, type: "whoosh" },
  { id: "cue-06", frame: 820, type: "impact" },
  { id: "cue-07", frame: 970, type: "whoosh" },
  { id: "cue-08", frame: 1110, type: "impact" },
  { id: "cue-09", frame: 1250, type: "whoosh" },
  { id: "cue-10", frame: 1420, type: "impact" },
  { id: "cue-11", frame: 1610, type: "downbeat" },
] as const satisfies readonly AudioCue[];
