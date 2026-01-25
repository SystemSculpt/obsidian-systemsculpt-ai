# Nano Banana Integration Plan

_Last updated: 2025-10-03_

## Goals
- Expose Google’s Nano Banana (Gemini 2.5 Flash Image Preview) capabilities via the OpenRouter aggregation layer inside the System Sculpt Admin YouTube workflow.
- Generate polished 16:9 thumbnail imagery aligned with the transcript/title derived prompts.
- Persist outputs alongside existing artifacts and surface them in the UI with review tooling.
- Implementation happens inside the standalone `systemsculpt-admin` repository (paths below are relative to that repo).

## Key Requirements
- Reuse the existing `OPENROUTER_API_KEY`; add optional overrides for model name (`OPENROUTER_NANO_BANANA_MODEL` falling back to `NANO_BANANA_MODEL`) and feature flag (`ENABLE_NANO_BANANA`).
- Respect OpenRouter plan limits (RPM/TPM vary by tier) with helpful messaging on 429 responses.
- Store generated PNG + JSON metadata next to the source video file: `<video>.nano-banana.png` and `<video>.nano-banana.json`.
- Log request IDs, latency, and safety blocks for operational visibility.

## Backend Tasks
1. **Dependencies & config**
   - Use `requests` + stdlib only; remove `google-genai` once OpenRouter path is production ready.
   - Surface `OPENROUTER_API_KEY`, optional `OPENROUTER_BASE_URL`, `OPENROUTER_NANO_BANANA_MODEL` (default `google/gemini-2.5-flash-image-preview`), and `ENABLE_NANO_BANANA`.
2. **Service module** (`systemsculpt-admin/nano_banana.py`)
   - Build `generate_nano_banana_thumbnail(video_path: str)` that:
     - Collects transcript, title, thumbnail concept text; shapes prompt via helper (including safety instructions).
     - Calls OpenRouter `/chat/completions` with a text prompt + `modalities=["image","text"]` and handles base64 image responses.
     - Captures safety / finish metadata; on `429` or `content_filter` responses, raise a typed exception with actionable message.
     - Saves image + metadata atomically (write to temp, rename on success).
   - Provide hydration function `load_nano_banana_artifact(video_path)` for flow responses.
3. **API layer** (`web_app.py`)
   - Add POST `/api/youtube/nano-banana` accepting `{ path: string }` and returning `{ ok, nano_banana }`.
   - Wire error handling to distinguish: feature disabled (403), rate limited (429), safety blocked (409), generic failure (500).
   - Update `/api/youtube/flow` to include `nano_banana_exists` and metadata in each video record, plus new step descriptor.
4. **Flow logic** (`youtube_flow.py`)
   - Integrate new helper functions for file paths, serialization, and step state.
   - Ensure cleanup on deletion/regeneration.
5. **Telemetry & logging**
   - Add structured logs with prompt hash, latency, OpenRouter request/response IDs, safety outcome.
   - Gate behind `ENABLE_NANO_BANANA` to allow quick disable.

## Front-end Tasks
1. **API bindings** (`frontend/src/lib/api.ts`)
   - Add `generateYouTubeNanoBanana` function + types.
   - Extend `YouTubeVideoFile` with `nano_banana` artifact fields.
2. **UI updates** (`frontend/src/pages/youtube.tsx`)
   - Insert "Nano Banana thumbnail" card after the existing "Thumbnail concept" card.
   - Display preview image, metadata (model, generated_at, safety status), regenerate button, download link.
   - Handle pending/disabled states; surface safety warnings inline.
3. **Asset viewer**
   - Consider modal/lightbox for 1280×720 preview (reuse existing card patterns).
4. **Feature flag messaging**
   - Show informative alert if backend reports feature disabled or quota exceeded.

## Testing Strategy
- **Unit tests**
  - Mock OpenRouter HTTP responses (success, safety block, rate limit) for the new service.
  - Extend API tests to cover success + error states.
  - Update YouTube page Vitest suite to cover Nano Banana card rendering and interactions.
- **Integration smoke**
  - Add `npm run check:plugin` guard for TypeScript typing changes.
  - Optional manual E2E script to hit the Nano Banana endpoint with fixture transcript/title JSON.

## Deployment & Rollout
- Update `.env.example` files with new env vars (`OPENROUTER_API_KEY`, etc.).
- Document the feature flag and rate limit considerations in `README.md` (System Sculpt Admin section).
- Ship behind `ENABLE_NANO_BANANA`; allow gradual rollout.
- Monitor logs for safety blocks and latency spikes during the first runs.

## Open Questions
- Should we support prompt editing before generation? (Likely follow-up UI enhancement.)
- Do we need to queue requests when quota exceeded, or simply surface error? (Investigate usage after initial launch.)
- Long-term: evaluate direct Google Vertex AI access once quotas justify bypassing OpenRouter.
