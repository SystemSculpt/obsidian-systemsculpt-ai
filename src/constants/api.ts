// API configuration and environment toggles
// Set DEVELOPMENT_MODE to "PRODUCTION" for release builds.

export const DEVELOPMENT_MODE: "DEVELOPMENT" | "PRODUCTION" = "PRODUCTION";

export function getServerUrl(productionUrl: string, developmentUrl: string): string {
  return DEVELOPMENT_MODE === "DEVELOPMENT" ? developmentUrl : productionUrl;
}

export const API_BASE_URL = getServerUrl(
  "https://api.systemsculpt.com/api/v1",
  "http://localhost:3001/api/v1",
);

export const WEBSITE_API_BASE_URL = getServerUrl(
  "https://systemsculpt.com/api/plugin",
  "http://localhost:3000/api/plugin",
);

export const SYSTEMSCULPT_API_ENDPOINTS = {
  PLUGINS: {
    LATEST: (pluginId: string) => `/plugins/${pluginId}/latest`,
    RELEASES: (pluginId: string) => `/plugins/${pluginId}/releases`,
  },
  LICENSE: {
    VALIDATE: () => `/license/validate`,
  },
  MODELS: {
    LIST: "/models",
    GET: (modelId: string) => `/models/${modelId}`,
  },
  AGENT: {
    BASE: "/api/v1/agent",
    SESSIONS: "/api/v1/agent/sessions",
    SESSION_TURNS: (sessionId: string) => `/api/v1/agent/sessions/${sessionId}/turns`,
  },
  CREDITS: {
    BALANCE: "/credits/balance",
  },
  EMBEDDINGS: {
    GENERATE: "/embeddings",
  },
  SYSTEM_PROMPTS: {
    GET: (id: string) => `/system-prompts/${id}`,
    LIST: "/system-prompts",
  },
  DOCUMENTS: {
    PROCESS: "/documents/process",
    GET: (id: string) => `/documents/${id}`,
    DOWNLOAD: (id: string) => `/documents/${id}/download`,
  },
  YOUTUBE: {
    TRANSCRIPTS: "/youtube/transcripts",
    TRANSCRIPT_STATUS: (jobId: string) => `/youtube/transcripts/${jobId}`,
  },
} as const;

export interface ApiErrorDetails {
  message: string;
  code: string;
  statusCode: number;
}

export interface ApiResponse<T> {
  status: "success" | "error";
  data: T | null;
  error?: ApiErrorDetails;
}

export interface LicenseValidationResponse {
  email: string;
  subscription_status: string;
  license_key: string;
  user_name?: string;
  display_name?: string;
  has_agents_pack_access?: boolean;
}

export const SYSTEMSCULPT_API_HEADERS = {
  DEFAULT: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-SystemSculpt-Client": "obsidian-plugin",
  },
  WITH_LICENSE: (licenseKey: string) => ({
    ...SYSTEMSCULPT_API_HEADERS.DEFAULT,
    "x-license-key": licenseKey,
  }),
} as const;
