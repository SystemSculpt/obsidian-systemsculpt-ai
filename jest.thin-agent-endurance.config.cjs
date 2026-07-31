const base = require("./jest.integration.config.cjs");

module.exports = {
  ...base,
  roots: ["<rootDir>/testing/native-endurance"],
  testMatch: ["**/*.test.ts"],
};
