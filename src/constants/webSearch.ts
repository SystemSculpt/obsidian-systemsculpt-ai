/**
 * Web Search Configuration Constants
 */

export const WEB_SEARCH_CONFIG = {
  /** Maximum number of web search results to return */
  MAX_RESULTS: 5,
  
  /** Plugin ID for OpenRouter web search */
  PLUGIN_ID: "web",
  
  /** Default search context size for native web search models */
  DEFAULT_CONTEXT_SIZE: "medium" as const,
} as const;

/**
 * Mobile Streaming Configuration
 */
export const MOBILE_STREAM_CONFIG = {
  /** Size of content chunks for mobile streaming (characters) */
  CHUNK_SIZE: 50,
  
  /** Delay between chunks to simulate streaming (milliseconds) */
  CHUNK_DELAY_MS: 10,
} as const;

export type WebSearchContextSize = "low" | "medium" | "high";