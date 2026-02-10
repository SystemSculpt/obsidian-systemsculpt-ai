/**
 * Mobile Streaming Configuration
 */
export const MOBILE_STREAM_CONFIG = {
  /** Size of content chunks for mobile streaming (characters) */
  CHUNK_SIZE: 50,
  
  /** Delay between chunks to simulate streaming (milliseconds) */
  CHUNK_DELAY_MS: 10,
} as const;
