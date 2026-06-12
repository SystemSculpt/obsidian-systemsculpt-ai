/**
 * Self-test for the deterministic provider fixture servers (issue #215).
 *
 * Every shape asserted here is a contract the release smoke suite (and any
 * future provider regression test) builds on. If a provider integration needs
 * a response field the fixtures lack, extend the fixture and lock it in here.
 */
const {
  startProviderFixtures,
  FIXTURE_TEXTS,
  OPENROUTER_FIXTURE_MODELS,
  OLLAMA_FIXTURE_MODELS,
  LMSTUDIO_FIXTURE_MODELS,
} = require("../fixtures/providers/index.cjs");

type Fixtures = Awaited<ReturnType<typeof startProviderFixtures>>;

describe("provider fixture servers", () => {
  let fixtures: Fixtures;

  beforeAll(async () => {
    fixtures = await startProviderFixtures();
  });

  afterAll(async () => {
    await fixtures.close();
  });

  it("openrouter fixture lists models", async () => {
    const response = await fetch(`${fixtures.openrouter.url}/api/v1/models`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual(OPENROUTER_FIXTURE_MODELS);
  });

  it("openrouter fixture answers a chat completion", async () => {
    const response = await fetch(`${fixtures.openrouter.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENROUTER_FIXTURE_MODELS[0].id,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.model).toBe(OPENROUTER_FIXTURE_MODELS[0].id);
    expect(body.choices[0].message.content).toBe(FIXTURE_TEXTS.completion);
    expect(body.choices[0].finish_reason).toBe("stop");
  });

  it("openrouter fixture streams SSE chunks when stream:true", async () => {
    const response = await fetch(`${fixtures.openrouter.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENROUTER_FIXTURE_MODELS[0].id,
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const raw = await response.text();
    const dataLines = raw
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length));
    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");
    const firstChunk = JSON.parse(dataLines[0]);
    expect(firstChunk.choices[0].delta.content).toBe(FIXTURE_TEXTS.completion);
  });

  it("ollama fixture lists tags and answers chat", async () => {
    const tags = await (await fetch(`${fixtures.ollama.url}/api/tags`)).json();
    expect(tags.models).toEqual(OLLAMA_FIXTURE_MODELS);

    const chatResponse = await fetch(`${fixtures.ollama.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_FIXTURE_MODELS[0].name,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const chat = await chatResponse.json();
    expect(chat.model).toBe(OLLAMA_FIXTURE_MODELS[0].name);
    expect(chat.message.content).toBe(FIXTURE_TEXTS.completion);
    expect(chat.done).toBe(true);
  });

  it("lmstudio fixture serves the OpenAI shape", async () => {
    const models = await (await fetch(`${fixtures.lmstudio.url}/v1/models`)).json();
    expect(models.object).toBe("list");
    expect(models.data).toEqual(LMSTUDIO_FIXTURE_MODELS);

    const completionResponse = await fetch(`${fixtures.lmstudio.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LMSTUDIO_FIXTURE_MODELS[0].id,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const completion = await completionResponse.json();
    expect(completion.choices[0].message.content).toBe(FIXTURE_TEXTS.completion);
  });

  it("whisper fixture returns the deterministic transcript", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([1, 2, 3])]), "audio.wav");
    form.append("model", "whisper-1");
    const response = await fetch(`${fixtures.whisper.url}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: FIXTURE_TEXTS.transcript });
  });

  it("unknown routes 404 with a route hint", async () => {
    const response = await fetch(`${fixtures.openrouter.url}/api/v1/nope`);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.message).toContain("GET /api/v1/nope");
  });
});
