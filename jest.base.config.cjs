/** Shared transform and host setup for source and compiled-bundle tests. */
module.exports = {
	testEnvironment: 'node',
	moduleNameMapper: {
		'^obsidian$': '<rootDir>/src/tests/mocks/obsidian.js',
		'^@/(.*)$': '<rootDir>/src/$1',
		'^src/(.*)$': '<rootDir>/src/$1'
	},
	setupFilesAfterEnv: ['<rootDir>/src/tests/setup.ts'],
	moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'cjs', 'json', 'node'],
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
