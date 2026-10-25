import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

// eslint.config.mjs runs the repository policy and the community-directory
// scan in one type-aware pass. These tests hold it to both.

const root = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY_RULES = [
  "systemsculpt/no-restricted-globals",
  "systemsculpt/no-restricted-properties",
  "systemsculpt/ui/sentence-case",
];

function lintersFor(directory) {
  return {
    merged: new ESLint({ cwd: directory, overrideConfigFile: path.join(directory, "eslint.config.mjs") }),
    community: new ESLint({ cwd: directory, overrideConfigFile: path.join(directory, "eslint.community.config.mjs") }),
  };
}

async function inCommunityScan(community, file) {
  // lint:community scans src/**/*.{ts,tsx}.
  return /\.tsx?$/.test(file) && !(await community.isPathIgnored(file));
}

test("the merged lint applies the community scan exactly on every file it scans", async () => {
  const { merged, community } = lintersFor(root);
  const files = [...fs.globSync("src/**/*.{ts,tsx,mts,cts}", { cwd: root })]
    .map((file) => file.replace(/\\/g, "/"))
    .sort();
  let scanned = 0;
  for (const file of files) {
    if (!(await inCommunityScan(community, file))) continue;
    scanned += 1;
    assert.equal(await merged.isPathIgnored(file), false, `${file} must stay in the merged lint`);
    const expected = await community.calculateConfigForFile(file);
    const actual = await merged.calculateConfigForFile(file);
    for (const [ruleId, setting] of Object.entries(expected.rules)) {
      assert.deepEqual(actual.rules[ruleId], setting, `${file}: ${ruleId}`);
    }
    for (const [ruleId, setting] of Object.entries(actual.rules)) {
      if (ruleId in expected.rules || REPOSITORY_RULES.includes(ruleId)) continue;
      assert.equal(setting[0], 0, `${file}: ${ruleId} is outside both rule sets`);
    }
    assert.equal(actual.languageOptions.parser, expected.languageOptions.parser);
    assert.deepEqual(actual.languageOptions.parserOptions, expected.languageOptions.parserOptions);
    assert.deepEqual(actual.languageOptions.globals, expected.languageOptions.globals);
    assert.deepEqual(actual.linterOptions, expected.linterOptions);
  }
  assert.ok(scanned > 400, `only ${scanned} files matched the community scan`);
});

test("source outside the community scan keeps only the repository policy", async () => {
  const { merged, community } = lintersFor(root);
  for (const file of ["src/mocks/probe.ts", "src/i18n/en.ts", "src/views/probe.mts"]) {
    assert.equal(await inCommunityScan(community, file), false, file);
    assert.equal(await merged.isPathIgnored(file), false, file);
    const config = await merged.calculateConfigForFile(file);
    const enabled = Object.keys(config.rules).filter((ruleId) => config.rules[ruleId][0] !== 0);
    assert.deepEqual(
      enabled.filter((ruleId) => !ruleId.startsWith("obsidianmd/")).sort(),
      REPOSITORY_RULES,
      file,
    );
    assert.equal(config.rules["obsidianmd/ui/sentence-case"][0], 0, file);
    assert.equal(config.rules["obsidianmd/no-nodejs-modules"][0], 2, file);
  }
  for (const file of ["src/__tests__/probe.ts", "src/views/probe.test.ts", "src/tests/probe.ts"]) {
    assert.equal(await merged.isPathIgnored(file), true, file);
  }
});

test("one type-aware run reports the findings only each rule set catches", async () => {
  // A copy of both configs over a two-file program keeps the run fast while
  // linting with the exact configuration files the repository uses.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-eslint-")));
  try {
    for (const file of ["eslint.config.mjs", "eslint.community.config.mjs", "tsconfig.json", "manifest.json"]) {
      fs.copyFileSync(path.join(root, file), path.join(project, file));
    }
    fs.symlinkSync(path.join(root, "node_modules"), path.join(project, "node_modules"), "junction");
    // Only the directory scan flags a floating promise. Only the repository's
    // stricter sentence case lowercases the camelCase "NoteBook", and only its
    // dialog ban flags a reference to confirm that is not a call.
    const probe = [
      'import { Notice } from "obsidian";',
      "",
      "export const ask: unknown = confirm;",
      "",
      "export function seed(): void {",
      "  Promise.resolve(1);",
      '  new Notice("Open the NoteBook view");',
      "}",
      "",
    ].join("\n");
    fs.mkdirSync(path.join(project, "src", "mocks"), { recursive: true });
    fs.writeFileSync(path.join(project, "src", "probe.ts"), probe);
    fs.writeFileSync(path.join(project, "src", "mocks", "probe.ts"), probe);

    const { merged, community } = lintersFor(project);
    const ruleIds = (results, file) =>
      results
        .find((result) => result.filePath === path.join(project, file))
        .messages.map((message) => message.ruleId ?? message.message)
        .sort();

    const mergedResults = await merged.lintFiles(["src/**/*.ts"]);
    assert.deepEqual(ruleIds(mergedResults, "src/probe.ts"), [
      "@typescript-eslint/no-floating-promises",
      "systemsculpt/no-restricted-globals",
      "systemsculpt/ui/sentence-case",
    ]);
    // Outside the directory scan, only the repository policy runs.
    assert.deepEqual(ruleIds(mergedResults, "src/mocks/probe.ts"), [
      "systemsculpt/no-restricted-globals",
      "systemsculpt/ui/sentence-case",
    ]);

    // The standalone directory scan finds only its own half.
    const communityResults = await community.lintFiles(["src/**/*.ts"]);
    assert.deepEqual(
      communityResults.map((result) => path.relative(project, result.filePath).replace(/\\/g, "/")),
      ["src/probe.ts"],
    );
    assert.deepEqual(ruleIds(communityResults, "src/probe.ts"), ["@typescript-eslint/no-floating-promises"]);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
