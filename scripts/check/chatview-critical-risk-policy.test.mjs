import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = process.cwd();
const config = require(path.join(root, "jest.chatview-critical-risk.config.cjs"));
const compatConfig = require(path.join(root, "jest.chatview-critical-compat.config.cjs"));

const expectedTests = [
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

const expectedCoverage = [
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
const expectedThresholds = {
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
};

test("the ChatView critical-risk gate stays scoped to the intended surfaces", () => {
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

test("the ChatView critical-risk gate uses explicit per-file coverage budgets", () => {
	const fullyCoveredContractFiles = new Set([
		"./src/services/chat/ManagedToolExecution.ts",
		"./src/views/chatview/storage/ChatFrontmatterIdentity.ts",
	]);
	for (const [file, threshold] of Object.entries(config.coverageThreshold)) {
		assert.equal(typeof file, "string");
		assert.ok(file.startsWith("./src/"));
		assert.equal(typeof threshold, "object");
		for (const metric of ["statements", "branches", "functions", "lines"]) {
			assert.equal(typeof threshold[metric], "number");
			if (fullyCoveredContractFiles.has(file)) {
				assert.equal(threshold[metric], 100);
			} else {
				assert.ok(
					threshold[metric] <= 0,
					`${file} ${metric} must be enforced as a max uncovered-count budget`,
				);
			}
		}
	}
});

test("the compatibility gate reuses every critical suite without redundant coverage work", () => {
	assert.equal(compatConfig.displayName, "chatview-critical-compat");
	assert.deepEqual(compatConfig.testMatch, config.testMatch);
	assert.equal(compatConfig.collectCoverage, false);
	assert.deepEqual(compatConfig.collectCoverageFrom, []);
	assert.equal(compatConfig.coverageDirectory, undefined);
	assert.equal(compatConfig.coverageReporters, undefined);
	assert.equal(compatConfig.coverageThreshold, undefined);
});
