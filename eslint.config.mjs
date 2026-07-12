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
            "^SystemSculpt/Studio$",
            "^Show a vim-style line number gutter",
            "^SRT subtitle file",
            "^Keep the Markdown/SRT picker visible",
          ],
          ignoreWords: ["SystemSculpt", "Studio", "OS", "SRT", "Finder"],
        },
      ],
      // The plugin is intentionally desktop-only and still exposes guarded Node-backed features.
      "obsidianmd/no-nodejs-modules": "off",
    },
  },
);
