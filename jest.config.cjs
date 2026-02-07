/**
 * Root Jest configuration for non-embeddings tests
 */

module.exports = {
	testEnvironment: 'node',
	roots: ['<rootDir>/src'],
	testMatch: ['**/__tests__/**/*.test.ts'],
	testPathIgnorePatterns: [
		'<rootDir>/src/services/embeddings/__tests__/',
		'<rootDir>/src/services/embeddings/'
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
	},
	collectCoverageFrom: [
		'src/**/*.ts',
		'!src/main.ts',
		'!src/components/**',
		'!src/modals/**',
		'!src/settings/**',
		'!src/views/**',
		'!src/quick-edit/**',
		'!src/core/plugin/**',
		'!src/core/ui/**',
		'!src/core/settings/*Modal.ts',
		'!src/services/recorder/**',
		'!src/services/AudioResampler.ts',
		'!src/services/PreviewService.ts',
		'!src/services/embeddings/**',
		'!src/**/__tests__/**',
		'!src/**/*.d.ts'
	]
};
