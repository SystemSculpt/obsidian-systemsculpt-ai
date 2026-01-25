// Use single source of truth from api.ts to avoid duplication
import { DEVELOPMENT_MODE, getServerUrl } from "./api";

/**
 * External Service URLs Configuration
 * Centralizes all external service URLs and provides development mode alternatives
 */

// Helper function to get environment-aware external URLs
function getExternalUrl(productionUrl: string, developmentUrl?: string): string {
  return DEVELOPMENT_MODE === "DEVELOPMENT" && developmentUrl ? developmentUrl : productionUrl;
}

// GitHub API Configuration
export const GITHUB_API = {
  BASE_URL: getExternalUrl(
    "https://api.github.com",
    "https://api.github.com" // GitHub API doesn't have a dev alternative
  ),
  RELEASES: (owner: string, repo: string) => 
    `${GITHUB_API.BASE_URL}/repos/${owner}/${repo}/releases`,
  RELEASE_URL: (owner: string, repo: string) => 
    `https://github.com/${owner}/${repo}/releases`
} as const;

// AI Provider URLs
export const AI_PROVIDERS = {
  OPENAI: {
    BASE_URL: getExternalUrl("https://api.openai.com/v1"),
    AUDIO_TRANSCRIPTIONS: getExternalUrl("https://api.openai.com/v1/audio/transcriptions")
  },
  ANTHROPIC: {
    BASE_URL: getExternalUrl("https://api.anthropic.com/v1"),
    LEGACY_BASE: getExternalUrl("https://api.anthropic.com") // For older integrations
  },
  OPENROUTER: {
    BASE_URL: getExternalUrl("https://openrouter.ai/api/v1"),
    CHAT_COMPLETIONS: getExternalUrl("https://openrouter.ai/api/v1/chat/completions"),
    MODELS: getExternalUrl("https://openrouter.ai/api/v1/models")
  },
  MINIMAX: {
    BASE_URL: getExternalUrl("https://api.minimax.io/v1")
  },
  MOONSHOT: {
    BASE_URL: getExternalUrl("https://api.moonshot.ai/v1")
  },
  GROQ: {
    BASE_URL: getExternalUrl("https://api.groq.com/openai/v1"),
    AUDIO_TRANSCRIPTIONS: getExternalUrl("https://api.groq.com/openai/v1/audio/transcriptions")
  }
} as const;

// Local Development Services
export const LOCAL_SERVICES = {
  OLLAMA: {
    BASE_URL: "http://localhost:11434/v1"
  },
  LM_STUDIO: {
    BASE_URL: "http://localhost:1234/v1"
  },
  LOCAL_AI: {
    CHAT_COMPLETIONS: "http://localhost:8000/v1/chat/completions",
    MODELS: "http://localhost:8000/v1/models"
  },
  LOCAL_WHISPER: {
    AUDIO_TRANSCRIPTIONS: "http://localhost:9000/v1/audio/transcriptions"
  }
} as const;

// SystemSculpt Website URLs
export const SYSTEMSCULPT_WEBSITE = {
  BASE_URL: getExternalUrl("https://systemsculpt.com", "http://localhost:3000"), // Website development server
  LIFETIME: getExternalUrl("https://systemsculpt.com/lifetime", "http://localhost:3000/lifetime"),
  MONTHLY: getExternalUrl("https://systemsculpt.com/resources/a05a7abf-b8bb-41cf-9190-8b795d117fda", "http://localhost:3000/resources/a05a7abf-b8bb-41cf-9190-8b795d117fda"),
  DOCS: getExternalUrl("https://systemsculpt.com/docs", "http://localhost:3000/docs"),
  SUPPORT: getExternalUrl("https://systemsculpt.com/contact", "http://localhost:3000/contact"),
  LICENSE: getExternalUrl("https://systemsculpt.com/resources?tab=license", "http://localhost:3000/resources?tab=license"),
  FEEDBACK: getExternalUrl(
    "https://github.com/SystemSculpt/obsidian-systemsculpt-ai/issues/new?title=SystemSculpt%20Feedback%3A%20&body=Please%20describe%20your%20feedback%3A%0A%0A-%20What%20happened%20or%20what%20would%20you%20like%20to%20see%20improved%3F%0A-%20Steps%20to%20reproduce%20%28if%20a%20bug%29%3A%0A-%20Expected%20behavior%3A%0A-%20Screenshots%20or%20logs%3A%0A%0AEnvironment%3A%0A-%20Obsidian%20version%3A%0A-%20OS%3A%0A-%20SystemSculpt%20AI%20version%3A%0A%0AAdditional%20context%3A",
    "https://github.com/SystemSculpt/obsidian-systemsculpt-ai/issues/new?title=SystemSculpt%20Feedback%3A%20&body=Please%20describe%20your%20feedback%3A%0A%0A-%20What%20happened%20or%20what%20would%20you%20like%20to%20see%20improved%3F%0A-%20Steps%20to%20reproduce%20%28if%20a%20bug%29%3A%0A-%20Expected%20behavior%3A%0A-%20Screenshots%20or%20logs%3A%0A%0AEnvironment%3A%0A-%20Obsidian%20version%3A%0A-%20OS%3A%0A-%20SystemSculpt%20AI%20version%3A%0A%0AAdditional%20context%3A"
  )
} as const;

// MCP Documentation
export const MCP_DOCS = {
  BASE_URL: "https://modelcontextprotocol.io" // No dev alternative
} as const;

// Headers configuration
export const SERVICE_HEADERS = {
  OPENROUTER: {
    "HTTP-Referer": SYSTEMSCULPT_WEBSITE.BASE_URL,
    "X-Title": "SystemSculpt AI"
  }
} as const;
