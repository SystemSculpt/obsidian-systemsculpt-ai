const base = require("./jest.integration.config.cjs");

module.exports = {
  ...base,
  roots: ["<rootDir>/testing/native-endurance"],
  testMatch: ["**/*.test.ts"],
  transformIgnorePatterns: [
    "/node_modules/(?!(?:@ai-sdk|@standard-schema/spec|@workflow/serde|agents|ai|eventsource-parser|nanoid)/)",
    "<rootDir>/main\\.js$",
  ],
};
