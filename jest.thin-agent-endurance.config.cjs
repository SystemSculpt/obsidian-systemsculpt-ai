const base = require("./jest.integration.config.cjs");

module.exports = {
  ...base,
  roots: ["<rootDir>/testing/agent-endurance"],
  testMatch: ["**/*.test.ts"],
};
