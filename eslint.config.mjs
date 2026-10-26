import { defineConfig, globalIgnores } from "eslint/config";
import { builtinRules } from "eslint/use-at-your-own-risk";
import obsidianmd from "eslint-plugin-obsidianmd";
import { communityScan, communityScanIgnores } from "./eslint.community.config.mjs";

// One type-aware pass, one TypeScript program, two rule sets:
// - the repository's runtime policy over all source: Obsidian's own rules,
//   stricter sentence case, and the browser-dialog bans;
// - the community-directory scan, exactly as eslint.community.config.mjs
//   defines it, over the files that scan covers.

const recommendedRuleIds = [
  ...new Set(
    obsidianmd.configs.recommended.flatMap((config) =>
      Object.keys(config.rules ?? {}),
    ),
  ),
];

const nonObsidianRecommendedRules = Object.fromEntries(
  recommendedRuleIds
    .filter((ruleId) => !ruleId.startsWith("obsidianmd/"))
    .map((ruleId) => [ruleId, "off"]),
);

const BROWSER_DIALOGS = ["prompt", "confirm", "alert"];
const BROWSER_DIALOG_MESSAGE =
  "Browser dialogs are banned in runtime source. Use Studio view-native inputs or the shared prompt surface instead.";

// The scan also configures sentence case and no-restricted-globals, with other
// options. The repository's copies of those rules, and the dialog property ban
// that goes with them, run under the systemsculpt/ name so that the scan never
// replaces them and each configuration reports its own findings.
const repositoryPolicy = {
  meta: { name: "systemsculpt-repository-policy" },
  rules: {
    "ui/sentence-case": obsidianmd.rules["ui/sentence-case"],
    "no-restricted-globals": builtinRules.get("no-restricted-globals"),
    "no-restricted-properties": builtinRules.get("no-restricted-properties"),
  },
};

export default defineConfig(
  globalIgnores([
    "node_modules",
    "dist",
    "coverage",
    "artifacts",
    "main.js",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "jest.config.cjs",
    "jest.integration.config.cjs",
    "jest.embeddings.config.cjs",
    "src/**/*.js",
    "src/tests/**",
    "src/**/__tests__/**",
    "src/**/*.test.ts",
    "src/**/*.test.tsx",
    "src/**/*.test.cts",
    "src/**/*.test.mts",
    "src/tests/mocks/**",
  ]),
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx,cts,mts}"],
    plugins: {
      systemsculpt: repositoryPolicy,
    },
    rules: {
      ...nonObsidianRecommendedRules,
      // The scan restores its own sentence case on the files it covers.
      "obsidianmd/ui/sentence-case": "off",
      "systemsculpt/ui/sentence-case": [
        "warn",
        {
          enforceCamelCaseLower: true,
          // Preserve product/technical names and exact quoted control labels.
          ignoreRegex: [
            "^(Ask Approval|Full Access)$",
            "^SystemSculpt/Studio$",
            "^SystemSculpt(?: API)?$",
            "^Finding Claude Code or Codex…$",
            "^SystemSculpt settings$",
            "Claude Code",
            "^Show a vim-style line number gutter",
            "^SRT subtitle file",
            "^Keep the Markdown/SRT picker visible",
          ],
          ignoreWords: ["SystemSculpt", "Studio", "OS", "SRT", "Finder", "CEO", "Codex", "API"],
        },
      ],
      // Runtime modules must remain loadable in Obsidian Mobile. Desktop Node
      // adapters are isolated in the host seam configured below.
      "obsidianmd/no-nodejs-modules": "error",
      // Obsidian 1.13 treats definitions as the complete renderer. Keep the
      // full imperative settings UI until every dynamic control has parity.
      "obsidianmd/settings-tab/prefer-setting-definitions": "off",
      // Browser dialogs block the host UI thread and are not portable to
      // Obsidian Mobile. Bare, window., and globalThis. forms are all banned.
      "systemsculpt/no-restricted-globals": [
        "error",
        ...BROWSER_DIALOGS.map((name) => ({ name, message: BROWSER_DIALOG_MESSAGE })),
      ],
      "systemsculpt/no-restricted-properties": [
        "error",
        ...["window", "globalThis"].flatMap((object) =>
          BROWSER_DIALOGS.map((property) => ({
            object,
            property,
            message: BROWSER_DIALOG_MESSAGE,
          })),
        ),
      ],
    },
  },
  {
    // The directory scan still checks this file with its own setting.
    files: ["src/platform/desktopOnly.ts"],
    rules: {
      "obsidianmd/no-nodejs-modules": "off",
    },
  },
  {
    // src/testing hosts the development-only test driver and stays outside the
    // runtime dialog policy.
    files: ["src/testing/**"],
    rules: {
      "systemsculpt/no-restricted-globals": "off",
      "systemsculpt/no-restricted-properties": "off",
    },
  },
  // Later configs win, so on the files the directory scans this restores every
  // rule and option the scan sets. Its ignores scope it instead of ending the run.
  ...communityScan.map((config) => ({
    ...config,
    ignores: [...(config.ignores ?? []), ...communityScanIgnores],
  })),
);
