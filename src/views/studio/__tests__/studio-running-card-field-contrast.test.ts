import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// A running card disables its fields. Obsidian's app.css fades every disabled
// textarea and text input to `opacity: 0.5` (specificity 0,2,1) and disabled
// buttons, value dropdowns included, to 0.7 (0,1,1), which put a
// System prompt or TEXT body near 3:1 on the light theme. The card rule must
// outrank that and keep the field opaque.
const css = readFileSync(resolve(__dirname, "../../../css/views/studio/node-chrome.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBody(selector: string): string {
  const match = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, selectors]) => selectors.trim() === selector);
  if (!match) throw new Error(`Missing CSS rule: ${selector}`);
  return match[2];
}

it("keeps disabled fields and value dropdowns on a running card fully opaque", () => {
  const body = ruleBody(
    '.ss-studio-node-card :is(textarea, select, input:not([type="checkbox"], [type="radio"], [type="range"]), button.ss-studio-searchable-select-trigger, button.ss-studio-node-text-display-mode-button.is-selected):disabled'
  );
  expect(body).toMatch(/(^|;)\s*opacity:\s*1\s*;/);
});

// Status words and selected buttons (Studio's Raw/Rendered mode) are small accent-coloured
// text. Pure accent ink sat near 4.5:1 on the dark card and tint, so both mix
// at least half toward the theme's ink.
function cssRule(file: string, selector: string): string {
  const source = readFileSync(resolve(__dirname, `../../../css/${file}`), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const match = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, selectors]) => selectors.trim() === selector);
  if (!match) throw new Error(`Missing CSS rule: ${selector}`);
  return match[2];
}

it("mixes Studio status words and the selected text mode at least half toward ink", () => {
  const share = (body: string, token: string) => {
    const found = body.match(new RegExp(`color:\\s*color-mix\\(in srgb, var\\(${token}\\) (\\d+)%, var\\(--ss-ink\\)\\)`));
    if (!found) throw new Error(`No ink mix for ${token}`);
    return Number(found[1]);
  };
  expect(share(cssRule("views/studio/activity.css", ".ss-studio-node-activity-label"), "--ss-activity-color")).toBeLessThanOrEqual(55);
  expect(share(cssRule("primitives/buttons.css", ".ss-surface .ss-button.is-selected"), "--ss-ink-accent")).toBeLessThanOrEqual(55);
});
