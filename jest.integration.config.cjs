/**
 * Jest configuration for the built-bundle integration suite (issue #215).
 *
 * Unlike jest.config.cjs (source-level unit tests), this suite loads the
 * compiled `main.js` artifact and exercises it against the enriched host mock
 * in testing/integration/mocks/ plus deterministic managed fixtures in
 * testing/fixtures/managed/. Run via `npm run test:integration` (builds
 * first) or `npm run test:integration:ci` (assumes a fresh build).
 */

module.exports = {
	testEnvironment: 'node',
	roots: ['<rootDir>/testing/integration'],
	testMatch: ['**/*.test.ts'],
	testTimeout: 30000,
	moduleNameMapper: {
		'^obsidian$': '<rootDir>/testing/integration/mocks/obsidian-host.js',
		'^@/(.*)$': '<rootDir>/src/$1',
		'^src/(.*)$': '<rootDir>/src/$1'
	},
	setupFilesAfterEnv: ['<rootDir>/src/tests/setup.ts'],
	moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'cjs', 'json', 'node'],
	// The compiled bundle is already CommonJS — loading it through the
	// transformer would re-parse the production artifact for nothing. Preserve
	// Jest's default node_modules exclusion as well, so dependencies are not
	// needlessly recompiled by SWC.
	transformIgnorePatterns: [
		'<rootDir>/node_modules/',
		'<rootDir>/main\\.js$'
	],
	transform: {
		'^.+\\.(t|j)sx?$': [
			'@swc/jest',
			{
				jsc: {
					parser: { syntax: 'typescript', tsx: true, decorators: true },
					target: 'es2018'
				},
				module: { type: 'commonjs' },
				sourceMaps: 'inline'
			}
		]
	}
};
