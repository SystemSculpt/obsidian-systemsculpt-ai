# Studio Local macOS Image Generation (Core ML Diffusion)

Last verified against code + machine: **2026-02-23** on **macOS 26.3 (Tahoe)**, **Xcode 26.2**, **Swift 6.2.3**.

## Why this exists

Studio now supports a local macOS image provider (`local_macos_image_generation`) that runs on-machine diffusion with Apple's Core ML stack.

This document records:
- what is implemented right now,
- what variables are controllable,
- what is intentionally unsupported,
- and what we validated end-to-end on this machine.

## Backend decision and findings

We evaluated two Apple-native paths:

1. `ImagePlayground` / `ImageCreator` (Apple Intelligence API)
- API is present and usable from this SDK (`ImageCreator.init()`, `availableStyles`, `images(for:style:limit:)`).
- In CLI context we reproduced `ImageCreator.Error.backgroundCreationForbidden` (app hidden/background), which blocks a robust subprocess backend for Studio.
- Conclusion: useful API for app-foreground UX flows, but not a reliable subprocess backend for current Studio node execution.

2. Apple `ml-stable-diffusion` (`StableDiffusionSample`)
- Works from terminal subprocess with explicit compute units (`cpuAndNeuralEngine`).
- Successfully generated local images on this MacBook using Core ML resources.
- Conclusion: this is the canonical local diffusion backend for Studio today.

## Current feature contract

Local provider is true diffusion (Core ML Stable Diffusion), with explicit fail-loud behavior for unsupported controls.

### Supported inputs

- Prompt text: `yes`
- Image count: `yes` (1..8)
- Local compute units: `yes` (`all`, `cpuOnly`, `cpuAndGPU`, `cpuAndNeuralEngine`)
- Step count: `yes`
- Guidance scale: `yes`
- Scheduler: `yes` (`pndm`/`dpmpp`)
- Seed determinism: `yes` (derived from `prompt + runId`)

### Unsupported (explicitly blocked)

- Input/reference images (image-to-image): `no` right now
  - local command throws a hard error if `inputImages` are present.
- Custom output ratio/size at runtime: `no` right now
  - current bundled model is square output, so Studio local path is forced to `1:1`.
  - Studio inspector hides aspect ratio for local provider to avoid silent mismatch.

## Studio UI behavior for local provider

When provider is `Local macOS image generation`:
- Model selector is hidden.
- Aspect ratio selector is hidden.
- Node execution forces aspect ratio to `1:1` for local backend calls.

## Runtime variables you can control

All variables below are read by `scripts/systemsculpt-local-imagegen.mjs`.

- `SYSTEMSCULPT_LOCAL_IMAGEGEN_BACKEND`
  - values: `coreml_diffusion` (default), `mock` (test-only)
- `SYSTEMSCULPT_LOCAL_DIFFUSION_SAMPLE_BIN`
  - path to `StableDiffusionSample` binary
  - default: `~/gits/apps/ml-stable-diffusion/.build/release/StableDiffusionSample`
- `SYSTEMSCULPT_LOCAL_DIFFUSION_RESOURCE_PATH`
  - path to compiled model resources directory
  - default: `~/.systemsculpt/local-image-models/coreml-stable-diffusion-2-1-base-palettized_split_einsum_v2_compiled/coreml-stable-diffusion-2-1-base-palettized_split_einsum_v2_compiled`
- `SYSTEMSCULPT_LOCAL_DIFFUSION_COMPUTE_UNITS`
  - default: `cpuAndNeuralEngine`
- `SYSTEMSCULPT_LOCAL_DIFFUSION_STEP_COUNT`
  - default: `20` (clamped 1..80)
- `SYSTEMSCULPT_LOCAL_DIFFUSION_GUIDANCE_SCALE`
  - default: `7.5`
- `SYSTEMSCULPT_LOCAL_DIFFUSION_SCHEDULER`
  - default: `pndm`
- `SYSTEMSCULPT_LOCAL_DIFFUSION_DISABLE_SAFETY`
  - default: `true`
- `SYSTEMSCULPT_LOCAL_DIFFUSION_REDUCE_MEMORY`
  - default: `false`
- `SYSTEMSCULPT_LOCAL_DIFFUSION_TIMEOUT_MS`
  - default: `480000`

## Installation and provisioning

Run:

```bash
node scripts/install-local-macos-diffusion-backend.mjs
```

Installer responsibilities:
- ensures `~/gits/apps/ml-stable-diffusion` is cloned,
- builds `StableDiffusionSample` release binary,
- downloads and extracts `apple/coreml-stable-diffusion-2-1-base-palettized` (`split_einsum_v2` compiled variant),
- ensures `systemsculpt-local-imagegen` symlink in common bin paths.

Live Studio-path verification command:

```bash
SYSTEMSCULPT_LOCAL_IMAGEGEN_LIVE=1 npm run test -- src/studio/__tests__/studio-local-macos-image-generation.live.e2e.test.ts
```

## Evidence from this machine (2026-02-23)

Validated on-device generation with:
- binary: `~/gits/apps/ml-stable-diffusion/.build/release/StableDiffusionSample`
- compute units: `cpuAndNeuralEngine`
- resources: palettized SD 2.1 compiled Core ML bundle

Output samples:
- `/Users/systemsculpt/.systemsculpt/local-image-runs/2026-02-23-sd21-smoke/Cinematic_product_photo_of_a_matte_black_MacBook_on_a_walnut_desk,_volumetr.777.final.png`
- `/Users/systemsculpt/.systemsculpt/local-image-runs/2026-02-23-sd21-smoke/Retro_synthwave_city_skyline_at_dusk,_cinematic_lighting,_high_detail.778.final.png`
- `/Users/systemsculpt/.systemsculpt/local-image-runs/2026-02-23-sd21-smoke/Hyperreal_close-up_portrait_of_a_futuristic_explorer_wearing_reflective_vis.0.1001.final.png`

Observed output dimensions: `512x512` for these runs.

## Next upgrades (if we want more control)

1. Add image-to-image references
- Use model assets that include VAE encoder path and wire `--image` + `--strength` in local command.
- Expose one or more input-image slots in Studio local config.

2. Add non-square outputs
- Move to a model/workflow that supports runtime or converted latent size variants.
- Add explicit local size presets rather than a free-form ratio to keep contracts deterministic.

3. Expose expert controls in Studio
- Optional advanced section for local provider:
  - compute units,
  - steps,
  - guidance scale,
  - scheduler,
  - seed mode (auto/fixed).
