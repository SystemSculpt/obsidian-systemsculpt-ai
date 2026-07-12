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
		'^@mariozechner/pi-coding-agent$': '<rootDir>/src/tests/mocks/pi-coding-agent.js',
		'^@mariozechner/pi-ai$': '<rootDir>/node_modules/@mariozechner/pi-ai/dist/index.js',
		'^@mariozechner/pi-ai/oauth$': '<rootDir>/node_modules/@mariozechner/pi-ai/dist/oauth.js',
		'^@/(.*)$': '<rootDir>/src/$1',
		'^src/(.*)$': '<rootDir>/src/$1'
	},
	setupFilesAfterEnv: ['<rootDir>/src/tests/setup.ts'],
	moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'cjs', 'json', 'node'],
	// The compiled bundle is already CommonJS — loading it through the
	// transformer would re-parse ~14MB for nothing. Everything else matches
	// the root config.
	transformIgnorePatterns: [
		'node_modules/(?!@mariozechner/pi-coding-agent|@mariozechner/pi-ai)',
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
