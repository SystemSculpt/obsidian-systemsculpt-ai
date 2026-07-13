/**
 * Maximum JavaScript string length accepted for one managed embedding input.
 * This mirrors the first-party website contract's `max_chars_per_text` value;
 * it is deliberately local and does not pretend to be a negotiated capability.
 */
export const MANAGED_EMBEDDING_MAX_CHARS_PER_TEXT = 8_000;
