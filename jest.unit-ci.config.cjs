const base = require("./jest.config.cjs");
const critical = require("./jest.chatview-critical-risk.config.cjs");
const mobile = require("./jest.mobile-interactions.config.cjs");

module.exports = {
	...base,
	displayName: "unit-ci-remainder",
	maxWorkers: 1,
	collectCoverage: false,
	testPathIgnorePatterns: [
		...base.testPathIgnorePatterns,
		// The dedicated embeddings gate also owns named suites outside its source tree.
		"/__tests__/(?:.*/)?Embeddings[^/]*\\.test\\.ts$",
		...critical.testMatch,
		...mobile.testMatch,
	],
};
