const base = require("./jest.config.cjs");

const criticalRiskTests = [
	"<rootDir>/src/views/chatview/__tests__/agent-chat-view-codex.test.ts",
	"<rootDir>/src/core/diagnostics/__tests__/AgentIncidentCoordinator.test.ts",
	"<rootDir>/src/core/diagnostics/__tests__/AgentIncidentRecorder.test.ts",
	"<rootDir>/src/core/diagnostics/__tests__/AgentIncidentStore.test.ts",
	"<rootDir>/src/services/chat/__tests__/managed-tool-execution.test.ts",
	"<rootDir>/src/views/chatview/storage/__tests__/ChatMarkdownSerializer.test.ts",
	"<rootDir>/src/views/chatview/storage/__tests__/ChatPersistenceTypes.test.ts",
	"<rootDir>/src/views/chatview/__tests__/ChatStorageService.test.ts",
	"<rootDir>/src/views/chatview/__tests__/agent-chat-view-admission.test.ts",
	"<rootDir>/src/views/chatview/__tests__/agent-chat-view-close-barrier.test.ts",
	"<rootDir>/src/views/chatview/__tests__/agent-chat-view-fork-retry-integration.test.ts",
	"<rootDir>/src/views/chatview/__tests__/chat-1450-regression.acceptance.test.ts",
	"<rootDir>/src/views/chatview/__tests__/agent-conversation-presentation.test.ts",
	"<rootDir>/src/views/chatview/__tests__/agent-conversation-renderer-icons.test.ts",
	"<rootDir>/src/views/chatview/__tests__/agent-incident-report-regression.integration.test.ts",
	"<rootDir>/src/views/chatview/__tests__/agent-transcript-repository.test.ts",
	"<rootDir>/src/views/chatview/__tests__/agent-workspace-ui.test.ts",
	"<rootDir>/src/views/chatview/__tests__/live-markdown-renderer.test.ts",
	"<rootDir>/src/views/chatview/agent/__tests__/authoritative-session.test.ts",
	"<rootDir>/src/views/chatview/agent/__tests__/chat-session.test.ts",
	"<rootDir>/src/views/chatview/agent/__tests__/lifecycle.test.ts",
	"<rootDir>/src/views/chatview/agent/__tests__/message-adapter.test.ts",
	"<rootDir>/src/views/chatview/agent/__tests__/mutation-journal.test.ts",
	"<rootDir>/src/views/chatview/agent/__tests__/streaming-transport.test.ts",
];

const criticalRiskCoverage = [
	"src/core/diagnostics/AgentIncidentCoordinator.ts",
	"src/core/diagnostics/AgentIncidentRecorder.ts",
	"src/core/diagnostics/AgentIncidentStore.ts",
	"src/services/chat/ManagedToolExecution.ts",
	"src/views/chatview/AgentChatView.ts",
	"src/views/chatview/AgentConversationPresentation.ts",
	"src/views/chatview/AgentTranscriptRepository.ts",
	"src/views/chatview/AgentConversationRenderer.ts",
	"src/views/chatview/LiveMarkdownRenderer.ts",
	"src/views/chatview/ChatStorageService.ts",
	"src/views/chatview/storage/ChatFrontmatterIdentity.ts",
	"src/views/chatview/storage/ChatMarkdownSerializer.ts",
	"src/views/chatview/agent/AuthoritativeSession.ts",
	"src/views/chatview/agent/ChatSession.ts",
	"src/views/chatview/agent/Lifecycle.ts",
	"src/views/chatview/agent/MessageAdapter.ts",
	"src/views/chatview/agent/MutationJournal.ts",
	"src/views/chatview/agent/Protocol.ts",
	"src/views/chatview/agent/StreamingTransport.ts",
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
	coverageReporters: ["text-summary", "json", "json-summary"],
	coverageThreshold: {
		// Jest subtracts files that carry their own path threshold from the global
		// pool, so this floor governs the remaining critical ChatView modules as
		// one group. Measured on 2026-09-13 for that pool: statements 86.4%,
		// branches 82.5%, functions 86.0%, lines 88.7%. The floor sits a few points
		// below so it catches large regressions without ratcheting every edit.
		global: {
			statements: 82,
			branches: 78,
			functions: 82,
			lines: 84,
		},
		"./src/core/diagnostics/AgentIncidentCoordinator.ts": {
			statements: 80,
			branches: 60,
			functions: 85,
			lines: 80,
		},
		"./src/core/diagnostics/AgentIncidentRecorder.ts": {
			statements: 80,
			branches: 80,
			functions: 85,
			lines: 85,
		},
		"./src/core/diagnostics/AgentIncidentStore.ts": {
			statements: 75,
			branches: 70,
			functions: 90,
			lines: 90,
		},
		"./src/services/chat/ManagedToolExecution.ts": {
			statements: 100,
			branches: 100,
			functions: 100,
			lines: 100,
		},
		"./src/views/chatview/storage/ChatFrontmatterIdentity.ts": {
			statements: 100,
			branches: 100,
			functions: 100,
			lines: 100,
		},
	},
};
