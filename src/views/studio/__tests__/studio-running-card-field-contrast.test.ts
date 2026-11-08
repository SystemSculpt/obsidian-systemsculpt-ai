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
