const mobile = require('./jest.mobile-interactions.config.cjs');
const critical = require('./jest.chatview-critical-risk.config.cjs');

// Standalone mobile checks retain all scenarios. Combined gates run shared
// suites in the critical partition, where they also contribute coverage.
module.exports = {
	...mobile,
	testMatch: mobile.testMatch.filter((suite) => !critical.testMatch.includes(suite))
};
