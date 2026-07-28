const base = require("./jest.config.cjs");

const mobileInteractionTests = [
	"<rootDir>/src/platform/__tests__/hostCapabilities.test.ts",
	"<rootDir>/src/platform/__tests__/mobileLayout.test.ts",
	"<rootDir>/src/platform/__tests__/mobileHostLayout.test.ts",
	"<rootDir>/src/core/ui/surface/__tests__/PluginSurface.test.ts",
	"<rootDir>/src/views/chatview/__tests__/agent-workspace-ui.test.ts",
	"<rootDir>/src/views/chatview/__tests__/agent-workspace-css-contract.test.ts",
	"<rootDir>/src/views/chatview/__tests__/anchored-scroller.test.ts",
	"<rootDir>/src/views/__tests__/similar-notes-css-contract.test.ts",
	"<rootDir>/src/views/studio/__tests__/studio-node-insert-menu.test.ts",
	"<rootDir>/src/views/studio/__tests__/studio-run-host-preflight.test.ts",
	"<rootDir>/src/views/studio/__tests__/studio-context-menu-accessibility.test.ts",
	"<rootDir>/src/views/studio/graph-v3/__tests__/studio-surface-css-contract.test.ts",
	"<rootDir>/src/views/studio/graph-v3/__tests__/studio-graph-workspace-renderer-controls.test.ts",
	"<rootDir>/src/__tests__/systemsculpt-settings-tab.test.ts",
];

module.exports = {
	...base,
	displayName: "mobile-interactions",
	maxWorkers: 1,
	testMatch: mobileInteractionTests,
	collectCoverage: false,
};
