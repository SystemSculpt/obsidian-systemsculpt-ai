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

// Obsidian's named colours, the usual picks for a custom accent.
const customAccents = ["#e93147", "#ec7500", "#e0ac00", "#08b94e", "#00bfbc", "#086ddd", "#7852ee", "#d53984"];

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
  test("open tool and reasoning disclosures rotate their right chevrons downward", () => {
    expect(rule(readCss("views/agent-workspace/tools.css"), ".systemsculpt-agent-conversation .systemsculpt-agent-tool.is-disclosure[open] > .systemsculpt-agent-tool-header .systemsculpt-agent-tool-disclosure"))
      .toMatch(/transform:\s*rotate\(90deg\)/);
    expect(rule(readCss("views/agent-workspace/reasoning.css"), ".systemsculpt-agent-reasoning-details[open] .systemsculpt-agent-reasoning-disclosure"))
      .toMatch(/transform:\s*rotate\(90deg\)/);
  });

  test("lone activity rows share the turn-summary gutter", () => {
    for (const [sheet, selector] of [
      ["activity", "summary.systemsculpt-agent-activity-header"],
      ["tools", ".systemsculpt-agent-conversation .systemsculpt-agent-tool-header"],
      ["reasoning", ".systemsculpt-agent-reasoning-header"],
    ]) {
      // The hover pill bleeds 4px past the column, so every icon sits on the column edge.
      const header = rule(readCss(`views/agent-workspace/${sheet}.css`), selector);
      expect(header).toMatch(/gap:\s*var\(--ss-space-2\)/);
      expect(header).toMatch(/margin-inline:\s*calc\(-1 \* var\(--ss-space-1\)\)/);
      expect(header).toMatch(/padding:\s*0 var\(--ss-space-1\)/);
    }
  });

  test("grouped activity does not override the shared icon gutters", () => {
    const override = readCss("views/agent-workspace/activity.css")
      .match(/button\.systemsculpt-agent-activity-overflow-header\s*\{[^}]+\}/g)?.pop();
    expect(override).not.toMatch(/(?:^|[\s;])gap:/);
    expect(override).not.toMatch(/margin/);
    expect(override).toMatch(/padding:\s*0 var\(--ss-space-1\)/);
  });

  test("diff markers start on the 12 px inset every card code box uses, without a number gutter", () => {
    const css = readCss("components/diff-viewer.css");
    expect(rule(css, ".systemsculpt-diff-viewer")).toMatch(/--ss-diff-inset:\s*var\(--ss-space-3\)/);
    expect(rule(css, ".systemsculpt-diff-line")).toMatch(/padding-inline:\s*var\(--ss-diff-inset\)/);
    expect(readCss("views/agent-workspace/tools.css")).not.toMatch(/systemsculpt-diff-prefix:first-child/);
  });

  test("raw tool Details wraps long values instead of clipping paths", () => {
    const css = readCss("views/agent-workspace/tools.css");
    for (const selector of [".systemsculpt-agent-conversation .systemsculpt-agent-tool-raw pre", ".systemsculpt-agent-conversation .systemsculpt-agent-tool-raw code"]) {
      const details = rule(css, selector);
      expect(details).toMatch(/white-space:\s*pre-wrap/);
      expect(details).toMatch(/overflow-wrap:\s*anywhere/);
    }
  });

  test("Latest stays in its own transcript row rather than covering content", () => {
    const transcript = rule(readCss("views/agent-workspace/shell.css"), ".systemsculpt-agent-transcript");
    const latest = rule(readCss("views/agent-workspace/states.css"), ".systemsculpt-agent-jump");
    expect(transcript).toMatch(/flex-direction:\s*column/);
    expect(latest).toMatch(/flex:\s*0 0 auto/);
    expect(latest).toMatch(/align-self:\s*flex-end/);
    expect(latest).not.toMatch(/position:\s*(?:absolute|fixed)|\b(?:bottom|right):/);
  });

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

  test("host-rendered Markdown links consume the tested ink without unresolved-link fading", () => {
    const tokens = declarations(rule(readCss("foundation/tokens.css"), ".systemsculpt-agent-workspace"));
    for (const token of ["--link-color", "--link-external-color", "--link-unresolved-color"]) {
      expect(tokens[token]).toBe("var(--ss-ink-accent)");
    }
    for (const token of ["--link-color-hover", "--link-external-color-hover"]) {
      expect(tokens[token]).toBe("var(--ss-ink)");
    }
    expect(tokens["--link-unresolved-opacity"]).toBe("1");
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

    // The focused message box is drawn by its card's border alone (WCAG 1.4.11).
    // Obsidian's accent picker sets --accent-h/s/l. 1.13 derives text accent
    // hsl(h, s, l) and interactive accent hsl(h - 1, s × 1.01, l × 1.075) in
    // light; hsl(h - 3, s × 1.02, l × 1.15) and hsl(h, s, l) in dark.
    test.each(["default", ...customAccents])("the focused composer border is at least 3:1 with the %s accent", (accent) => {
      const border = /border-color:\s*var\((--ss-[\w-]+)\)/
        .exec(rule(readCss("views/agent-workspace/composer.css"), ".systemsculpt-agent-prompt.is-focused"))?.[1];
      expect(border).toBeDefined();
      const [h, s, l] = convert.colorToHsl(accent === "default" ? "#000" : accent);
      const hsl = (dh: number, ks: number, kl: number) => `hsl(${h + dh}, ${Math.min(100, s * ks)}%, ${l * kl}%)`;
      const picked: Record<string, string> = accent === "default" ? {} : theme === "light"
        ? { "--text-accent": hsl(0, 1, 1), "--interactive-accent": hsl(-1, 1.01, 1.075) }
        : { "--text-accent": hsl(-3, 1.02, 1.15), "--interactive-accent": hsl(0, 1, 1) };
      const rgb = (token: string): Color =>
        convert.colorToRgb(`var(${token})`, { customProperty: { ...tokens, ...picked } });
      expect(contrast(rgb(border!), rgb("--ss-surface-0"))).toBeGreaterThanOrEqual(3);
    });
  });
});

describe("ChatView narrow run-line readability", () => {
  test("modes and hosted balances can wrap rather than lose their meaning to ellipsis", () => {
    const css = readCss("views/agent-workspace/shell.css");
    for (const selector of [
      ".systemsculpt-agent-run-segment.is-mode .systemsculpt-agent-run-label",
      '.systemsculpt-agent-run-segment.is-detail:not([aria-haspopup]) .systemsculpt-agent-run-label',
    ]) {
      const label = rule(css, selector);
      expect(label).toMatch(/white-space:\s*normal/);
      expect(label).toMatch(/overflow:\s*visible/);
      expect(label).toMatch(/overflow-wrap:\s*normal/);
    }
    // Keep mode words intact ("Full access", not "Full / acces / s").
    expect(rule(css, ".systemsculpt-agent-run-line .systemsculpt-agent-run-segment.is-mode"))
      .toMatch(/min-width:\s*min-content/);
    expect(css).toMatch(/\.is-detail:not\(\[aria-haspopup\]\) \.systemsculpt-agent-run-label\s*\{\s*overflow-wrap:\s*anywhere/);
    const segment = rule(css, ".systemsculpt-agent-run-line .systemsculpt-agent-run-segment");
    expect(segment).toMatch(/height:\s*auto/);
    expect(segment).toMatch(/min-height:\s*var\(--ss-control-height-sm\)/);
  });

  test("narrow spacing yields to text, not smaller touch targets", () => {
    const css = readCss("views/agent-workspace/shell.css");
    expect(css).toMatch(/@container ss-surface \(max-width: 439px\)\s*\{\s*\.systemsculpt-agent-run-line\s*\{\s*column-gap:\s*0;/);
    const coarse = css.slice(css.indexOf("@media (pointer: coarse)", css.indexOf(".systemsculpt-agent-run-line")));
    expect(rule(coarse, ".systemsculpt-agent-run-line .systemsculpt-agent-run-segment"))
      .toMatch(/min-width:\s*var\(--ss-touch-target\);\s*min-height:\s*var\(--ss-touch-target\)/);
  });
});

describe("ChatView error typography", () => {
  test("rebalances narrow error text without single-word ending lines", () => {
    expect(rule(readCss("views/agent-workspace/turn-errors.css"), ".systemsculpt-agent-error-message"))
      .toMatch(/text-wrap:\s*pretty/);
  });
});

describe("ChatView activity alignment", () => {
  test("keeps live, restored and tail-status labels on the same columns", () => {
    const activity = readCss("views/agent-workspace/activity.css");
    const tools = readCss("views/agent-workspace/tools.css");
    const reasoning = readCss("views/agent-workspace/reasoning.css");
    // Hoverable rows bleed their pill 4px past the column; the tail status has no pill.
    for (const [css, selector] of [
      [activity, "summary.systemsculpt-agent-activity-header"],
      [tools, ".systemsculpt-agent-conversation .systemsculpt-agent-tool-header"],
      [reasoning, ".systemsculpt-agent-reasoning-header"],
    ]) {
      const header = rule(css, selector);
      expect(header).toMatch(/gap:\s*var\(--ss-space-2\)/);
      expect(header).toMatch(/margin-inline:\s*calc\(-1 \* var\(--ss-space-1\)\)/);
      expect(header).toMatch(/padding:\s*0 var\(--ss-space-1\)/);
    }
    const tail = rule(activity, ".systemsculpt-agent-tail-status");
    expect(tail).toMatch(/gap:\s*var\(--ss-space-2\)/);
    expect(tail).toMatch(/padding:\s*0;/);
    // Same icon box everywhere, so every label starts on one column (14px icon + 8px gap).
    for (const [css, selector] of [
      [activity, ".systemsculpt-agent-tail-status-icon"],
      [activity, ".systemsculpt-agent-activity-overflow-icon"],
      [tools, ".systemsculpt-agent-conversation .systemsculpt-agent-tool-icon"],
      [reasoning, ".systemsculpt-agent-reasoning-icon"],
    ]) {
      expect(rule(css, selector)).toMatch(/width:\s*var\(--ss-icon-size-sm\)/);
    }
    // A fold's rows hang from its label column, under a hairline at its icon's centre.
    const body = rule(activity, ".systemsculpt-agent-activity-body");
    expect(body).toMatch(/margin:\s*var\(--ss-space-0\) 0 var\(--ss-space-1\) calc\(var\(--ss-icon-size-sm\) \/ 2 - 0\.5px\)/);
    expect(body).toMatch(/padding:\s*0 0 0 calc\(var\(--ss-icon-size-sm\) \/ 2 \+ var\(--ss-space-2\) - 0\.5px\)/);
    expect(body).toMatch(/border-left:\s*1px solid/);
  });

  test("start-aligns Provider values and keeps detection in the provider grid", () => {
    const settings = readCss("views/settings.css");
    const provider = rule(settings, ".ss-settings-surface .ss-codex-control select");
    expect(provider).toMatch(/text-align:\s*start/);
    expect(provider).toMatch(/text-align-last:\s*start/);
    const detect = rule(settings, ".ss-settings-surface .ss-agent-detection-action");
    expect(detect).toMatch(/grid-column:\s*1 \/ -1/);
    expect(detect).toMatch(/justify-self:\s*start/);
  });

  test("matches narrow native dropdowns to full-width text fields", () => {
    const settings = readCss("views/settings.css");
    const narrow = settings.slice(settings.indexOf("@container ss-surface (max-width: 520px)"), settings.indexOf("/* Mobile settings"));
    const dropdown = rule(narrow, ".systemsculpt-tab-content .setting-item-control > select");
    expect(dropdown).toMatch(/width:\s*100%/);
    expect(dropdown).toMatch(/text-align:\s*start/);
    expect(dropdown).toMatch(/text-align-last:\s*start/);
    expect(dropdown).toMatch(/padding-inline-start:\s*var\(--ss-space-2\)/);
    expect(dropdown).toMatch(/border:\s*var\(--input-border-width\) solid var\(--background-modifier-border\)/);
    expect(dropdown).toMatch(/background-color:\s*var\(--background-modifier-form-field\)/);
  });

  test("matches Provider card padding to the native preference cards", () => {
    expect(rule(readCss("views/settings.css"), ".ss-settings-surface .ss-codex-controls"))
      .toMatch(/padding:\s*calc\(var\(--ss-space-4\) - 1px\)/);
  });
});

describe("ChatView touch input and disclosure targets", () => {
  test.each([
    ["views/agent-workspace/composer.css", ".systemsculpt-agent-prompt > .systemsculpt-agent-prompt-input"],
    ["views/agent-workspace/approval.css", ".systemsculpt-agent-approval-details > summary"],
  ])("%s gives %s a full touch target without changing fine-pointer sizing", (path, selector) => {
    const css = readCss(path);
    const coarse = [...css.matchAll(/@media \(pointer: coarse\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)]
      .map(([, body]) => body).join("\n");
    expect(rule(coarse, selector)).toMatch(/min-height:\s*var\(--ss-touch-target\)/);
    expect(rule(css, selector)).not.toMatch(/min-height:\s*var\(--ss-touch-target\)/);
  });
});

describe("ChatView keyboard focus rules", () => {
  test("the post-cascade focus ring covers every interactive element, not just buttons", () => {
    const css = readCss("index.css");
    // :is borrows ID specificity, beating resting icon-button shadows with
    // multiple :not() classes as well as feature-specific focus rules.
    const selector = ":is(.ss-surface.systemsculpt-agent-workspace, #ss-specificity-boost) :focus-visible:not(.systemsculpt-agent-prompt-input)";
    const treatment = rule(css, selector);
    expect(treatment).toMatch(/outline:\s*2px solid var\(--ss-ink-accent\)/);
    expect(treatment).toMatch(/outline-offset:\s*2px/);
    expect(treatment).toMatch(/box-shadow:\s*var\(--ss-ring\)/);
    expect(css.indexOf(selector)).toBeGreaterThan(css.lastIndexOf("@import"));
  });

  test("the message box shows focus once, on its card", () => {
    // Only the composer textarea skips the chat-wide ring; its card draws focus instead.
    const index = readCss("index.css");
    expect(index.match(/:focus-visible:not\(([^)]*)\)/g)).toEqual([":focus-visible:not(.systemsculpt-agent-prompt-input)"]);
    const composer = readCss("views/agent-workspace/composer.css");
    const card = rule(composer, ".systemsculpt-agent-prompt.is-focused");
    expect(card).toMatch(/border-color:\s*var\(--ss-ink-accent\)/);
    expect(card).toMatch(/box-shadow:\s*var\(--ss-ring\)/);
    // Forced colours drop the shadow and repaint the border; the outline survives.
    expect(composer).toMatch(/@media \(forced-colors: active\)\s*\{\s*\.systemsculpt-agent-prompt\.is-focused\s*\{\s*outline:\s*2px solid;/);
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
