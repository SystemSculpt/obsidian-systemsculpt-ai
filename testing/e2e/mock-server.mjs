import express from "express";
import cors from "cors";

const API_PREFIX = "/api/v1";
const DEFAULT_PORT = 43111;
const DEBUG = process.env.SYSTEMSCULPT_E2E_MOCK_DEBUG === "1";

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

const app = express();
app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get(`${API_PREFIX}/license/validate`, (req, res) => {
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

app.get(`${API_PREFIX}/models`, (req, res) => {
  const licenseKey = requireLicense(req, res);
  if (!licenseKey) return;

  res.status(200).json([
    {
      id: "systemsculpt/ai-agent",
      name: "SystemSculpt AI Agent (Mock)",
      upstream_model: "openrouter/x-ai/grok-4.1-fast",
    },
  ]);
});

app.post(`${API_PREFIX}/chat/completions`, (req, res) => {
  const licenseKey = requireLicense(req, res);
  if (!licenseKey) return;

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const token = extractExactlyToken(messages);

  const accept = getHeader(req, "accept") || getHeader(req, "Accept");
  const wantsStream = body.stream === true || accept.includes("text/event-stream");
  if (DEBUG) {
    try {
      const messagePreviews = (messages || []).map((m) => {
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
      console.log("[e2e-mock] /chat/completions", {
        stream: body.stream,
        wantsStream,
        accept,
        model: body.model,
        messageCount: messages.length,
        tokenPreview: String(token).slice(0, 120),
        messagePreviews,
      });
    } catch {}
  }
  if (!wantsStream) {
    res.status(200).json({
      id: `mock-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model || "mock-model",
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

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  try {
    res.flushHeaders?.();
  } catch {}

  const first = { choices: [{ delta: { content: token } }] };
  res.write(`data: ${JSON.stringify(first)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

const server = app.listen(getPort(), "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : getPort();
  process.stdout.write(`[e2e-mock] listening on http://127.0.0.1:${port}${API_PREFIX}\n`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2_000).unref();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
