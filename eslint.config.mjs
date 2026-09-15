import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import obsidianmd from "eslint-plugin-obsidianmd";

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
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx,cts,mts}"],
    rules: {
      ...nonObsidianRecommendedRules,
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          enforceCamelCaseLower: true,
          // Preserve product/technical names and exact quoted control labels.
          ignoreRegex: [
            "^(Ask Approval|Full Access)$",
            "^SystemSculpt/Studio$",
            "^SystemSculpt API$",
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
      "no-restricted-globals": [
        "error",
        ...BROWSER_DIALOGS.map((name) => ({ name, message: BROWSER_DIALOG_MESSAGE })),
      ],
      "no-restricted-properties": [
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
      "no-restricted-globals": "off",
      "no-restricted-properties": "off",
    },
  },
);
