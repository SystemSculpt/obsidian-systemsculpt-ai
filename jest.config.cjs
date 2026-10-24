/**
 * Root Jest configuration for non-embeddings tests
 */

const base = require('./jest.base.config.cjs');

module.exports = {
	...base,
	roots: ['<rootDir>/src'],
	testMatch: ['**/__tests__/**/*.test.ts'],
	testPathIgnorePatterns: [
		'<rootDir>/src/services/embeddings/__tests__/',
		'<rootDir>/src/services/embeddings/'
	],
	collectCoverageFrom: [
		'src/**/*.ts',
		'!src/main.ts',
		'!src/components/**',
		'!src/modals/**',
		'!src/settings/**',
		'!src/views/**',
		'!src/core/plugin/**',
		'!src/core/ui/**',
		'!src/core/settings/*Modal.ts',
		'!src/services/recorder/**',
		'!src/services/embeddings/**',
		'!src/**/__tests__/**',
		'!src/**/*.d.ts'
	]
};
