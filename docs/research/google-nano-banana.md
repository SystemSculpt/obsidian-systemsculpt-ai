# Google "Nano Banana" Image Model Research

_Last updated: 2025-10-03_

## Overview
- **Model identity:** "Nano Banana" is Google’s internal codename for the Gemini 2.5 Flash Image (Preview) model. Google confirmed the name when the model launched publicly on 26 August 2025 as part of the Gemini app and API rollout (see [Beebom](https://beebom.com/google-gemini-nano-banana-image-model/) and [TechSpot](https://www.techspot.com/news/105882-google-unveils-gemini-nano-banana-image-model.html)).
- **Viral adoption:** The model’s photorealistic "figurine" edits triggered more than 200 million image edits and 10+ million new Gemini users within the first weeks of release ([Beebom](https://beebom.com/google-gemini-nano-banana-image-model/); [Android Central](https://www.androidcentral.com/apps-software/google-gemini-nano-banana-10-million-users)).
- **Creative positioning:** Media coverage highlights Nano Banana as the go-to stylised image editor that preserves subject consistency across revisions, now appearing in tools like Adobe Photoshop’s beta Generative Fill ([TechRadar](https://www.techradar.com/computing/artificial-intelligence/google-nano-banana-photoshop)).

## Platform Availability
| Surface | Notes |
| --- | --- |
| **Gemini app & web** | Conversational editing and text-to-image for consumers; outputs include visible AI watermarks and SynthID invisible marks ([Beebom](https://beebom.com/google-gemini-nano-banana-image-model/); [Ars Technica](https://arstechnica.com/gadgets/2025/08/google-improves-gemini-ai-image-editing-with-nano-banana-model/)). |
| **Gemini API (AI Studio)** | Access via `model="gemini-2.5-flash-image-preview"` using the `models.generateContent` endpoint. Requires `GOOGLE_API_KEY` and billing for production traffic ([Google AI Developers](https://ai.google.dev/gemini-api/docs/vision/image-generation)). |
| **OpenRouter** | Proxies the same model as `google/gemini-2.5-flash-image-preview` through `/api/v1/chat/completions`. Requires `OPENROUTER_API_KEY`, sets `modalities=["image","text"]`, and returns base64 image URLs—handy fall-back when direct Gemini quotas are exhausted ([OpenRouter docs](https://openrouter.ai/docs/features/multimodal/image-generation)). |
| **Vertex AI** | Listed as `publishers/google/models/gemini-2.5-flash-image-preview`; enterprise IAM plus regional availability controls ([Skywork AI](https://www.skywork.ai/blog/nano-banana-vs-gemini)). |
| **X (formerly Twitter)** | Official @NanoBanana bot accepts public prompts for quick generation/editing ([Beebom X coverage](https://beebom.com/google-nano-banana-x-bot/)). |
| **Upcoming surfaces** | Android Authority teardowns show hooks for Nano Banana in Google Photos and Search AI Mode; watch for feature flags before hard-coding integrations ([Google Photos report](https://www.androidauthority.com/google-photos-nano-banana-3466463/); [Search AI mode teardown](https://www.androidauthority.com/google-search-ai-mode-nano-banana-3469063/)). |

## Model Capabilities
- **Modes:** Text-to-image, image editing, multi-image fusion, and iterative conversational refinement ([Google AI Developers](https://ai.google.dev/gemini-api/docs/vision/image-generation)).
- **Style controls:** Default look is a saturated, toy-figurine aesthetic; adhere to brand prompts or neutral instructions to dial back the signature look ([TechRadar](https://www.techradar.com/computing/artificial-intelligence/google-nano-banana-photoshop)).
- **Consistency:** Maintains character identity across multiple edits—key for thumbnails and brand shoots ([Ars Technica](https://arstechnica.com/gadgets/2025/08/google-improves-gemini-ai-image-editing-with-nano-banana-model/)).
- **Safety:** Outputs include `safetyAttributes` and are filtered for sensitive content. Expect HTTP 400 with `blockedReason` when prompts trip policy checks ([Google AI Developers](https://ai.google.dev/gemini-api/docs/vision/image-generation)).

## Authentication & Quotas
- **API key reuse:** System Sculpt Admin now prioritises `OPENROUTER_API_KEY`, falling back to direct Gemini only if needed. Keep the existing `GOOGLE_API_KEY` available on the server for embeddings and potential future direct calls; ensure Gemini API scope remains enabled ([Google AI Developers](https://ai.google.dev/gemini-api/docs/vision/image-generation)).
- **Rate limits:** OpenRouter enforces provider-specific quotas (typically 30 RPM / 60k TPM on paid tiers), while direct Google preview calls remain capped at 10 RPM and 200k TPM (`Gemini 2.0 Flash Preview Image Generation` bucket). Surface clear messaging on whichever service returns `429` ([rate limit reference](https://ai.google.dev/gemini-api/docs/rate-limits); [OpenRouter guidance](https://openrouter.ai/pricing)).
- **Daily consumer caps:** Gemini’s free plan allows up to 100 image generations per day; paid AI Pro/Ultra plans raise the ceiling to 1,000 per day ([Android Central](https://www.androidcentral.com/apps-software/google-gemini-nano-banana-10-million-users)).

## Pricing Snapshot (AI Studio)
- Preview image outputs bill at **$0.039 per 1024×1024 image** (~1,290 output tokens at $30 per million tokens) according to Google’s Gemini API pricing table ([Gemini pricing](https://ai.google.dev/pricing)).
- Text prompt tokens remain free on the preview tier; plan for paid usage once the model exits preview.

## API Integration Notes
- **Endpoint:** `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent`
- **Payload template:**
  ```json
  {
    "contents": [
      {
        "role": "user",
        "parts": [
          { "text": "Create a cinematic 16:9 thumbnail starring a productivity coach in a neon workspace." },
          {
            "inline_data": {
              "mime_type": "image/png",
              "data": "<base64 optional reference image>"
            }
          }
        ]
      }
    ],
    "generationConfig": {
      "sampleCount": 1,
      "aspectRatio": "16:9",
      "safetySettings": [
        { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK" }
      ]
    }
  }
  ```
- **Response handling:** Iterate `candidates[0].content.parts`; `inline_data.data` contains base64-encoded PNGs. Inspect `safetyRatings` before saving.
- **Storage:** Persist images beside the source video as `<video>.nano-banana.png` plus `<video>.nano-banana.json` recording prompt, seed (if returned), safety ratings, and model version.

## Security & Trust Considerations
- **Beware impostor APIs:** Domains such as `nanobananaapi.org` or `nanobanana.ai` resell or spoof access and have been flagged as scams by the community. Only trust Google AI Studio, Vertex AI, or sanctioned partners (see this [Reddit thread](https://www.reddit.com/r/StableDiffusion/comments/1eyyl99/nanobananaai_is_a_scam_right/)).
- **Watermark compliance:** Do not strip SynthID metadata; document usage in release notes for transparency.

## Recommended Next Steps
1. **Implementation plan:** Draft a detailed backend/front-end plan (separate document) covering prompt assembly, safety messaging, caching, and retries.
2. **Backend scaffolding:** Build a server module that wraps an OpenRouter `/chat/completions` call (with retries + error mapping) and falls back to direct Gemini only when explicitly configured.
3. **UI updates:** Introduce a "Nano Banana thumbnail" card in the System Sculpt Admin YouTube workflow with preview, metadata, and regeneration controls.
4. **Quota guardrails:** Add per-video cooldowns and environment-driven toggles to stay within Google’s preview limits.
5. **Monitoring:** Log prompt hashes, response IDs, latency, and Google billing usage for traceability.

## References
- Beebom, “The Mysterious Nano-Banana Image Model is From Google and It’s Rolling Out in Gemini,” 26 Aug 2025. <https://beebom.com/google-gemini-nano-banana-image-model/> 
- TechSpot, “Google unveils Gemini's 'nano banana' model, taking AI image generation to the next level,” 26 Aug 2025. <https://www.techspot.com/news/105882-google-unveils-gemini-nano-banana-image-model.html>
- Android Central, “Google says 'Nano Banana' drove in over 10 million new users to its Gemini app,” 9 Sep 2025. <https://www.androidcentral.com/apps-software/google-gemini-nano-banana-10-million-users>
- TechRadar, “You can now use Google’s viral Nano Banana AI directly in Photoshop,” 28 Sep 2025. <https://www.techradar.com/computing/artificial-intelligence/google-nano-banana-photoshop>
- Ars Technica, “Google improves Gemini AI image editing with ‘nano banana’ model,” 26 Aug 2025. <https://arstechnica.com/gadgets/2025/08/google-improves-gemini-ai-image-editing-with-nano-banana-model/>
- Google AI Developers, “Image generation with Gemini (aka Nano Banana),” updated 22 Sep 2025. <https://ai.google.dev/gemini-api/docs/vision/image-generation>
- Skywork AI, “Nano Banana vs Gemini (2025): Google’s Image Model Stack Comparison,” Sep 2025. <https://www.skywork.ai/blog/nano-banana-vs-gemini>
- Beebom, “The New Google AI Tool That Has Everyone ‘Going Bananas’ is Now on X,” 6 Sep 2025. <https://beebom.com/google-nano-banana-x-bot/>
- Android Authority, “Google Photos may soon add viral Nano Banana image editor,” 20 Sep 2025. <https://www.androidauthority.com/google-photos-nano-banana-3466463/>
- Android Authority, “APK teardown hints that Google Search’s AI Mode is getting Nano Banana,” 24 Sep 2025. <https://www.androidauthority.com/google-search-ai-mode-nano-banana-3469063/>
- Google AI Developers, “Gemini API rate limits,” updated 30 Sep 2025. <https://ai.google.dev/gemini-api/docs/rate-limits>
- Google AI Developers, “Gemini Developer API Pricing,” updated 22 Jul 2025. <https://ai.google.dev/pricing>
- Reddit r/StableDiffusion, “nanobanana.ai is a scam, right?” thread, 22 Aug 2025. <https://www.reddit.com/r/StableDiffusion/comments/1eyyl99/nanobananaai_is_a_scam_right/>
