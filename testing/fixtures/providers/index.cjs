/**
 * Deterministic provider fixture servers for integration and smoke tests
 * (issue #215). Plain node:http, no dependencies, ephemeral ports.
 *
 * Servers:
 *  - OpenRouter-compatible: GET /api/v1/models, POST /api/v1/chat/completions
 *    (JSON or SSE stream when `stream: true`)
 *  - Ollama:                GET /api/tags, POST /api/chat
 *  - LM Studio (OpenAI):    GET /v1/models, POST /v1/chat/completions
 *  - Whisper reference:     POST /v1/audio/transcriptions
 *
 * Usage (CJS so both jest and plain-node consumers can load it):
 *   const { startProviderFixtures } = require("./index.cjs")
 *   const fixtures = await startProviderFixtures()
 *   fixtures.openrouter.url // http://127.0.0.1:<port>
 *   await fixtures.close()
 */
const http = require("node:http");

const FIXTURE_COMPLETION_TEXT = "fixture-completion: hello from the mock provider";
const FIXTURE_TRANSCRIPT_TEXT = "fixture-transcript: hello from the mock whisper";

const OPENROUTER_FIXTURE_MODELS = [
	{ id: "openai/gpt-5.4-mini", name: "GPT-5.4 Mini (fixture)", context_length: 400000 },
	{ id: "anthropic/claude-fable-5", name: "Claude Fable 5 (fixture)", context_length: 1000000 },
];

const OLLAMA_FIXTURE_MODELS = [
	{ name: "llama3.2:latest", model: "llama3.2:latest", size: 2019393189 },
	{ name: "qwen2.5-coder:7b", model: "qwen2.5-coder:7b", size: 4683087332 },
];

const LMSTUDIO_FIXTURE_MODELS = [
	{ id: "qwen/qwen3-8b", object: "model", owned_by: "organization_owner" },
];

function readBody(req) {
	return new Promise((resolve) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
		});
		req.on("end", () => resolve(data));
	});
}

function sendJson(res, status, body) {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

function openAiCompletion(model) {
	return {
		id: "chatcmpl-fixture-1",
		object: "chat.completion",
		created: 1750000000,
		model,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: FIXTURE_COMPLETION_TEXT },
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 },
	};
}

function sendOpenAiStream(res, model) {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	const chunk = {
		id: "chatcmpl-fixture-1",
		object: "chat.completion.chunk",
		created: 1750000000,
		model,
		choices: [{ index: 0, delta: { role: "assistant", content: FIXTURE_COMPLETION_TEXT }, finish_reason: null }],
	};
	const done = {
		...chunk,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	};
	res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write(`data: ${JSON.stringify(done)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
}

async function handleOpenAiChat(req, res) {
	const raw = await readBody(req);
	let parsed = {};
	try {
		parsed = JSON.parse(raw || "{}");
	} catch {
		return sendJson(res, 400, { error: { message: "invalid JSON body" } });
	}
	const model = String(parsed.model || "fixture-model");
	if (parsed.stream === true) {
		return sendOpenAiStream(res, model);
	}
	return sendJson(res, 200, openAiCompletion(model));
}

function createOpenRouterServer() {
	return http.createServer(async (req, res) => {
		const url = new URL(req.url, "http://fixture");
		if (req.method === "GET" && (url.pathname === "/api/v1/models" || url.pathname === "/models")) {
			return sendJson(res, 200, { data: OPENROUTER_FIXTURE_MODELS });
		}
		if (req.method === "POST" && (url.pathname === "/api/v1/chat/completions" || url.pathname === "/chat/completions")) {
			return handleOpenAiChat(req, res);
		}
		return sendJson(res, 404, { error: { message: `no fixture route for ${req.method} ${url.pathname}` } });
	});
}

function createOllamaServer() {
	return http.createServer(async (req, res) => {
		const url = new URL(req.url, "http://fixture");
		if (req.method === "GET" && url.pathname === "/api/tags") {
			return sendJson(res, 200, { models: OLLAMA_FIXTURE_MODELS });
		}
		if (req.method === "POST" && url.pathname === "/api/chat") {
			const raw = await readBody(req);
			let parsed = {};
			try {
				parsed = JSON.parse(raw || "{}");
			} catch {
				return sendJson(res, 400, { error: "invalid JSON body" });
			}
			return sendJson(res, 200, {
				model: String(parsed.model || "llama3.2:latest"),
				created_at: "2026-01-15T00:00:00Z",
				message: { role: "assistant", content: FIXTURE_COMPLETION_TEXT },
				done: true,
			});
		}
		return sendJson(res, 404, { error: `no fixture route for ${req.method} ${url.pathname}` });
	});
}

function createLmStudioServer() {
	return http.createServer(async (req, res) => {
		const url = new URL(req.url, "http://fixture");
		if (req.method === "GET" && url.pathname === "/v1/models") {
			return sendJson(res, 200, { object: "list", data: LMSTUDIO_FIXTURE_MODELS });
		}
		if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
			return handleOpenAiChat(req, res);
		}
		return sendJson(res, 404, { error: { message: `no fixture route for ${req.method} ${url.pathname}` } });
	});
}

function createWhisperServer() {
	return http.createServer(async (req, res) => {
		const url = new URL(req.url, "http://fixture");
		if (req.method === "POST" && url.pathname === "/v1/audio/transcriptions") {
			// Accepts any multipart/form-data payload; deterministic transcript.
			await readBody(req);
			return sendJson(res, 200, { text: FIXTURE_TRANSCRIPT_TEXT });
		}
		return sendJson(res, 404, { error: { message: `no fixture route for ${req.method} ${url.pathname}` } });
	});
}

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve(`http://127.0.0.1:${port}`);
		});
	});
}

const FIXTURE_TEXTS = {
	completion: FIXTURE_COMPLETION_TEXT,
	transcript: FIXTURE_TRANSCRIPT_TEXT,
};

async function startProviderFixtures() {
	const servers = {
		openrouter: createOpenRouterServer(),
		ollama: createOllamaServer(),
		lmstudio: createLmStudioServer(),
		whisper: createWhisperServer(),
	};

	const entries = await Promise.all(
		Object.entries(servers).map(async ([name, server]) => [name, { url: await listen(server), server }]),
	);

	const byName = Object.fromEntries(entries);

	return {
		openrouter: { url: byName.openrouter.url },
		ollama: { url: byName.ollama.url },
		lmstudio: { url: byName.lmstudio.url },
		whisper: { url: byName.whisper.url },
		async close() {
			await Promise.all(
				Object.values(byName).map(
					({ server }) =>
						new Promise((resolve) => {
							server.close(() => resolve());
						}),
				),
			);
		},
	};
}

module.exports = {
	OPENROUTER_FIXTURE_MODELS,
	OLLAMA_FIXTURE_MODELS,
	LMSTUDIO_FIXTURE_MODELS,
	FIXTURE_TEXTS,
	startProviderFixtures,
};
