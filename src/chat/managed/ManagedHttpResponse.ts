export async function readBoundedText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("SystemSculpt returned an oversized chat snapshot.");
  }
  if (!response.body) {
    throw new Error("SystemSculpt returned an empty chat snapshot.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel();
        throw new Error("SystemSculpt returned an oversized chat snapshot.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function responseErrorPayload(response: Response): Promise<Readonly<{
  code?: string;
  incidentId?: string;
}>> {
  try {
    const text = await readBoundedText(response, 4_096);
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    const nested = record.error && typeof record.error === "object"
      && !Array.isArray(record.error)
      ? record.error as Record<string, unknown>
      : {};
    const code = nested.code ?? record.code;
    const incidentId = nested.incident_id ?? record.incident_id;
    return {
      ...(typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(code)
        ? { code }
        : {}),
      ...(typeof incidentId === "string" && /^incident_[a-f0-9]{32}$/u.test(incidentId)
        ? { incidentId }
        : {}),
    };
  } catch {
    return {};
  }
}

