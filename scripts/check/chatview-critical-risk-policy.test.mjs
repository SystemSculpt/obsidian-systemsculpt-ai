import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = process.cwd();
const config = require(path.join(root, "jest.chatview-critical-risk.config.cjs"));
const compatConfig = require(path.join(root, "jest.chatview-critical-compat.config.cjs"));

const expectedTests = [
	"<rootDir>/src/services/chat/__tests__/managed-tool-execution.test.ts",
	"<rootDir>/src/views/chatview/storage/__tests__/ChatMarkdownSerializer.test.ts",
	"<rootDir>/src/views/chatview/storage/__tests__/ChatPersistenceTypes.test.ts",
	"<rootDir>/src/views/chatview/__tests__/ChatStorageService.test.ts",
	"<rootDir>/src/views/chatview/__tests__/agent-chat-view-admission.test.ts",
	"<rootDir>/src/views/chatview/__tests__/agent-chat-view-fork-retry-integration.test.ts",
	"<rootDir>/src/views/chatview/__tests__/agent-conversation-presentation.test.ts",
	"<rootDir>/src/views/chatview/__tests__/agent-conversation-renderer-icons.test.ts",
	"<rootDir>/src/views/chatview/__tests__/agent-transcript-repository.test.ts",
	"<rootDir>/src/views/chatview/__tests__/agent-workspace-ui.test.ts",
	"<rootDir>/src/views/chatview/__tests__/live-markdown-renderer.test.ts",
	"<rootDir>/src/views/chatview/agent/__tests__/first-party-agent-chat-session.test.ts",
	"<rootDir>/src/views/chatview/agent/__tests__/first-party-thin-agent-session.test.ts",
	"<rootDir>/src/views/chatview/agent/__tests__/first-party-thin-agent-session-transport.test.ts",
	"<rootDir>/src/views/chatview/agent/__tests__/thin-agent-mutation-journal.test.ts",
	"<rootDir>/src/views/chatview/agent/__tests__/thin-agent-message-adapter.test.ts",
];

const expectedCoverage = [
	"src/services/chat/ManagedToolExecution.ts",
	"src/views/chatview/AgentChatView.ts",
	"src/views/chatview/AgentConversationPresentation.ts",
	"src/views/chatview/AgentTranscriptRepository.ts",
	"src/views/chatview/AgentConversationRenderer.ts",
	"src/views/chatview/LiveMarkdownRenderer.ts",
	"src/views/chatview/ChatStorageService.ts",
	"src/views/chatview/storage/ChatFrontmatterIdentity.ts",
	"src/views/chatview/storage/ChatMarkdownSerializer.ts",
	"src/views/chatview/agent/FirstPartyAgentChatSession.ts",
	"src/views/chatview/agent/FirstPartyThinAgentProtocol.ts",
	"src/views/chatview/agent/FirstPartyThinAgentSession.ts",
	"src/views/chatview/agent/FirstPartyThinAgentSessionTransport.ts",
	"src/views/chatview/agent/ThinAgentMutationJournal.ts",
	"src/views/chatview/agent/ThinAgentMessageAdapter.ts",
];
const expectedThresholds = {
	"./src/services/chat/ManagedToolExecution.ts": {
		statements: 100,
		branches: 100,
		functions: 100,
		lines: 100,
	},
	"./src/views/chatview/AgentChatView.ts": {
		statements: -679,
		branches: -794,
		functions: -144,
		lines: -602,
	},
	"./src/views/chatview/AgentConversationPresentation.ts": {
		statements: -5,
		branches: -8,
		functions: 100,
		lines: -4,
	},
	"./src/views/chatview/AgentTranscriptRepository.ts": {
		statements: -50,
		branches: -55,
		functions: -12,
		lines: -35,
	},
	"./src/views/chatview/AgentConversationRenderer.ts": {
		statements: -65,
		branches: -130,
		functions: -12,
		lines: -40,
	},
	"./src/views/chatview/LiveMarkdownRenderer.ts": {
		statements: -54,
		branches: -94,
		functions: -1,
		lines: -34,
	},
	"./src/views/chatview/ChatStorageService.ts": {
		statements: -85,
		branches: -90,
		functions: -12,
		lines: -70,
	},
	"./src/views/chatview/storage/ChatFrontmatterIdentity.ts": {
		statements: 100,
		branches: 100,
		functions: 100,
		lines: 100,
	},
	"./src/views/chatview/storage/ChatMarkdownSerializer.ts": {
		statements: -45,
		branches: -75,
		functions: -5,
		lines: -20,
	},
	"./src/views/chatview/agent/FirstPartyAgentChatSession.ts": {
		statements: -232,
		branches: -420,
		functions: -21,
		lines: -181,
	},
	"./src/views/chatview/agent/FirstPartyThinAgentProtocol.ts": {
		statements: -96,
		branches: -120,
		functions: -6,
		lines: -87,
	},
	"./src/views/chatview/agent/FirstPartyThinAgentSession.ts": {
		statements: -55,
		branches: -67,
		functions: -2,
		lines: -42,
	},
	"./src/views/chatview/agent/FirstPartyThinAgentSessionTransport.ts": {
		statements: -52,
		branches: -62,
		functions: -7,
		lines: -39,
	},
	"./src/views/chatview/agent/ThinAgentMutationJournal.ts": {
		statements: -25,
		branches: -39,
		functions: -5,
		lines: -19,
	},
	"./src/views/chatview/agent/ThinAgentMessageAdapter.ts": {
		statements: -10,
		branches: -23,
		functions: -2,
		lines: -8,
	},
};

test("the ChatView critical-risk gate targets the thin native harness", () => {
	assert.equal(config.displayName, "chatview-critical-risk");
	assert.equal(config.maxWorkers, 1);
	assert.equal(config.collectCoverage, true);
	assert.deepEqual(config.testMatch, expectedTests);
	assert.deepEqual(config.collectCoverageFrom, expectedCoverage);
	assert.deepEqual(config.coverageReporters, ["text-summary", "json-summary"]);
	assert.equal(config.coverageDirectory, "<rootDir>/.cache/coverage-chatview-critical-risk");
	assert.equal(Object.hasOwn(config.coverageThreshold, "global"), false);
	assert.deepEqual(config.coverageThreshold, expectedThresholds);
});

test("the ChatView gate uses explicit per-file uncovered-count budgets", () => {
	for (const threshold of Object.values(config.coverageThreshold)) {
		for (const metric of ["statements", "branches", "functions", "lines"]) {
			assert.equal(typeof threshold[metric], "number");
			assert.ok(threshold[metric] === 100 || threshold[metric] <= 0);
		}
	}
});

test("the compatibility gate reuses the critical suites without coverage work", () => {
	assert.equal(compatConfig.displayName, "chatview-critical-compat");
	assert.deepEqual(compatConfig.testMatch, config.testMatch);
	assert.equal(compatConfig.collectCoverage, false);
	assert.deepEqual(compatConfig.collectCoverageFrom, []);
	assert.equal(compatConfig.coverageThreshold, undefined);
});
