import express from "express";
import cors from "cors";

const LEGACY_API_PREFIX = "/api/v1";
const AGENT_API_PREFIX = "/api/v2/agent";
const DEFAULT_PORT = 43111;
const DEBUG = process.env.SYSTEMSCULPT_E2E_MOCK_DEBUG === "1";
const TINY_PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9slt4d8AAAAASUVORK5CYII=",
  "base64"
);

function getPort() {
  const raw = process.env.SYSTEMSCULPT_E2E_MOCK_PORT || process.env.PORT || "";
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return DEFAULT_PORT;
}

function getHeader(req, name) {
  const value = req.get(name);
  return typeof value === "string" ? value : "";
}

function requireLicense(req, res) {
  const licenseKey = getHeader(req, "x-license-key") || getHeader(req, "X-License-Key");
  if (!licenseKey.trim()) {
    res.status(401).json({ error: { message: "Missing license key", code: "LICENSE_INVALID" } });
    return null;
  }
  return licenseKey.trim();
}

function extractExactlyToken(messages) {
  const combined = messages
    .map((m) => (m && typeof m === "object" ? m.content : ""))
    .filter(Boolean)
    .map((content) => {
      if (typeof content === "string") return content;
      try {
        return JSON.stringify(content);
      } catch {
        return "";
      }
    })
    .join("\n");

  const match = combined.match(/Reply with EXACTLY:\s*([^\n\r]+)/i);
  if (!match) return "OK_MOCK";
  const token = String(match[1] || "").trim();
  return token.length > 0 ? token : "OK_MOCK";
}

function wantsStreamResponse(req, body) {
  const accept = getHeader(req, "accept") || getHeader(req, "Accept");
  return body.stream === true || accept.includes("text/event-stream");
}

function getTurnMessages(body) {
  if (Array.isArray(body?.messages)) return body.messages;
  if (body?.context && typeof body.context === "object" && Array.isArray(body.context.messages)) {
    return body.context.messages;
  }
  return [];
}

function writeSSE(res, payload, eventName) {
  if (eventName) {
    res.write(`event: ${eventName}\n`);
  }
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendStreamCompletion(res, token) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  try {
    res.flushHeaders?.();
  } catch {}

  writeSSE(
    res,
    { choices: [{ delta: { content: token }, finish_reason: null }] },
    "message"
  );
  writeSSE(res, { __systemsculpt: { phase: "turn_completed" } }, "turn.completed");
  res.write("data: [DONE]\n\n");
  res.end();
}

const app = express();
app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const sessions = new Map();
const imageJobs = new Map();
const requestStats = {
  v2Sessions: 0,
  v2Turns: 0,
  v2ToolResults: 0,
  v2Continue: 0,
  legacyChatCompletions: 0,
  imageModels: 0,
  imageJobsCreated: 0,
  imageJobPolls: 0,
};

app.get(`${LEGACY_API_PREFIX}/license/validate`, (req, res) => {
  const licenseKey = requireLicense(req, res);
  if (!licenseKey) return;

  res.status(200).json({
    data: {
      email: "mock@systemsculpt.test",
      subscription_status: "active",
      license_key: licenseKey,
      user_name: "Mock User",
      display_name: "Mock User",
      has_agents_pack_access: true,
    },
  });
});

app.get(`${LEGACY_API_PREFIX}/models`, (req, res) => {
  const licenseKey = requireLicense(req, res);
  if (!licenseKey) return;

  res.status(200).json([
    {
      id: "systemsculpt/ai-agent",
      name: "SystemSculpt AI Agent (Mock)",
      upstream_model: "openrouter/google/gemini-3-flash-preview",
    },
  ]);
});

app.get(`${LEGACY_API_PREFIX}/images/models`, (req, res) => {
  const licenseKey = requireLicense(req, res);
  if (!licenseKey) return;
  requestStats.imageModels += 1;

  res.status(200).json({
    contract: "systemsculpt-image-v1",
    provider: "openrouter",
    models: [
      {
        id: "openai/gpt-5-image-mini",
        name: "OpenAI GPT-5 Image Mini",
        provider: "openrouter",
        input_modalities: ["text", "image"],
        output_modalities: ["image"],
        supports_image_input: true,
        max_images_per_job: 4,
        default_aspect_ratio: "1:1",
        allowed_aspect_ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"],
      },
    ],
  });
});

app.post(`${LEGACY_API_PREFIX}/images/generations/jobs`, (req, res) => {
  const licenseKey = requireLicense(req, res);
  if (!licenseKey) return;
  requestStats.imageJobsCreated += 1;

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "openai/gpt-5-image-mini";
  const countRaw = body.options && typeof body.options === "object" ? Number(body.options.count || 1) : 1;
  const count = Number.isFinite(countRaw) ? Math.max(1, Math.min(4, Math.floor(countRaw))) : 1;

  const jobId = `imgjob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();
  const readyAt = Date.now() + 1200;
  imageJobs.set(jobId, {
    id: jobId,
    model,
    prompt,
    count,
    createdAt,
    readyAt,
  });

  res.status(202).json({
    job: {
      id: jobId,
      status: "queued",
      model,
      created_at: createdAt,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      attempt_count: 0,
    },
    poll_url: `/api/v1/images/generations/jobs/${jobId}`,
  });
});

app.get(`${LEGACY_API_PREFIX}/images/generations/jobs/:jobId`, (req, res) => {
  const licenseKey = requireLicense(req, res);
  if (!licenseKey) return;
  requestStats.imageJobPolls += 1;

  const { jobId } = req.params || {};
  const job = jobId ? imageJobs.get(jobId) : null;
  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }

  const done = Date.now() >= job.readyAt;
  const status = done ? "succeeded" : "queued";
  const outputs = done
    ? Array.from({ length: job.count }).map((_, index) => ({
        index,
        mime_type: "image/png",
        size_bytes: TINY_PNG_BUFFER.byteLength,
        width: 1,
        height: 1,
        url: `http://127.0.0.1:${getPort()}/mock/images/${job.id}/${index}.png`,
        url_expires_in_seconds: 1800,
      }))
    : [];

  res.status(200).json({
    job: {
      id: job.id,
      status,
      model: job.model,
      created_at: job.createdAt,
      processing_started_at: job.createdAt,
      completed_at: done ? new Date().toISOString() : null,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      error_code: null,
      error_message: null,
      attempt_count: 1,
    },
    outputs,
    usage: {
      provider: "openrouter",
      raw_usd: 0.02,
      cost_source: "mock",
      estimated: true,
    },
  });
});

app.get("/mock/images/:jobId/:index.png", (_req, res) => {
  res.setHeader("Content-Type", "image/png");
  res.status(200).send(TINY_PNG_BUFFER);
});

app.post(`${AGENT_API_PREFIX}/sessions`, (req, res) => {
  const licenseKey = requireLicense(req, res);
  if (!licenseKey) return;
  requestStats.v2Sessions += 1;

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const modelId = typeof body.modelId === "string" ? body.modelId : "systemsculpt/ai-agent";
  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();

  sessions.set(sessionId, {
    modelId,
    token: "OK_MOCK",
    updatedAt: now,
  });

  if (DEBUG) {
    console.log("[e2e-mock] /api/v2/agent/sessions", { sessionId, modelId });
  }

  res.status(200).json({
    sessionId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 6 * 60 * 60 * 1000).toISOString(),
  });
});

app.post(`${AGENT_API_PREFIX}/sessions/:sessionId/turns`, (req, res) => {
  const licenseKey = requireLicense(req, res);
  if (!licenseKey) return;
  requestStats.v2Turns += 1;

  const { sessionId } = req.params || {};
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const messages = getTurnMessages(body);
  const token = extractExactlyToken(messages);
  const stream = wantsStreamResponse(req, body);
  const session = sessions.get(sessionId);

  session.token = token;
  session.updatedAt = Date.now();
  sessions.set(sessionId, session);

  if (DEBUG) {
    try {
      const messagePreviews = messages.map((m) => {
        const role = m && typeof m === "object" ? m.role : undefined;
        const content = m && typeof m === "object" ? m.content : undefined;
        let preview = "";
        if (typeof content === "string") preview = content;
        else {
          try {
            preview = JSON.stringify(content);
          } catch {}
        }
        return {
          role,
          preview: preview.slice(0, 240),
        };
      });
      console.log("[e2e-mock] /api/v2/agent/sessions/:sessionId/turns", {
        sessionId,
        stream: body.stream,
        wantsStream: stream,
        model: body.modelId || session.modelId,
        messageCount: messages.length,
        tokenPreview: String(token).slice(0, 120),
        messagePreviews,
      });
    } catch {}
  }

  if (!stream) {
    res.status(200).json({
      id: `mock-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.modelId || session.modelId || "mock-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: token },
          finish_reason: "stop",
        },
      ],
    });
    return;
  }

  sendStreamCompletion(res, token);
});

app.post(`${AGENT_API_PREFIX}/sessions/:sessionId/tool-results`, (req, res) => {
  const licenseKey = requireLicense(req, res);
  if (!licenseKey) return;
  requestStats.v2ToolResults += 1;

  const { sessionId } = req.params || {};
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const results = Array.isArray(body.results) ? body.results : [];
  if (results.length === 0) {
    res.status(400).json({ error: "results array is required" });
    return;
  }

  if (DEBUG) {
    console.log("[e2e-mock] /api/v2/agent/sessions/:sessionId/tool-results", {
      sessionId,
      resultCount: results.length,
    });
  }

  res.status(200).json({ accepted: true });
});

app.post(`${AGENT_API_PREFIX}/sessions/:sessionId/continue`, (req, res) => {
  const licenseKey = requireLicense(req, res);
  if (!licenseKey) return;
  requestStats.v2Continue += 1;

  const { sessionId } = req.params || {};
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const stream = wantsStreamResponse(req, body);
  const token = typeof session.token === "string" && session.token.length > 0 ? session.token : "OK_MOCK";

  if (DEBUG) {
    console.log("[e2e-mock] /api/v2/agent/sessions/:sessionId/continue", {
      sessionId,
      wantsStream: stream,
      tokenPreview: token.slice(0, 120),
    });
  }

  if (!stream) {
    res.status(200).json({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: token },
          finish_reason: "stop",
        },
      ],
    });
    return;
  }

  sendStreamCompletion(res, token);
});

app.post(`${LEGACY_API_PREFIX}/chat/completions`, (_req, res) => {
  requestStats.legacyChatCompletions += 1;
  res.status(410).json({
    error: {
      code: "deprecated_endpoint",
      message: "Mock endpoint retired. Use /api/v2/agent/* in E2E tests.",
    },
  });
});

app.get("/_e2e/stats", (_req, res) => {
  res.status(200).json({
    ...requestStats,
    activeSessions: sessions.size,
  });
});

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

const server = app.listen(getPort(), "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : getPort();
  process.stdout.write(
    `[e2e-mock] listening on http://127.0.0.1:${port}${LEGACY_API_PREFIX} and ${AGENT_API_PREFIX}\n`
  );
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2_000).unref();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
