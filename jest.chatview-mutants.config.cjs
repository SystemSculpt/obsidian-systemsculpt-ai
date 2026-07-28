const path = require("node:path");
const base = require("./jest.config.cjs");

const requestedRoot = process.env.SYSTEMSCULPT_MUTANT_ROOT;
if (!requestedRoot) {
	throw new Error("SYSTEMSCULPT_MUTANT_ROOT is required for the curated mutation gate.");
}

const rootDir = path.resolve(requestedRoot);
const allowedParent = `${path.resolve(__dirname, ".cache", "chatview-mut")}${path.sep}`;
if (!`${rootDir}${path.sep}`.startsWith(allowedParent)) {
	throw new Error("The curated mutation root must be inside .cache/chatview-mut.");
}

const [transformPattern, transformDefinition] = Object.entries(base.transform)[0];
const [, transformOptions] = transformDefinition;

module.exports = {
	...base,
	displayName: "chatview-critical-mutants",
	rootDir,
	maxWorkers: 1,
	cache: false,
	collectCoverage: false,
	coverageThreshold: undefined,
	transform: {
		[transformPattern]: [require.resolve("@swc/jest"), transformOptions],
	},
};
