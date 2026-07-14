import { defineConfig } from "eslint/config";
import json from "@eslint/json";
import obsidianmd from "eslint-plugin-obsidianmd";
import { PlainTextParser } from "eslint-plugin-obsidianmd/dist/lib/plainTextParser.js";

export default defineConfig([
  {
    files: ["manifest.json"],
    plugins: {
      json,
      obsidianmd,
    },
    language: "json/json",
    rules: {
      "obsidianmd/validate-manifest": "warn",
    },
  },
  {
    files: ["LICENSE"],
    plugins: {
      obsidianmd,
    },
    languageOptions: {
      parser: PlainTextParser,
    },
    rules: {
      "obsidianmd/validate-license": "warn",
    },
  },
]);
