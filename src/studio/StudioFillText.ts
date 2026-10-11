/**
 * Text that fills its box: captions on an image and text on the Studio
 * canvas are both laid out here, so they behave the same wherever they are
 * typed. The box is the author's; the type size is whatever fills it.
 *
 * It is DOM-free. Callers supply the text measurement, and paint or style
 * from the returned layout.
 */

export type StudioFillTextStyle = "plain" | "meme" | "outline" | "shadow" | "banner";
export type StudioFillTextAlign = "left" | "center" | "right";

export const STUDIO_FILL_TEXT_STYLES: readonly StudioFillTextStyle[] = ["plain", "meme", "outline", "shadow", "banner"];
export const STUDIO_FILL_TEXT_ALIGNS: readonly StudioFillTextAlign[] = ["left", "center", "right"];

export type StudioFillTextLayout = {
  lines: string[];
  font: string;
  fontPx: number;
  lineHeightPx: number;
  /** Line width of the outline; half of it shows outside the glyph. */
  strokePx: number;
  padPx: number;
};

const LINE_HEIGHT = 1.12;
const REFERENCE_PX = 100;
const FIT_ROUNDS = 6;
const FIT_TOLERANCE_PX = 0.02;
const MEME_FONT_STACK = 'Impact, Haettenschweiler, "Franklin Gothic Bold", "Arial Black", sans-serif';
const SANS_FONT_STACK = 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
const PAD_EM: Record<StudioFillTextStyle, number> = {
  plain: 0.12,
  meme: 0.14,
  outline: 0.14,
  shadow: 0.16,
  banner: 0.36,
};
const STROKE_EM: Record<StudioFillTextStyle, number> = {
  plain: 0,
  meme: 0.13,
  outline: 0.1,
  shadow: 0,
  banner: 0,
};

export function studioFillTextFont(style: StudioFillTextStyle, sizePx: number): string {
  // Impact ships one weight; asking for bold would make the browser smear it.
  if (style === "meme") {
    return `${sizePx}px ${MEME_FONT_STACK}`;
  }
  return `${style === "plain" ? 600 : 700} ${sizePx}px ${SANS_FONT_STACK}`;
}

/** The text as it is shown: the meme style is always capitals. */
export function studioFillTextDisplay(text: string, style: StudioFillTextStyle): string {
  return style === "meme" ? text.toUpperCase() : text;
}

export type StudioFillTextMeasure = (font: string, text: string) => number;

/** Stands in for a canvas where there is none: every character is `emPerCharacter` of the font size wide. */
export function estimateStudioFillTextMeasure(emPerCharacter: number): StudioFillTextMeasure {
  return (font, text) => text.length * Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16) * emPerCharacter;
}

/**
 * The widest line, in ems, as set at `sizePx`. A font is not the same shape
 * at every size (optical sizing draws small text wider), so the width is
 * always asked for at the size in question, never scaled from another.
 */
function widestLineEm(
  measure: StudioFillTextMeasure,
  lines: string[],
  style: StudioFillTextStyle,
  sizePx: number
): number {
  const font = studioFillTextFont(style, sizePx);
  return Math.max(0.5, ...lines.map((line) => measure(font, line || " ") / sizePx));
}

/**
 * The box that sets `content` at `fontPx`: the layout run backwards, for
 * text that arrives without a box of its own.
 */
export function studioFillTextBoxAt(
  measure: StudioFillTextMeasure,
  content: { text: string; style: StudioFillTextStyle },
  fontPx: number
): { width: number; height: number } {
  const lines = studioFillTextDisplay(content.text, content.style).split("\n");
  const padEm = PAD_EM[content.style];
  return {
    width: (widestLineEm(measure, lines, content.style, fontPx) + padEm * 2) * fontPx,
    height: (lines.length * LINE_HEIGHT + padEm) * fontPx,
  };
}

/**
 * The largest size at which every authored line fits the width and all lines
 * fit the height. Nothing wraps on its own, so a field typed into and the
 * finished text always break in the same places.
 */
export function layoutStudioFillText(
  measure: StudioFillTextMeasure,
  content: { text: string; style: StudioFillTextStyle },
  widthPx: number,
  heightPx: number
): StudioFillTextLayout {
  const lines = studioFillTextDisplay(content.text, content.style).split("\n");
  const padEm = PAD_EM[content.style];
  const tallest = heightPx / (lines.length * LINE_HEIGHT + padEm);
  const fitAt = (sizePx: number): number =>
    Math.min(tallest, widthPx / (widestLineEm(measure, lines, content.style, sizePx) + padEm * 2));
  // The width a line needs depends on the size it is set at, so settle on the
  // size by asking again at each answer. It closes in from above within a few rounds.
  let fontPx = fitAt(REFERENCE_PX);
  for (let round = 0; round < FIT_ROUNDS; round += 1) {
    const next = fitAt(Math.max(1, fontPx));
    const settled = Math.abs(next - fontPx) < FIT_TOLERANCE_PX;
    fontPx = Math.min(fontPx, next);
    if (settled) {
      break;
    }
  }
  fontPx = Math.max(1, fontPx);
  return {
    lines,
    font: studioFillTextFont(content.style, fontPx),
    fontPx,
    lineHeightPx: fontPx * LINE_HEIGHT,
    strokePx: fontPx * STROKE_EM[content.style],
    padPx: fontPx * padEm,
  };
}
