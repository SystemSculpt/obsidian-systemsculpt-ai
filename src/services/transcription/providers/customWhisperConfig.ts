/**
 * customWhisperConfig - the documented, mechanically-checkable contract for a
 * self-hosted / third-party Whisper-compatible transcription endpoint (#211).
 *
 * The contact-form report behind #211: "no documented endpoint contract, users
 * can't tell what's compatible." This module is that contract, in two halves:
 *  - the REQUEST side, described in CUSTOM_WHISPER_CONTRACT and enforced as a
 *    config-time check by validateCustomWhisperConfig (no I/O — safe to run on
 *    every settings keystroke);
 *  - the RESPONSE side, defined by normalizeTranscriptionResponse (a server is
 *    response-compatible iff that returns non-null).
 *
 * Pure / Node-free (uses the WHATWG URL global, available on web + mobile).
 */

import { buildValidation, type TranscriptionConfigValidation } from "./TranscriptionProvider";

export interface CustomWhisperConfig {
  endpoint: string;
  apiKey?: string;
  model?: string;
}

/**
 * Human-readable description of what SystemSculpt sends and what it accepts back.
 * Shown in settings and the source-of-truth for "compatible".
 */
export const CUSTOM_WHISPER_CONTRACT =
  "SystemSculpt sends a POST multipart/form-data request with a `file` part (the " +
  "recorded audio) and a `model` field, plus an optional `Authorization: Bearer " +
  "<key>` header. A compatible endpoint replies with JSON `{ text }`, a verbose " +
  "`{ segments: [{ start, end, text }] }` (when timestamps are requested), a " +
  "`{ data: { text } }` wrapper, or a plain-text body. OpenAI, Groq, and " +
  "faster-whisper-server compatible endpoints all satisfy this.";

function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local")
  );
}

/**
 * Validate a custom-endpoint configuration without performing any network I/O.
 * Errors block (the endpoint cannot work as configured); warnings are advisory
 * (it may work, but something looks off). `ok` is true iff there are no errors.
 */
export function validateCustomWhisperConfig(
  config: CustomWhisperConfig,
): TranscriptionConfigValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const endpoint = (config.endpoint ?? "").trim();
  if (!endpoint) {
    errors.push("Endpoint URL is required for a custom transcription provider.");
    return buildValidation(errors, warnings);
  }

  let url: URL | null = null;
  try {
    url = new URL(endpoint);
  } catch {
    url = null;
  }
  if (!url) {
    errors.push(
      "Endpoint must be a full URL, e.g. https://api.groq.com/openai/v1/audio/transcriptions.",
    );
    return buildValidation(errors, warnings);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    errors.push("Endpoint must use http:// or https://.");
    return buildValidation(errors, warnings);
  }

  const local = isLocalHost(url.hostname);
  if (url.protocol === "http:" && !local) {
    warnings.push(
      "Endpoint uses http:// — your API key and audio will be sent unencrypted. Use https:// for remote servers.",
    );
  }
  if (!/transcription/i.test(url.pathname)) {
    warnings.push(
      'Endpoint path has no "transcriptions" segment — confirm it points at the audio transcription route, not the API root.',
    );
  }
  if (!(config.model ?? "").trim()) {
    warnings.push("No model set — the server's default model will be used.");
  }
  if (!(config.apiKey ?? "").trim() && !local) {
    warnings.push("No API key set — most hosted endpoints require one.");
  }

  return buildValidation(errors, warnings);
}
