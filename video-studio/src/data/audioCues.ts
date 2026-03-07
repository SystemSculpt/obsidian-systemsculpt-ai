import type { AudioCue } from "../lib/storyboard";

export const pdfAiAssistantAudioCues = [
  { id: "hit-01", frame: 0, type: "downbeat" },
  { id: "whoosh-02", frame: 180, type: "whoosh" },
  { id: "impact-03", frame: 360, type: "impact" },
  { id: "impact-04", frame: 600, type: "impact" },
  { id: "impact-05", frame: 840, type: "impact" },
  { id: "whoosh-06", frame: 1080, type: "whoosh" },
  { id: "impact-07", frame: 1320, type: "impact" },
  { id: "hit-08", frame: 1560, type: "downbeat" },
] as const satisfies readonly AudioCue[];
