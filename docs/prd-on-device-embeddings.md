# On-device embeddings PRD (archival draft)

Status as of **2026-02-11**: **not implemented in this repo**.

This document is retained as a historical product draft for a possible future provider.

## Current shipped embeddings providers

From current code (`src/settings/EmbeddingsTabContent.ts`):

- `systemsculpt`
- `custom`

No `local-transformers` (or equivalent on-device provider) is currently registered in `src/`.

## Why this file remains

It captures prior planning assumptions and can be used as a future design input, but it is not a statement of current runtime behavior.
