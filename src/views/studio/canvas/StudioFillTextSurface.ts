import {
  estimateStudioFillTextMeasure,
  layoutStudioFillText,
  studioFillTextFont,
  type StudioFillTextAlign,
  type StudioFillTextLayout,
  type StudioFillTextMeasure,
  type StudioFillTextStyle,
} from "../../../studio/StudioFillText";

export type { StudioFillTextMeasure };

/**
 * The DOM side of fill text: one styling routine for the field being typed
 * into and for the block that shows the finished text, so the two can never
 * disagree about size, line breaks, or where the first line sits. Appearance
 * that does not depend on the box lives with the `ss-studio-fill-text` class.
 */

export type StudioFillTextAppearance = {
  text: string;
  style: StudioFillTextStyle;
  align: StudioFillTextAlign;
  /** Null takes the colour of the surface the text sits on. */
  color: string | null;
};

export const STUDIO_FILL_TEXT_CLASS = "ss-studio-fill-text";
export const STUDIO_FILL_TEXT_PLACEHOLDER = "Text";

const OUTLINE_COLOR = "#000000";
const contexts = new WeakMap<Document, CanvasRenderingContext2D | null>();
const estimate = estimateStudioFillTextMeasure(0.5);

/**
 * Measures text with a 2D canvas, the way it will be drawn. Where there is
 * no canvas it estimates half an em per character, which keeps layout
 * deterministic without one.
 */
export function createStudioFillTextMeasure(host: Node): StudioFillTextMeasure {
  const doc = host.ownerDocument ?? (host.nodeType === 9 ? (host as Document) : null);
  let context: CanvasRenderingContext2D | null = null;
  if (doc) {
    const known = contexts.get(doc);
    if (known !== undefined) {
      context = known;
    } else {
      const view = doc.defaultView;
      context = view && typeof view.CanvasRenderingContext2D === "function"
        ? view.createEl("canvas").getContext("2d")
        : null;
      contexts.set(doc, context);
    }
  }
  return (font, text) => {
    if (!context) {
      return estimate(font, text);
    }
    context.font = font;
    return context.measureText(text).width;
  };
}

/**
 * Styles `surface` so that `appearance` exactly fills a box of `box` pixels.
 * `scale` is how many of the surface's CSS pixels one box pixel covers. An
 * empty text is sized as its placeholder, so the caret starts at full size.
 */
export function fitStudioFillText(
  surface: HTMLElement,
  appearance: StudioFillTextAppearance,
  box: { width: number; height: number },
  measure: StudioFillTextMeasure,
  scale: number = 1
): StudioFillTextLayout {
  const layout = layoutStudioFillText(
    measure,
    { text: appearance.text || STUDIO_FILL_TEXT_PLACEHOLDER, style: appearance.style },
    box.width,
    box.height
  );
  const textHeight = layout.lines.length * layout.lineHeightPx;
  surface.dataset.style = appearance.style;
  surface.setCssStyles({
    font: studioFillTextFont(appearance.style, layout.fontPx * scale),
    lineHeight: `${layout.lineHeightPx * scale}px`,
    paddingTop: `${Math.max(0, ((box.height - textHeight) / 2) * scale)}px`,
    paddingLeft: `${layout.padPx * scale}px`,
    paddingRight: `${layout.padPx * scale}px`,
    textAlign: appearance.align,
    color: appearance.color ?? "",
    // A scaled surface shows the glyphs at another size than they were laid
    // out at. Pinning the optical size keeps them the shape that was measured.
    fontVariationSettings: scale === 1 ? "" : `"opsz" ${layout.fontPx}`,
    webkitTextStroke: `${layout.strokePx * scale}px ${layout.strokePx > 0 ? OUTLINE_COLOR : "transparent"}`,
  });
  return layout;
}
