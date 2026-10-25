/**
 * Built-bundle integration tests load the production main.js with the enriched
 * host mock. test:integration builds first; test:integration:ci reuses the build.
 */
const base = require('./jest.base.config.cjs');

module.exports = {
	...base,
	roots: ['<rootDir>/testing/integration'],
	testMatch: ['**/*.test.ts'],
	testTimeout: 30000,
	setupFilesAfterEnv: [...base.setupFilesAfterEnv, '<rootDir>/testing/integration/host-setup.ts'],
	moduleNameMapper: {
		...base.moduleNameMapper,
		'^obsidian$': '<rootDir>/testing/integration/mocks/obsidian-host.js'
	},
	// Load the compiled artifact unchanged; keep dependencies out of SWC too.
	transformIgnorePatterns: [
		'<rootDir>/node_modules/',
		'<rootDir>/main\\.js$'
	]
};
