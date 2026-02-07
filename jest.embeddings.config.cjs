/**
 * Jest configuration for embeddings-only tests.
 *
 * Embeddings can be heavier/slower and are intentionally split out of the
 * default `npm test` path so everyday iteration stays fast.
 */

module.exports = {
	testEnvironment: 'node',
	roots: ['<rootDir>/src'],
	testMatch: [
		'**/__tests__/**/Embeddings*.test.ts',
		'services/embeddings/**/__tests__/**/*.test.ts'
	],
	moduleNameMapper: {
		'^obsidian$': '<rootDir>/src/tests/mocks/obsidian.js',
		'^@/(.*)$': '<rootDir>/src/$1',
		'^src/(.*)$': '<rootDir>/src/$1'
	},
	setupFilesAfterEnv: ['<rootDir>/src/tests/setup.ts'],
	moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
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
