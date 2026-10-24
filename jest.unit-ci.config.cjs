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
		...critical.testMatch,
		...mobile.testMatch,
	],
};
