/**
 * The embeddings service tree has its own focused gate. Embeddings UI and
 * tool suites outside that tree belong to the ordinary unit gate.
 */
const base = require('./jest.base.config.cjs');

module.exports = {
	...base,
	roots: ['<rootDir>/src'],
	testMatch: ['<rootDir>/src/services/embeddings/**/__tests__/**/*.test.ts']
};
