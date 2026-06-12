#!/usr/bin/env node
/**
 * Long-running host for the deterministic provider fixtures (issue #215).
 *
 * Starts every fixture server on an ephemeral port, writes their base URLs to
 * a JSON state file, then stays alive until SIGINT/SIGTERM. CI launches this
 * in the background before Obsidian starts so the vault's seeded
 * customProviders entry can point at a live local endpoint.
 *
 * Usage:
 *   node testing/fixtures/providers/serve.mjs --state-file ~/.systemsculpt-fixtures.json
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { startProviderFixtures } = require("./index.cjs");

function parseStateFile(argv) {
	const index = argv.indexOf("--state-file");
	if (index === -1 || !argv[index + 1]) {
		console.error("[provider-fixtures] --state-file <path> is required");
		process.exit(1);
	}
	return path.resolve(String(argv[index + 1]));
}

async function main() {
	const stateFile = parseStateFile(process.argv.slice(2));
	const fixtures = await startProviderFixtures();

	const state = {
		openrouter: fixtures.openrouter.url,
		ollama: fixtures.ollama.url,
		lmstudio: fixtures.lmstudio.url,
		whisper: fixtures.whisper.url,
		pid: process.pid,
		startedAt: new Date().toISOString(),
	};
	fs.mkdirSync(path.dirname(stateFile), { recursive: true });
	fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
	console.log(`[provider-fixtures] serving; state written to ${stateFile}`);
	console.log(`[provider-fixtures] openrouter=${state.openrouter} ollama=${state.ollama} lmstudio=${state.lmstudio} whisper=${state.whisper}`);

	const shutdown = async () => {
		await fixtures.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((error) => {
	console.error(`[provider-fixtures] failed to start: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
