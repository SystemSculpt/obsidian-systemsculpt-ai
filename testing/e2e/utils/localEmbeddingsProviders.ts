import { fetchJson } from "./http";

export type OllamaEmbeddingsConfig = { endpoint: string; model: string; dimension: number };
export type OllamaModel = { name: string; dimension: number };
export type OllamaTwoModelConfig = { endpoint: string; modelA: OllamaModel; modelB: OllamaModel };

function extractEmbeddingVector(json: any): number[] | null {
  if (Array.isArray(json?.embedding)) return json.embedding;
  if (Array.isArray(json?.data) && Array.isArray(json.data[0]?.embedding)) return json.data[0].embedding;
  return null;
}

export async function detectOllamaEmbeddings(params?: {
  baseUrl?: string;
  requiredModelPrefix?: string;
}): Promise<OllamaEmbeddingsConfig> {
  const base = params?.baseUrl ?? "http://localhost:11434";
  const requiredPrefix = params?.requiredModelPrefix ?? "nomic-embed-text";
  const tagsUrl = `${base}/api/tags`;
  const embeddingsUrl = `${base}/api/embeddings`;

  let tagsResp: { ok: boolean; status: number; json: any; text: string };
  try {
    tagsResp = await fetchJson(tagsUrl, { method: "GET", timeoutMs: 6000 });
  } catch (e: any) {
    throw new Error(`Ollama was not reachable at ${base}. Start it with \`ollama serve\`. (${e?.message ?? String(e)})`);
  }
  if (!tagsResp.ok) {
    throw new Error(`Ollama tags endpoint failed (${tagsResp.status}) at ${tagsUrl}.`);
  }

  const modelNames: string[] = Array.isArray(tagsResp.json?.models)
    ? tagsResp.json.models.map((m: any) => m?.name).filter((name: any) => typeof name === "string")
    : [];

  const model = modelNames.find((n) => String(n).startsWith(requiredPrefix));
  if (!model) {
    throw new Error(
      `Ollama is running but the embeddings model "${requiredPrefix}" is not installed. Run \`ollama pull ${requiredPrefix}\`.`
    );
  }

  const test = await fetchJson(embeddingsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: "hello" }),
    timeoutMs: 20000,
  });
  if (!test.ok) {
    throw new Error(`Ollama embeddings request failed (${test.status}) at ${embeddingsUrl}.`);
  }

  const vec = extractEmbeddingVector(test.json);
  const dim = Array.isArray(vec) ? vec.length : 0;
  if (!Number.isFinite(dim) || dim <= 0) {
    throw new Error(`Ollama returned an invalid embeddings response for ${model}.`);
  }

  return { endpoint: embeddingsUrl, model, dimension: dim };
}

async function detectOllamaEmbeddingDimension(model: string, embeddingsUrl: string): Promise<number> {
  const test = await fetchJson(embeddingsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: "hello" }),
    timeoutMs: 20000,
  });
  if (!test.ok) {
    throw new Error(`Ollama embeddings request failed (${test.status}) at ${embeddingsUrl} for model ${model}.`);
  }

  const vec = extractEmbeddingVector(test.json);
  const dim = Array.isArray(vec) ? vec.length : 0;
  if (!Number.isFinite(dim) || dim <= 0) {
    throw new Error(`Ollama returned an invalid embeddings response for model ${model}.`);
  }
  return dim;
}

export async function detectOllamaTwoEmbeddingModels(params?: {
  baseUrl?: string;
  modelAPrefix?: string;
  modelBPrefix?: string;
}): Promise<OllamaTwoModelConfig> {
  const base = params?.baseUrl ?? "http://localhost:11434";
  const modelAPrefix = params?.modelAPrefix ?? "nomic-embed-text";
  const modelBPrefix = params?.modelBPrefix ?? "mxbai-embed-large";
  const tagsUrl = `${base}/api/tags`;
  const embeddingsUrl = `${base}/api/embeddings`;

  let tagsResp: { ok: boolean; status: number; json: any; text: string };
  try {
    tagsResp = await fetchJson(tagsUrl, { method: "GET", timeoutMs: 6000 });
  } catch (e: any) {
    throw new Error(`Ollama was not reachable at ${base}. Start it with \`ollama serve\`. (${e?.message ?? String(e)})`);
  }
  if (!tagsResp.ok) {
    throw new Error(`Ollama tags endpoint failed (${tagsResp.status}) at ${tagsUrl}.`);
  }

  const modelNames: string[] = Array.isArray(tagsResp.json?.models)
    ? tagsResp.json.models.map((m: any) => m?.name).filter((name: any) => typeof name === "string")
    : [];

  const modelAName = modelNames.find((n) => String(n).startsWith(modelAPrefix));
  if (!modelAName) {
    throw new Error(
      `Ollama is running but the embeddings model "${modelAPrefix}" is not installed. Run \`ollama pull ${modelAPrefix}\`.`
    );
  }

  const modelBName = modelNames.find((n) => String(n).startsWith(modelBPrefix));
  if (!modelBName) {
    throw new Error(
      `Ollama is running but the embeddings model "${modelBPrefix}" is not installed. Run \`ollama pull ${modelBPrefix}\`.`
    );
  }

  const [dimA, dimB] = await Promise.all([
    detectOllamaEmbeddingDimension(modelAName, embeddingsUrl),
    detectOllamaEmbeddingDimension(modelBName, embeddingsUrl),
  ]);

  if (dimA === dimB) {
    throw new Error(`Expected Ollama embedding models to have different dimensions, but both returned ${dimA}.`);
  }

  return { endpoint: embeddingsUrl, modelA: { name: modelAName, dimension: dimA }, modelB: { name: modelBName, dimension: dimB } };
}

export type LmStudioEmbeddingsConfig = { endpoint: string; model: string; dimension?: number };

function isLikelyEmbeddingModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return (
    id.includes("embed") ||
    id.includes("nomic") ||
    id.includes("bge") ||
    id.includes("e5") ||
    id.includes("gte") ||
    id.includes("minilm") ||
    id.includes("mpnet") ||
    id.includes("text-embedding")
  );
}

export async function detectLmStudioEmbeddings(params?: { baseUrl?: string }): Promise<LmStudioEmbeddingsConfig> {
  const base = params?.baseUrl ?? "http://localhost:1234";
  const modelsUrl = `${base}/v1/models`;
  const embeddingsUrl = `${base}/v1/embeddings`;

  let modelsResp: { ok: boolean; status: number; json: any; text: string };
  try {
    modelsResp = await fetchJson(modelsUrl, { method: "GET", timeoutMs: 6000 });
  } catch (e: any) {
    throw new Error(
      `LM Studio was not reachable at ${base}. Start LM Studio's local server (default port 1234). (${e?.message ?? String(e)})`
    );
  }
  if (!modelsResp.ok) {
    throw new Error(`LM Studio models endpoint failed (${modelsResp.status}) at ${modelsUrl}.`);
  }

  const modelIds: string[] = Array.isArray(modelsResp.json?.data)
    ? modelsResp.json.data.map((m: any) => m?.id).filter((id: any) => typeof id === "string")
    : [];
  const candidates = modelIds.filter(isLikelyEmbeddingModel).slice(0, 8);
  if (candidates.length === 0) {
    throw new Error(
      `LM Studio is running but no likely embedding models were detected from ${modelsUrl}. Load an embedding model (id contains "embed", "nomic", "bge", "e5", etc).`
    );
  }

  for (const model of candidates) {
    try {
      const test = await fetchJson(embeddingsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: "hello", encoding_format: "float" }),
        timeoutMs: 12000,
      });
      if (!test.ok) continue;
      const vec = Array.isArray(test.json?.data) ? test.json.data[0]?.embedding : undefined;
      const dim = Array.isArray(vec) ? vec.length : undefined;
      return { endpoint: embeddingsUrl, model, dimension: typeof dim === "number" ? dim : undefined };
    } catch (_) {}
  }

  throw new Error(
    `LM Studio is running but none of the candidate models successfully handled a POST to ${embeddingsUrl}. Ensure an embeddings-capable model is loaded.`
  );
}
