#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * Generates the canonical `data-testid` catalog from source.
 *
 * Every interactive element carries a dot-namespaced testid (see
 * UiActionOptions.testId). This script extracts those identities statically
 * and writes the sorted catalog consumed by `npm run e2e -- targets` and
 * validated for freshness by the script gate. Dynamic segments become `*`
 * wildcards (for example `studio.config.option.*`).
 */

export const TESTID_CATALOG_PATH = "testing/e2e/testid-catalog.json";

export const TESTID_GRAMMAR = /^[a-z][a-z0-9-]*(\.([a-z0-9-]+|\*))+$/;

/** Wrapper factories whose call sites carry a positional testid argument. */
const POSITIONAL_WRAPPERS = [
  "addActionButton",
  "addSearchBar",
  "addStateAction",
  "createTabButton",
  "createButton",
  "createToggle",
  "createToolbarButton",
  "createIconButton",
  "createOutputOption",
  "createOutputPresetOption",
  "iconButton",
  "button",
];

function wildcardTemplate(raw) {
  return raw.replace(/\$\{[^}]*\}/g, "*").replace(/\*+/g, "*");
}

function collectLiteralIds(text, ids) {
  for (const match of text.matchAll(/\btestId: "([^"]+)"/g)) {
    ids.add(match[1]);
  }
  for (const match of text.matchAll(/\btestId: `([^`]+)`/g)) {
    ids.add(wildcardTemplate(match[1]));
  }
  for (const match of text.matchAll(/"data-testid": "([^"]+)"/g)) {
    ids.add(match[1]);
  }
  for (const match of text.matchAll(/"data-testid": `([^`]+)`/g)) {
    ids.add(wildcardTemplate(match[1]));
  }
}

function collectPositionalIds(text, ids) {
  const namePattern = POSITIONAL_WRAPPERS.join("|");
  const callPattern = new RegExp(`\\b(?:this\\.)?(?:${namePattern})\\(`, "g");
  for (const match of text.matchAll(callPattern)) {
    const window = text.slice(match.index, match.index + 400);
    const literals = window.matchAll(/"([^"\n]+)"|`([^`\n]+)`/g);
    let inspected = 0;
    for (const literal of literals) {
      if (inspected >= 4) break;
      inspected += 1;
      const value = literal[1] ?? wildcardTemplate(literal[2] ?? "");
      if (TESTID_GRAMMAR.test(value)) {
        ids.add(value);
        break;
      }
    }
  }
}

function listSourceFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__" || entry.name === "tests") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) files.push(full);
    }
  };
  walk(root);
  return files.sort();
}

export function generateTestIdCatalog({ root = process.cwd() } = {}) {
  const ids = new Set();
  const invalid = new Set();
  for (const file of listSourceFiles(path.join(root, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    const fileIds = new Set();
    collectLiteralIds(text, fileIds);
    collectPositionalIds(text, fileIds);
    for (const id of fileIds) {
      if (TESTID_GRAMMAR.test(id)) ids.add(id);
      else invalid.add(`${path.relative(root, file)}: ${id}`);
    }
  }
  if (invalid.size > 0) {
    throw new Error(
      "Invalid testid values (must be dot-namespaced lowercase, e.g. chat.composer.send):\n" +
        [...invalid].sort().join("\n"),
    );
  }
  return {
    version: 1,
    grammar: TESTID_GRAMMAR.source,
    ids: [...ids].sort(),
  };
}

export function writeTestIdCatalog({ root = process.cwd() } = {}) {
  const catalog = generateTestIdCatalog({ root });
  const outPath = path.join(root, TESTID_CATALOG_PATH);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return catalog;
}

export function checkTestIdCatalog({ root = process.cwd() } = {}) {
  const expected = `${JSON.stringify(generateTestIdCatalog({ root }), null, 2)}\n`;
  const outPath = path.join(root, TESTID_CATALOG_PATH);
  let actual = "";
  try {
    actual = fs.readFileSync(outPath, "utf8");
  } catch {
    throw new Error(`${TESTID_CATALOG_PATH} is missing. Run: node scripts/e2e/generate-testid-catalog.mjs`);
  }
  if (actual !== expected) {
    throw new Error(
      `${TESTID_CATALOG_PATH} is stale. Run: node scripts/e2e/generate-testid-catalog.mjs`,
    );
  }
  return true;
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (invokedDirectly) {
  if (process.argv.includes("--check")) {
    checkTestIdCatalog();
    console.log(`[testid-catalog] ${TESTID_CATALOG_PATH} is up to date.`);
  } else {
    const catalog = writeTestIdCatalog();
    console.log(`[testid-catalog] Wrote ${catalog.ids.length} ids to ${TESTID_CATALOG_PATH}.`);
  }
}
