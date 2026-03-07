import type { TextRevealSpec } from "./storyboard";

export interface ResolvedTextReveal {
  text: string;
  isComplete: boolean;
  showCursor: boolean;
}

const DEFAULT_TYPE_UNITS_PER_SECOND = 24;
const DEFAULT_STREAM_UNITS_PER_SECOND = 9;

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(Math.max(value, min), max);
};

const getStreamUnits = (text: string): string[] => {
  return text.match(/\S+\s*|\s+/g) ?? [];
};

const getRevealUnits = (
  text: string,
  reveal: TextRevealSpec
): string[] => {
  return reveal.mode === "stream" ? getStreamUnits(text) : Array.from(text);
};

const getVisibleUnitCount = (
  totalUnits: number,
  frame: number,
  fps: number,
  reveal: TextRevealSpec
): number => {
  if (totalUnits === 0) {
    return 0;
  }

  const startFrame = reveal.startFrame ?? 0;
  const elapsedFrames = frame - startFrame;
  if (elapsedFrames < 0) {
    return 0;
  }

  if (reveal.durationInFrames && reveal.durationInFrames > 0) {
    const progress = clamp(elapsedFrames / reveal.durationInFrames, 0, 1);
    return clamp(Math.ceil(progress * totalUnits), 0, totalUnits);
  }

  const unitsPerSecond =
    reveal.unitsPerSecond ??
    (reveal.mode === "stream"
      ? DEFAULT_STREAM_UNITS_PER_SECOND
      : DEFAULT_TYPE_UNITS_PER_SECOND);
  const visibleCount = Math.floor((elapsedFrames / fps) * unitsPerSecond);
  return clamp(visibleCount, 0, totalUnits);
};

export const resolveTextReveal = (
  text: string,
  frame: number,
  fps: number,
  reveal?: TextRevealSpec
): ResolvedTextReveal => {
  if (!text) {
    return {
      text: "",
      isComplete: true,
      showCursor: false,
    };
  }

  if (!reveal) {
    return {
      text,
      isComplete: true,
      showCursor: false,
    };
  }

  const units = getRevealUnits(text, reveal);
  const visibleUnitCount = getVisibleUnitCount(units.length, frame, fps, reveal);
  const isComplete = visibleUnitCount >= units.length;
  return {
    text: units.slice(0, visibleUnitCount).join(""),
    isComplete,
    showCursor: !!reveal.showCursor && !isComplete,
  };
};

export const resolveTextRevealLines = (
  lines: readonly string[],
  frame: number,
  fps: number,
  reveal?: TextRevealSpec
): ResolvedTextReveal[] => {
  if (!reveal) {
    return lines.map((line) => ({
      text: line,
      isComplete: true,
      showCursor: false,
    }));
  }

  const lineDelay = reveal.lineDelayInFrames ?? 0;
  return lines.map((line, index) => {
    return resolveTextReveal(line, frame, fps, {
      ...reveal,
      startFrame: (reveal.startFrame ?? 0) + index * lineDelay,
    });
  });
};
