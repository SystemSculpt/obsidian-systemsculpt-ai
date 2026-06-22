/**
 * normalizeTranscriptionResponse - one pure parser for the many shapes a Whisper-
 * compatible endpoint can return, the transcription twin of the embeddings
 * `normalizeEmbeddingsResponse`.
 *
 * Today `TranscriptionService.transcribeAudio` reparses these inline at every
 * call site (a Groq `segments` branch, a `string` body, `.text`, `.data.text`,
 * plus a separate NDJSON path), each throwing its own ad-hoc error. Centralizing
 * the shape handling here means there is exactly one definition of "a compatible
 * response", which is also what makes the self-hosted Whisper contract (#211)
 * mechanically checkable: a server is compatible iff this returns non-null.
 *
 * Recognized shapes (verbatim from the current code + the OpenAI/Groq specs):
 *  - a raw string body (some self-hosted servers return text/plain);
 *  - `{ text }` (OpenAI `response_format=json`);
 *  - `{ data: { text } }` (the managed SystemSculpt wrapper);
 *  - `{ segments: [{ start, end, text }] }` (Groq / verbose_json) — joined into
 *    `text` while preserving the timed segments for SRT output.
 * Returns null for anything unrecognized so callers can raise a typed
 * UNEXPECTED_RESPONSE instead of guessing.
 */

export interface TranscriptionSegment {
  text: string;
  /** Segment start, in seconds (when the endpoint reports timings). */
  start?: number;
  /** Segment end, in seconds. */
  end?: number;
}

export interface TranscriptionResult {
  text: string;
  /** Timed segments, when the endpoint returns verbose/timestamped output. */
  segments?: TranscriptionSegment[];
  /** Detected/declared language, when reported. */
  language?: string;
  /** The original payload, for diagnostics. */
  raw?: unknown;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function pickLanguage(obj: Record<string, unknown>): string | undefined {
  return isString(obj.language) ? obj.language : undefined;
}

function normalizeSegments(value: unknown): TranscriptionSegment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const segments: TranscriptionSegment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (!isString(record.text)) continue;
    const segment: TranscriptionSegment = { text: record.text };
    if (typeof record.start === "number" && Number.isFinite(record.start)) {
      segment.start = record.start;
    }
    if (typeof record.end === "number" && Number.isFinite(record.end)) {
      segment.end = record.end;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments : undefined;
}

function joinSegments(segments: TranscriptionSegment[]): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter((text) => text.length > 0)
    .join(" ")
    .trim();
}

/**
 * Normalize a raw transcription payload into `{ text, segments?, language? }`,
 * or null when no recognized transcript shape is present. An empty/whitespace-only
 * transcript is treated as "no usable result" (null) so the caller surfaces a
 * single consistent error rather than persisting a blank note.
 */
export function normalizeTranscriptionResponse(
  data: unknown,
): TranscriptionResult | null {
  // 1. Raw string body.
  if (isString(data)) {
    const text = data.trim();
    return text.length > 0 ? { text, raw: data } : null;
  }

  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  // 2. Top-level { text } (+ optional segments/language).
  if (isString(obj.text)) {
    const text = obj.text.trim();
    if (text.length === 0) return null;
    return {
      text,
      segments: normalizeSegments(obj.segments),
      language: pickLanguage(obj),
      raw: data,
    };
  }

  // 3. Nested { data: { text } } — the managed SystemSculpt wrapper.
  const nested = obj.data;
  if (nested && typeof nested === "object") {
    const nestedRecord = nested as Record<string, unknown>;
    if (isString(nestedRecord.text)) {
      const text = nestedRecord.text.trim();
      if (text.length === 0) return null;
      return {
        text,
        segments: normalizeSegments(nestedRecord.segments) ?? normalizeSegments(obj.segments),
        language: pickLanguage(nestedRecord) ?? pickLanguage(obj),
        raw: data,
      };
    }
  }

  // 4. Segments only (Groq verbose_json without a top-level text).
  const segments = normalizeSegments(obj.segments);
  if (segments) {
    const text = joinSegments(segments);
    if (text.length === 0) return null;
    return { text, segments, language: pickLanguage(obj), raw: data };
  }

  return null;
}
