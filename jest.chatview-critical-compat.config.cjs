const criticalRisk = require("./jest.chatview-critical-risk.config.cjs");

module.exports = {
	...criticalRisk,
	displayName: "chatview-critical-compat",
	collectCoverage: false,
	collectCoverageFrom: [],
	coverageDirectory: undefined,
	coverageReporters: undefined,
	coverageThreshold: undefined,
};
