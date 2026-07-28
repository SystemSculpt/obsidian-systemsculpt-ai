const base = require("./jest.config.cjs");

const criticalRiskTests = [
	"<rootDir>/src/services/chat/__tests__/accepted-chat-request-snapshot.test.ts",
	"<rootDir>/src/services/chat/__tests__/managed-chat-projector-generative.test.ts",
	"<rootDir>/src/services/chat/__tests__/managed-chat-replay-contract.test.ts",
	"<rootDir>/src/services/chat/__tests__/managed-tool-execution.test.ts",
	"<rootDir>/src/views/chatview/storage/__tests__/ChatMarkdownSerializer.test.ts",
	"<rootDir>/src/views/chatview/__tests__/ChatStorageService.test.ts",
	"<rootDir>/src/views/chatview/__tests__/agent-transcript-repository.test.ts",
	"<rootDir>/src/views/chatview/__tests__/agent-chat-view-coordinator.test.ts",
	"<rootDir>/src/views/chatview/__tests__/agent-workspace-ui.test.ts",
	"<rootDir>/src/views/chatview/__tests__/managed-chat-runtime-adapter.test.ts",
	"<rootDir>/src/views/chatview/__tests__/managed-agent-controller.test.ts",
	"<rootDir>/src/views/chatview/__tests__/managed-agent-controller-runtime-seam.test.ts",
];

const criticalRiskCoverage = [
	"src/services/chat/AcceptedChatRequestSnapshot.ts",
	"src/services/chat/ManagedToolExecution.ts",
	"src/services/managed/adapters/HostedTransportAdapter.ts",
	"src/views/chatview/AgentTranscriptRepository.ts",
	"src/views/chatview/AgentChatView.ts",
	"src/views/chatview/AgentConversationRenderer.ts",
	"src/views/chatview/ChatStorageService.ts",
	"src/views/chatview/ManagedAgentController.ts",
	"src/views/chatview/storage/ChatFrontmatterIdentity.ts",
	"src/views/chatview/storage/ChatMarkdownSerializer.ts",
	"src/views/chatview/turn/ManagedChatRuntimeAdapter.ts",
];

module.exports = {
	...base,
	displayName: "chatview-critical-risk",
	maxWorkers: 1,
	testTimeout: 30000,
	testMatch: criticalRiskTests,
	collectCoverage: true,
	collectCoverageFrom: criticalRiskCoverage,
	coverageDirectory: "<rootDir>/.cache/coverage-chatview-critical-risk",
	coverageReporters: ["text-summary", "json-summary"],
	coverageThreshold: {
	"./src/services/chat/AcceptedChatRequestSnapshot.ts": {
		statements: -15,
		branches: -22,
			functions: -3,
			lines: -11,
		},
		"./src/services/chat/ManagedToolExecution.ts": {
			statements: 100,
			branches: 100,
			functions: 100,
			lines: 100,
		},
		"./src/services/managed/adapters/HostedTransportAdapter.ts": {
			statements: -22,
			branches: -35,
			functions: -9,
			lines: -16,
		},
	"./src/views/chatview/AgentTranscriptRepository.ts": {
		statements: -39,
		branches: -43,
			functions: -9,
			lines: -23,
		},
		"./src/views/chatview/AgentChatView.ts": {
			statements: -374,
			branches: -446,
			functions: -121,
			lines: -319,
		},
		"./src/views/chatview/AgentConversationRenderer.ts": {
			statements: -58,
			branches: -115,
			functions: -9,
			lines: -32,
		},
	"./src/views/chatview/ChatStorageService.ts": {
		statements: -78,
		branches: -80,
		functions: -10,
		lines: -65,
		},
	"./src/views/chatview/ManagedAgentController.ts": {
		statements: -85,
		branches: -112,
			functions: -4,
			lines: -66,
		},
	"./src/views/chatview/storage/ChatFrontmatterIdentity.ts": {
		statements: 100,
		branches: 100,
		functions: 100,
		lines: 100,
	},
	"./src/views/chatview/storage/ChatMarkdownSerializer.ts": {
		statements: -40,
		branches: -68,
		functions: -3,
		lines: -13,
	},
	"./src/views/chatview/turn/ManagedChatRuntimeAdapter.ts": {
		statements: -115,
		branches: -178,
		functions: -5,
		lines: -55,
	},
	},
};
