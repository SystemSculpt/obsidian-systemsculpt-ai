import { readFileSync, readdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { convert } from "@asamuzakjp/css-color";

const cssRoot = resolvePath(__dirname, "../../../css");
const readCss = (path: string): string =>
  readFileSync(join(cssRoot, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const workspaceSheets = readdirSync(join(cssRoot, "views/agent-workspace"))
  .filter((file) => file.endsWith(".css"))
  .map((file) => `views/agent-workspace/${file}`);
const chatSheets = [...workspaceSheets, "components/chat-attachments.css", "components/diff-viewer.css"];

function declarations(css: string): Record<string, string> {
  return Object.fromEntries([...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
    .map(([, name, value]) => [name, value.trim()]));
}

function rule(css: string, selector: string): string {
  const block = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(([, selectors]) => selectors.trim() === selector
      || selectors.split(",").some((item) => item.trim() === selector));
  if (!block) throw new Error(`Missing CSS rule: ${selector}`);
  return block[2];
}

// Obsidian 1.14.5 app.css default-theme inputs (no custom theme/accent):
// color mappings and .theme-light/.theme-dark, lines 2939–3094. The HSL values
// below resolve the host's 258 / 88% / 66% accent formulas without rounding.
// Only host inputs are fixtures. Plugin colors, including all color-mix weights,
// come from the production stylesheet so palette edits cannot bypass this gate.
const themes: Record<string, Record<string, string>> = {
  light: {
    "--text-normal": "#222222", "--text-muted": "#5c5c5c", "--text-faint": "#ababab",
    "--text-accent": "hsl(258, 88%, 66%)", "--text-on-accent": "#ffffff",
    "--background-primary": "#ffffff", "--background-secondary": "#f6f6f6",
    "--interactive-accent": "hsl(257, 88.88%, 70.95%)", "--interactive-accent-hover": "hsl(255, 89.76%, 75.9%)",
    "--color-green-rgb": "8, 185, 78", "--color-yellow-rgb": "224, 172, 0",
    "--color-red-rgb": "233, 49, 71", "--color-blue-rgb": "8, 109, 221",
  },
  dark: {
    "--text-normal": "#dadada", "--text-muted": "#b3b3b3", "--text-faint": "#666666",
    "--text-accent": "hsl(255, 89.76%, 75.9%)", "--text-on-accent": "#ffffff",
    "--background-primary": "#1c1c1c", "--background-secondary": "#282828",
    "--interactive-accent": "hsl(258, 88%, 66%)", "--interactive-accent-hover": "hsl(255, 89.76%, 75.9%)",
    "--color-green-rgb": "68, 207, 110", "--color-yellow-rgb": "224, 222, 113",
    "--color-red-rgb": "251, 70, 76", "--color-blue-rgb": "2, 122, 255",
  },
};

type Color = number[];
const over = (front: Color, back: Color): Color => [
  ...front.slice(0, 3).map((channel, i) => channel * front[3] + back[i] * (1 - front[3])), 1,
];
function luminance(color: Color): number {
  const linear = color.slice(0, 3).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(foreground: Color, background: Color): number {
  const a = luminance(over(foreground, background));
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const textPairs = [
  // Reading surfaces, hover/selection, history metadata, chips and approval diffs.
  ...["--ss-surface-0", "--ss-surface-1", "--ss-surface-2", "--ss-surface-3",
    "--ss-surface-sunken", "--ss-state-hover", "--ss-state-selected",
    "--ss-accent-tint", "--ss-success-tint", "--ss-danger-tint", "--ss-warning-tint"]
    .flatMap((background) => ["--ss-ink", "--ss-ink-muted"].map((ink) => [ink, background])),
  ...["success", "warning", "danger"].flatMap((status) =>
    ["--ss-surface-0", "--ss-surface-1", `--ss-${status}-tint`]
      .map((background) => [`--ss-${status}`, background])),
  ...["--ss-surface-0", "--ss-surface-1", "--ss-accent-tint", "--ss-accent-tint-strong"]
    .map((background) => ["--ss-ink-accent", background]),
  ["--ss-ink-on-accent", "--ss-agent-action"],
  ["--ss-ink-on-accent", "--ss-agent-action-hover"],
];

describe("ChatView text contrast (WCAG AA, default Obsidian themes)", () => {
  test("the contrast calculation accounts for alpha before luminance", () => {
    expect(contrast([0, 0, 0, 1], [255, 255, 255, 1])).toBe(21);
    expect(contrast([0, 0, 0, 0], [255, 255, 255, 1])).toBe(1);
    expect(over([0, 0, 0, 0.5], [255, 255, 255, 1])).toEqual([127.5, 127.5, 127.5, 1]);
  });

  test.each(chatSheets)("%s does not use faint ink for text", (path) => {
    expect(readCss(path)).not.toMatch(/\bcolor\s*:\s*var\(--(?:ss-ink-faint|text-faint)\)/);
  });

  test("history-editing hints and placeholder text are not faded below their token contrast", () => {
    const conversation = readCss("views/agent-workspace/conversation.css");
    expect(conversation).not.toMatch(/\.systemsculpt-agent-composer\.is-history-editing\s*\{[^}]*opacity:/);
    expect(conversation).not.toMatch(/\.systemsculpt-agent-code-copy\s*\{[^}]*opacity:/);
    expect(readCss("views/agent-workspace/shell.css"))
      .toMatch(/:is\(input, textarea\)::placeholder\s*\{\s*color:\s*var\(--ss-ink-muted\);\s*opacity:\s*1;/);
  });

  test("every ChatView text token has a contrast case", () => {
    const tested = new Set(textPairs.map(([ink]) => ink));
    for (const path of chatSheets) {
      const colors = [...readCss(path).matchAll(/(?<![-\w])color:\s*var\((--ss-[\w-]+)/g)];
      for (const [, token] of colors) expect(tested.has(token)).toBe(true);
    }
  });

  test("action states use the tested fills rather than white text on a pale status/accent", () => {
    const css = readCss("views/agent-workspace/shell.css");
    expect(rule(css, ".systemsculpt-agent-workspace .ss-button--primary"))
      .toMatch(/background-color:\s*var\(--ss-agent-action\)/);
    // :is has a comma, so inspect this selector as a complete rule.
    expect(css).toMatch(/\.ss-button--primary:is\(:hover, :active\)[^{]+\{[^}]*background-color:\s*var\(--ss-agent-action-hover\)/);
    for (const status of ["danger", "warning"]) {
      expect(css).toMatch(new RegExp(`background-color:\\s*var\\(--ss-${status}-tint\\);\\s*color:\\s*var\\(--ss-${status}\\)`));
    }
  });

  describe.each(Object.entries(themes))("%s", (theme, host) => {
    const tokensCss = readCss("foundation/tokens.css");
    const tokens = {
      ...host,
      ...declarations(rule(tokensCss, "body")),
      ...(theme === "light" ? declarations(rule(tokensCss, "body.theme-light")) : {}),
      // ChatView overrides are scoped, not a palette change for other surfaces.
      ...declarations([...tokensCss.matchAll(/\.systemsculpt-agent-workspace\s*\{([^{}]*)\}/g)]
        .map(([, body]) => body).join("\n")),
    };
    const color = (token: string): Color => {
      expect(tokens).toHaveProperty(token);
      const result = convert.colorToRgb(`var(${token})`, { customProperty: tokens });
      expect(result).toHaveLength(4);
      expect(result.every(Number.isFinite)).toBe(true);
      return result;
    };
    test.each(textPairs)("%s on %s is at least 4.5:1", (ink, surface) => {
      const background = over(color(surface), color("--ss-surface-0"));
      const ratio = contrast(color(ink), background);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });
  });
});

describe("ChatView keyboard focus rules", () => {
  test("the post-cascade focus ring covers every interactive element, not just buttons", () => {
    const css = readCss("index.css");
    // :is borrows ID specificity, beating resting icon-button shadows with
    // multiple :not() classes as well as feature-specific focus rules.
    const selector = ":is(.ss-surface.systemsculpt-agent-workspace, #ss-specificity-boost) :focus-visible";
    const treatment = rule(css, selector);
    expect(treatment).toMatch(/outline:\s*2px solid var\(--ss-ink-accent\)/);
    expect(treatment).toMatch(/outline-offset:\s*2px/);
    expect(treatment).toMatch(/box-shadow:\s*var\(--ss-ring\)/);
    expect(css.indexOf(selector)).toBeGreaterThan(css.lastIndexOf("@import"));
  });

  test.each(chatSheets)("%s never suppresses keyboard focus", (path) => {
    for (const [, selector, body] of readCss(path).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!selector.includes(":focus-visible")) continue;
      expect(body).not.toMatch(/box-shadow:\s*none/);
      // A local ring may use a shadow instead of an outline, but never neither.
      if (/outline:\s*(?:none|0)\s*;/.test(body)) {
        expect(body).toMatch(/box-shadow:\s*var\(--ss-ring\)/);
      }
    }
  });
});
