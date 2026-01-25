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
];

/**
 * Patterns that warn about non-prefixed classes (may need migration)
 */
const WARNING_PATTERNS = [
  {
    // Class definitions that don't start with systemsculpt- or ss-
    pattern: /^\.[a-z][a-z0-9-]*\s*[{,]/,
    exception: /^\.(systemsculpt-|ss-|theme-|modal\.|is-|has-)/,
    message: "Non-prefixed class - consider using ss-* or systemsculpt-* prefix",
    severity: "warning",
  },
];

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

  // Remove comments
  const noComments = content.replace(/\/\*[\s\S]*?\*\//g, "");

  // Split by lines for better error reporting
  const lines = noComments.split("\n");

  let lineNum = 0;
  let inBlock = 0;

  for (const line of lines) {
    lineNum++;
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Track block depth
    const openBraces = (trimmed.match(/{/g) || []).length;
    const closeBraces = (trimmed.match(/}/g) || []).length;

    // Only check selectors at block depth 0 (top-level)
    if (inBlock === 0 && trimmed && !trimmed.startsWith("@") && !trimmed.startsWith("}") && !trimmed.startsWith("/*")) {
      // This could be a selector line
      const selectorPart = trimmed.split("{")[0].trim();
      if (selectorPart && !selectorPart.includes(":") || selectorPart.includes(".") || selectorPart.includes("[")) {
        // Split comma-separated selectors
        const individualSelectors = selectorPart.split(",").map(s => s.trim());
        for (const sel of individualSelectors) {
          if (sel) {
            selectors.push({
              selector: sel,
              line: lineNum,
              file: filePath,
            });
          }
        }
      }
    }

    inBlock += openBraces - closeBraces;
    if (inBlock < 0) inBlock = 0;
  }

  return selectors;
}

/**
 * Check a selector against patterns
 */
function checkSelector(selectorInfo) {
  const { selector, line, file } = selectorInfo;
  const issues = [];

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

  // Check warning patterns
  for (const warn of WARNING_PATTERNS) {
    if (warn.pattern.test(selector)) {
      if (!warn.exception || !warn.exception.test(selector)) {
        issues.push({
          severity: warn.severity,
          message: warn.message,
          selector,
          line,
          file,
        });
      }
    }
  }

  return issues;
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

  const cssFiles = findCssFiles(CSS_DIR);
  console.log(`Found ${cssFiles.length} CSS files\n`);

  let errorCount = 0;
  let warningCount = 0;
  const issuesByFile = new Map();

  for (const file of cssFiles) {
    const content = fs.readFileSync(file, "utf8");
    const relPath = path.relative(ROOT_DIR, file);
    const selectors = extractSelectors(content, relPath);

    for (const sel of selectors) {
      const issues = checkSelector(sel);

      for (const issue of issues) {
        if (issue.severity === "error") errorCount++;
        if (issue.severity === "warning") warningCount++;

        if (!issuesByFile.has(relPath)) {
          issuesByFile.set(relPath, []);
        }
        issuesByFile.get(relPath).push(issue);
      }
    }
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

main();
