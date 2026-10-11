import {
  STUDIO_FILL_TEXT_ALIGNS,
  STUDIO_FILL_TEXT_STYLES,
  type StudioFillTextAlign,
  type StudioFillTextStyle,
} from "./StudioFillText";
import type { StudioJsonValue } from "./types";

/**
 * How a text node that fills its box looks, apart from its text and its box,
 * and how that is saved in the node's config. The box is the node's size and
 * the layout itself is declared in StudioNodeGeometry.
 */
export type StudioFillTextLook = {
  style: StudioFillTextStyle;
  align: StudioFillTextAlign;
  /** Null takes the colour of the surface the text sits on. */
  color: string | null;
};

const CONFIG_KEYS: Readonly<Record<keyof StudioFillTextLook, string>> = {
  style: "textStyle",
  align: "textAlign",
  color: "textColor",
};

function readChoice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (choices as readonly string[]).includes(candidate) ? (candidate as T) : fallback;
}

/** The saved look: plain, centred and in the canvas's own ink wherever the config says nothing usable. */
export function readStudioFillTextLook(config: Record<string, unknown>): StudioFillTextLook {
  const color = config[CONFIG_KEYS.color];
  const hex = typeof color === "string" ? color.trim().toLowerCase() : "";
  return {
    style: readChoice(config[CONFIG_KEYS.style], STUDIO_FILL_TEXT_STYLES, "plain"),
    align: readChoice(config[CONFIG_KEYS.align], STUDIO_FILL_TEXT_ALIGNS, "center"),
    color: /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(hex) ? hex : null,
  };
}

/** The config entries that save `change`. No colour of its own is saved as an empty value. */
export function studioFillTextLookConfig(
  change: Partial<StudioFillTextLook>
): Array<[key: string, value: StudioJsonValue]> {
  return (Object.keys(change) as Array<keyof StudioFillTextLook>).map((part) => [
    CONFIG_KEYS[part],
    change[part] ?? "",
  ]);
}
