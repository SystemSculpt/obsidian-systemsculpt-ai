#!/usr/bin/env node
/**
 * CSS Lint Script for SystemSculpt
 *
 * Checks for CSS selectors that could leak into Obsidian's native UI.
 * Run with: node scripts/lint-css.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, "..");
const CSS_DIR = path.join(ROOT_DIR, "src", "css");

// ANSI colors
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

/**
 * Check if a selector is properly scoped to plugin containers
 */
function isScopedToPlugin(selector) {
  // Check if selector contains plugin-specific class/attribute after the Obsidian selector
  return /\.(systemsculpt-|ss-)/.test(selector) ||
         /\[data-type="systemsculpt-/.test(selector);
}

function stripComments(content) {
  return content.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " ")
  );
}

/**
 * Forbidden patterns that could affect Obsidian's native UI
 */
const FORBIDDEN_PATTERNS = [
  // Bare Obsidian selectors that DON'T contain plugin scoping
  {
    pattern: /^\.workspace-leaf-content\s+(?!\[data-type)/,
    check: (selector) => !isScopedToPlugin(selector),
    message: "Bare .workspace-leaf-content selector without plugin scoping - could affect other plugins",
    severity: "error",
  },
  {
    pattern: /^\.workspace(?!-leaf-content)/,
    check: (selector) => !isScopedToPlugin(selector),
    message: "Bare .workspace selector - could affect all workspace elements",
    severity: "error",
  },
  {
    pattern: /^\.nav-/,
    check: (selector) => !isScopedToPlugin(selector),
    message: "Bare .nav-* selector - could affect Obsidian's file explorer",
    severity: "error",
  },
  {
    pattern: /^\.tree-item/,
    check: (selector) => !isScopedToPlugin(selector),
    message: "Bare .tree-item selector - could affect Obsidian's file tree",
    severity: "error",
  },
  {
    pattern: /^\.file-explorer/,
    check: () => true, // Always forbidden
    message: ".file-explorer selector - directly targets Obsidian's file explorer",
    severity: "error",
  },
  // Bare attribute selectors without plugin scoping
  {
    pattern: /^\[role=/,
    check: (selector) => !isScopedToPlugin(selector),
    message: "Bare [role=] attribute selector - must scope to plugin containers",
    severity: "error",
  },
  {
    pattern: /^\[data-type=(?!"systemsculpt)/,
    check: () => true, // Always forbidden if not systemsculpt
    message: "Bare [data-type=] selector - must only target systemsculpt views",
    severity: "error",
  },
  {
    // Top-level class selectors whose leading class lacks a plugin prefix
    // (ss-/systemsculpt-) or a state prefix (is-/mod-). By the time a
    // selector reaches this check, extractSelectors has already stripped
    // the `{` and split comma lists, so this matches the bare selector
    // text. Compound selectors that START with a prefixed class or with
    // [data-type="systemsculpt-*"] scoping never match the `^.` anchor,
    // so they stay silent by construction.
    //
    // Promoted from warning to ERROR once the tree reached zero bare
    // classes: every top-level class must now carry the design-system
    // naming (ss-*/systemsculpt-*, or is-*/mod-* state grammar), and the
    // check:plugin/CI gate fails on any new bare class.
    pattern: /^\.(?!ss-|systemsculpt-|is-|mod-)[a-z][a-z0-9_-]*/,
    message: "Non-prefixed class - use an ss-* or systemsculpt-* prefix (state classes: is-*/mod-*)",
    severity: "error",
  },
];

const LEGACY_STATE_CLASS_PATTERN = /\.(active|completed|error|primary|danger|disabled|loading)(?![a-z0-9_-])/i;
const RUNTIME_CUSTOM_PROPERTIES = new Set([
  "--ss-link-flow-phase",
  "--ss-recorder-mobile-stack-offset",
  "--ss-studio-chip-color",
  "--ss-studio-swatch-color",
  "--ss-studio-text-node-font-size",
]);

/**
 * Allowed patterns (safe selectors)
 */
const ALLOWED_PATTERNS = [
  /^\.(systemsculpt-|ss-)/,                           // Plugin-prefixed classes
  /^\.workspace-leaf-content\[data-type="systemsculpt-/,  // Scoped to plugin views
  /^\.(theme-dark|theme-light)\s+\.(systemsculpt-|ss-)/, // Theme variations of plugin styles
  /^:root\s*\{/,                                      // CSS variables in :root
  /^@(keyframes|media|supports)/,                     // At-rules
  /^\*.*systemsculpt/,                                // Universal selectors scoped to plugin
];

/**
 * Parse a CSS file and extract selectors
 */
function extractSelectors(content, filePath) {
  const selectors = [];

  const noComments = stripComments(content);
  let prelude = "";
  let line = 1;
  let preludeLine = 1;
  let quote = null;
  let escaped = false;

  for (const char of noComments) {
    if (quote) {
      prelude += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      if (!prelude.trim()) preludeLine = line;
      quote = char;
      prelude += char;
    } else if (char === "{") {
      const selectorPart = prelude.trim();
      if (selectorPart && !selectorPart.startsWith("@")) {
        for (const selector of splitSelectorList(selectorPart)) {
          selectors.push({ selector, line: preludeLine, file: filePath });
        }
      }
      prelude = "";
    } else if (char === ";" || char === "}") {
      prelude = "";
    } else {
      if (!prelude.trim() && !/\s/.test(char)) preludeLine = line;
      prelude += char;
    }

    if (char === "\n") line++;
  }

  return selectors;
}

function splitSelectorList(value) {
  const selectors = [];
  let current = "";
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (const char of value) {
    if (quote) {
      current += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(" || char === "[") depth++;
    if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      if (current.trim()) selectors.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) selectors.push(current.trim());
  return selectors;
}

/**
 * Check a selector against patterns
 */
function checkSelector(selectorInfo) {
  const { selector, line, file } = selectorInfo;
  const issues = [];

  if (LEGACY_STATE_CLASS_PATTERN.test(selector)) {
    issues.push({
      severity: "error",
      message: "Legacy state class — use the canonical is-*/mod-* state grammar",
      selector,
      line,
      file,
    });
    return issues;
  }

  // Skip if allowed
  for (const allowed of ALLOWED_PATTERNS) {
    if (allowed.test(selector)) {
      return issues;
    }
  }

  // Check forbidden patterns
  for (const forbidden of FORBIDDEN_PATTERNS) {
    if (forbidden.pattern.test(selector)) {
      // If there's a check function, use it to determine if this is truly an issue
      const isIssue = forbidden.check ? forbidden.check(selector) : true;
      if (isIssue) {
        issues.push({
          severity: forbidden.severity,
          message: forbidden.message,
          selector,
          line,
          file,
        });
      }
    }
  }

  if (
    issues.length === 0 &&
    !isScopedToPlugin(selector) &&
    !/^:root\b/.test(selector) &&
    !/^(from|to|\d+(?:\.\d+)?%)$/.test(selector) &&
    !(file.endsWith("foundation/tokens.css") && /^body(?:\.[a-z0-9_-]+)?$/i.test(selector))
  ) {
    issues.push({
      severity: "error",
      message: "Global selector — scope it to an ss-* or systemsculpt-* surface",
      selector,
      line,
      file,
    });
  }

  return issues;
}

/* ------------------------------------------------------------------ *
 * Design-system rules
 *
 * The design system (src/css/foundation/tokens.css) is the single source
 * of visual truth. These rules keep component sheets on the tokens:
 * no raw colors, tokenized radii/font-sizes/shadows/transitions, z-index
 * from the layer scale, and `!important` only where a file has a
 * documented, load-bearing reason (allowlist below).
 * ------------------------------------------------------------------ */

/** Files exempt from token rules (they DEFINE the tokens/keyframes). */
const TOKEN_SOURCE_FILES = new Set(["foundation/tokens.css"]);

/** Files allowed to use !important, each for a documented reason. */
const IMPORTANT_ALLOWLIST = new Set([
  "foundation/surface.css", // hidden/reduced-motion contracts must beat feature sheets loaded later
  "views/studio/connections.css", // edge hover must beat inline SVG strokes
  "views/studio/node-chrome.css", // zoom-micro mode removes offscreen node chrome
  // Studio embeds Obsidian's native CodeMirror/table widgets. Their host
  // declarations include !important, so text-node parity cannot be scoped or
  // specificity-adjusted into effect without an equally strong override.
  "views/studio/text-nodes.css",
]);

/** font-size values allowed besides var(--ss-*)/var(--chat-*)/calc/inherit. */
const FONT_SIZE_LITERAL_ALLOW = new Set([
  "16px", // keeps narrow-window text inputs readable
  "inherit",
  "1em",
]);

const DECLARATION_RULES = [
  {
    property: /^(color|background|background-color|border(-\w+)*-color|border|border-top|border-right|border-bottom|border-left|outline|fill|stroke|caret-color|accent-color|text-decoration-color)$/,
    test: (value) =>
      /#[0-9a-fA-F]{3,8}\b/.test(value) ||
      /\b(rgb|rgba|hsl|hsla)\(/.test(value) ||
      /\b(black|white)\b/i.test(value),
    message: "Raw color (hex/rgb/hsl) — use a --ss-* token or color-mix of tokens",
  },
  {
    property: /^border-radius$/,
    test: (value) =>
      !/var\(--ss-radius|^(0|inherit|2px)$|^0 /.test(value.trim()),
    message: "border-radius must come from the --ss-radius-* scale",
  },
  {
    property: /^font-size$/,
    test: (value) => {
      const v = value.trim();
      if (FONT_SIZE_LITERAL_ALLOW.has(v)) return false;
      // --ss-studio-text-node-font-size is a runtime contract written by TS.
      return !/var\(--ss-text|var\(--chat-|var\(--ss-studio-text-node-font-size|^calc\(/.test(v);
    },
    message: "font-size must come from the --ss-text-* scale (or the chat font-scale vars)",
  },
  {
    property: /^box-shadow$/,
    test: (value) => {
      const v = value.trim();
      if (v === "none" || v === "inherit") return false;
      return !/var\(--ss-/.test(v);
    },
    message: "box-shadow must use --ss-elevation-*/--ss-ring (or token-based insets)",
  },
  {
    property: /^transition$/,
    test: (value) => {
      const v = value.trim();
      if (v === "none") return false;
      // Any raw duration literal (e.g. 0.2s / 150ms) outside tokens.
      return /(^|[\s,])\d+(\.\d+)?m?s\b/.test(v) && !/0\.01ms/.test(v);
    },
    message: "transition durations must use var(--ss-dur-*)",
  },
  {
    property: /^z-index$/,
    test: (value, cssPath) => {
      const v = value.trim();
      if (/var\(--ss-z|^calc\(/.test(v)) return false;
      const n = Number(v);
      // Studio canvas layer tiers (0-20) are a documented local scale.
      return !(
        cssPath.startsWith("views/studio") &&
        Number.isInteger(n) &&
        n >= -1 &&
        n <= 20
      );
    },
    message: "z-index must use the --ss-z-* layer scale (or studio's 0-20 canvas tiers)",
  },
];

/**
 * Lint declarations inside a CSS file against the design-system rules.
 */
function checkDeclarations(content, relPath) {
  const issues = [];
  const normalized = relPath.replace(/\\/g, "/");
  const cssPath = normalized.replace(/^src\/css\//, "");

  if (TOKEN_SOURCE_FILES.has(cssPath)) return issues;

  const noComments = content.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " ")
  );
  const lines = noComments.split("\n");

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const decl = line.match(/^\s*([a-z-]+)\s*:\s*([^;{}]+);?\s*$/);

    if (line.includes("!important") && !IMPORTANT_ALLOWLIST.has(cssPath)) {
      issues.push({
        severity: "error",
        message:
          "!important is not allowed here — remove it or add this file to IMPORTANT_ALLOWLIST with a documented reason",
        selector: line.trim(),
        line: lineNum,
        file: relPath,
      });
    }

    if (!decl) return;
    const [, property, rawValue] = decl;
    const value = rawValue.replace(/!important/g, "").trim();

    for (const rule of DECLARATION_RULES) {
      if (rule.property.test(property) && rule.test(value, cssPath)) {
        issues.push({
          severity: "error",
          message: rule.message,
          selector: `${property}: ${value}`,
          line: lineNum,
          file: relPath,
        });
      }
    }
  });

  return issues;
}

/**
 * Lint every CSS file under a directory.
 *
 * Pure (no process.exit, no console): scans `cssDir`, returns a structured
 * report so callers (the CLI below, and the check:plugin gate) can decide how
 * to surface results. This is what makes the guard testable.
 *
 * @param {{ cssDir: string }} options
 * @returns {{ errorCount: number, warningCount: number, fileCount: number, issues: Array<{severity: string, message: string, selector: string, line: number, file: string}> }}
 */
export function lintCssDirectory({ cssDir }) {
  const issues = [];
  let errorCount = 0;
  let warningCount = 0;

  const cssFiles = findCssFiles(cssDir);
  const contents = new Map(
    cssFiles.map((file) => [file, fs.readFileSync(file, "utf8")])
  );
  const uncommentedContents = new Map(
    [...contents].map(([file, content]) => [file, stripComments(content)])
  );
  const definedCustomProperties = new Set();
  for (const content of uncommentedContents.values()) {
    for (const match of content.matchAll(/(--ss-[a-z0-9-]+)\s*:/gi)) {
      definedCustomProperties.add(match[1]);
    }
  }

  for (const file of cssFiles) {
    const content = contents.get(file);
    const relPath = path.relative(ROOT_DIR, file);
    const selectors = extractSelectors(content, relPath);

    for (const sel of selectors) {
      for (const issue of checkSelector(sel)) {
        if (issue.severity === "error") errorCount++;
        if (issue.severity === "warning") warningCount++;
        issues.push(issue);
      }
    }

    for (const issue of checkDeclarations(content, relPath)) {
      if (issue.severity === "error") errorCount++;
      if (issue.severity === "warning") warningCount++;
      issues.push(issue);
    }

    const lines = uncommentedContents.get(file).split("\n");
    lines.forEach((sourceLine, index) => {
      for (const match of sourceLine.matchAll(/var\((--ss-[a-z0-9-]+)/gi)) {
        const property = match[1];
        if (
          !definedCustomProperties.has(property) &&
          !RUNTIME_CUSTOM_PROPERTIES.has(property)
        ) {
          errorCount++;
          issues.push({
            severity: "error",
            message: "Undefined --ss-* token — define it or register a real runtime contract",
            selector: property,
            line: index + 1,
            file: relPath,
          });
        }
      }
    });
  }

  return { errorCount, warningCount, fileCount: cssFiles.length, issues };
}

/**
 * Recursively find all CSS files
 */
function findCssFiles(dir) {
  const files = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...findCssFiles(fullPath));
    } else if (entry.name.endsWith(".css")) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Main function
 */
function main() {
  console.log(`${BOLD}CSS Lint - SystemSculpt${RESET}`);
  console.log("─".repeat(50));

  if (!fs.existsSync(CSS_DIR)) {
    console.error(`${RED}Error: CSS directory not found at ${CSS_DIR}${RESET}`);
    process.exit(1);
  }

  const { errorCount, warningCount, fileCount, issues } = lintCssDirectory({ cssDir: CSS_DIR });
  console.log(`Found ${fileCount} CSS files\n`);

  const issuesByFile = new Map();
  for (const issue of issues) {
    if (!issuesByFile.has(issue.file)) {
      issuesByFile.set(issue.file, []);
    }
    issuesByFile.get(issue.file).push(issue);
  }

  // Report issues
  for (const [file, issues] of issuesByFile) {
    console.log(`${BOLD}${file}${RESET}`);

    for (const issue of issues) {
      const color = issue.severity === "error" ? RED : YELLOW;
      const prefix = issue.severity === "error" ? "ERROR" : "WARN";
      console.log(`  ${color}${prefix}${RESET} Line ${issue.line}: ${issue.message}`);
      console.log(`         Selector: ${issue.selector}`);
    }
    console.log();
  }

  // Summary
  console.log("─".repeat(50));
  if (errorCount === 0 && warningCount === 0) {
    console.log(`${GREEN}✓ All CSS selectors are properly scoped${RESET}`);
  } else {
    if (errorCount > 0) {
      console.log(`${RED}✗ ${errorCount} error(s)${RESET}`);
    }
    if (warningCount > 0) {
      console.log(`${YELLOW}⚠ ${warningCount} warning(s)${RESET}`);
    }
  }

  // Exit with error code if there are errors
  if (errorCount > 0) {
    process.exit(1);
  }
}

// Run the CLI only when invoked directly (e.g. `node scripts/lint-css.mjs`),
// not when imported (the check:plugin gate and the guard test import
// lintCssDirectory instead).
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
