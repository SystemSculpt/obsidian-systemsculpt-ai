export function isMiniMaxEndpoint(endpoint: string): boolean {
  if (!endpoint) {
    return false;
  }

  const lower = endpoint.toLowerCase();
  if (lower.includes("minimax")) {
    return true;
  }

  try {
    const url = new URL(endpoint);
    return url.hostname.toLowerCase().includes("minimax");
  } catch {
    return false;
  }
}

export const MINIMAX_BASE_URL = "https://api.minimax.io/v1";

export const MINIMAX_FALLBACK_MODEL_IDS = [
  "MiniMax-M2",
  "MiniMax-M2.1",
  "MiniMax-M1",
  "MiniMax-Text-01",
] as const;
