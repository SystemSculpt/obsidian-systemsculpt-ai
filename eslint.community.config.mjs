import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// Mirror the public community-directory source scan instead of applying the
// repository's narrower edit-loop policy. The directory owns this ignore list.
export default defineConfig(
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/pkg/**",
    "**/test-vault/**",
    "**/.pnpm-store/**",
    "**/.obsidian/**",
    "**/automation/**",
    "**/test/**",
    "**/tests/**",
    "**/__tests__/**",
    "**/testUtils/**",
    "**/e2e-tests/**",
    "**/mocks/**",
    "**/__mocks__/**",
    "**/scripts/**",
    "**/docs/**",
    "**/i18n/**",
    "**/i18next/**",
    "**/locale/**",
    "**/locales/**",
    "**/translations/**",
    "**/l10n/**",
    "**/*.test.*",
    "**/*.tests.*",
    "**/*.spec.*",
    "**/*.specs.*",
    "**/*.cjs",
    "**/*.mjs",
    "**/*.cts",
    "**/*.mts",
  ]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The directory scan intentionally omits this high-noise family while
      // retaining the rest of the type-checked recommended configuration.
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "obsidianmd/settings-tab/prefer-setting-definitions": "off",
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          ignoreRegex: ["^(Ask Approval|Full Access)$"],
          ignoreWords: ["SystemSculpt", "Studio", "OS", "SRT", "Finder", "CEO", "Codex", "API"],
        },
      ],
    },
  },
);
