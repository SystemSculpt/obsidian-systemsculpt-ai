# Studio Local macOS Image Generation (Core ML Diffusion)

Last verified against code + machine: **2026-02-23** on **macOS 26.3 (Tahoe)**, **Xcode 26.2**, **Swift 6.2.3**.

## Why this exists

Studio supports a local macOS provider (`local_macos_image_generation`) for on-machine image generation with Apple Core ML diffusion.

This doc records:
- the current runtime contract,
- the controllable variables,
- installed resource layout,
- and what to run for verification.

## Backend choice and rationale

We evaluated Apple-native paths and standardized on `apple/ml-stable-diffusion` (`StableDiffusionSample`) for Studio subprocess reliability.

Current local backend is true diffusion and runs in a CLI subprocess from Studio.

## Current capability contract

### Supported

- Text-to-image generation.
- Image-to-image generation using the **first connected input image**.
- Multiple local-native aspect ratios (via ratio-specific Core ML bundles):
  - `1:1`, `4:3`, `3:4`, `16:9`, `9:16`
- Image count (`1..8`).
- Layman local controls:
  - Local Quality (`fast`, `balanced`, `high`)
  - Reference Influence (`subtle`, `balanced`, `strong`)
- Deterministic seed derived from `prompt + runId`.

### Explicit constraints

- If multiple reference images are connected, only the first is used for local generation.
- Local ratio options are limited to the native bundle presets above.
- SystemSculpt API model selection is hidden when local provider is selected.

## Studio node UX behavior

When provider is `Local macOS image generation`:
- `Image Model` is hidden.
- `Local Aspect Ratio` is shown.
- `Local Quality` is shown.
- `Reference Influence` is shown.

When provider is `SystemSculpt AI`:
- `Image Model` and remote `Aspect Ratio` are shown.
- local-only controls are hidden.

## Local runtime variables

The local command is `scripts/systemsculpt-local-imagegen.mjs`.

### Backend and resources

- `SYSTEMSCULPT_LOCAL_IMAGEGEN_BACKEND`
  - `coreml_diffusion` (default), `mock` (tests)
- `SYSTEMSCULPT_LOCAL_DIFFUSION_SAMPLE_BIN`
  - path to `StableDiffusionSample`
- `SYSTEMSCULPT_LOCAL_DIFFUSION_MANIFEST_PATH`
  - path to ratio manifest (`scripts/local-diffusion/model-manifest.json` by default)
- `SYSTEMSCULPT_LOCAL_DIFFUSION_RESOURCE_PATH`
  - explicit resource override path (overrides manifest resource path resolution)

### Diffusion controls

- `SYSTEMSCULPT_LOCAL_DIFFUSION_COMPUTE_UNITS`
  - `all|cpuOnly|cpuAndGPU|cpuAndNeuralEngine`
- `SYSTEMSCULPT_LOCAL_DIFFUSION_STEP_COUNT`
  - hard override for step count
- `SYSTEMSCULPT_LOCAL_DIFFUSION_GUIDANCE_SCALE`
  - hard override for guidance scale
- `SYSTEMSCULPT_LOCAL_DIFFUSION_SCHEDULER`
  - `pndm|dpmpp`
- `SYSTEMSCULPT_LOCAL_DIFFUSION_DISABLE_SAFETY`
- `SYSTEMSCULPT_LOCAL_DIFFUSION_REDUCE_MEMORY`
- `SYSTEMSCULPT_LOCAL_DIFFUSION_TIMEOUT_MS`

If step/guidance env overrides are not provided, local quality preset drives defaults:
- `fast` -> lower steps, faster runtime
- `balanced` -> default
- `high` -> higher steps, more detail

Reference influence maps to img2img `--strength` presets:
- `subtle` -> weaker reference adherence (more creative drift)
- `balanced` -> middle
- `strong` -> stronger adherence to reference composition/style

## Resource layout and manifest

Ratio resources are declared in:
- `scripts/local-diffusion/model-manifest.json`

Installer + ratio builder provision resources under `~/.systemsculpt/local-image-models`, including:
- prebuilt `1:1` compiled bundle
- converted native-ratio bundles for `4:3`, `3:4`, `16:9`, `9:16`

## Install / verify flow

### Full setup

```bash
node scripts/install-local-macos-diffusion-backend.mjs
```

This performs:
- clone/reuse `~/gits/apps/ml-stable-diffusion`
- build/reuse `StableDiffusionSample`
- download/extract SD 2.1 compiled bundle
- create command symlink(s) for `systemsculpt-local-imagegen`
- build native ratio bundles from manifest

### Verify existing setup only

```bash
node scripts/install-local-macos-diffusion-backend.mjs --verify
```

### Ratio builder directly

```bash
node scripts/local-diffusion/build-ratio-bundles.mjs --ratios 1:1,16:9
node scripts/local-diffusion/build-ratio-bundles.mjs --verify --ratios 1:1,4:3,3:4,16:9,9:16
```

## Tests and real checks

### Studio local command path (mock backend)

```bash
npm run test -- src/studio/__tests__/studio-local-macos-image-generation.e2e.test.ts
```

### Studio local command path (live Core ML)

```bash
SYSTEMSCULPT_LOCAL_IMAGEGEN_LIVE=1 npm run test -- src/studio/__tests__/studio-local-macos-image-generation.live.e2e.test.ts
```

### Node config + execution checks

```bash
npm run test -- src/studio/__tests__/studio-node-config-validation.test.ts
npm run test -- src/studio/__tests__/studio-built-in-node-execution.test.ts
```

## Practical behavior notes

- Local img2img preprocessing normalizes the first reference image to target ratio dimensions before CLI invocation.
- Local backend emits warnings in command payload (for example, extra reference images ignored), and Studio logs them.
- Invalid provider/config states fail loudly; no silent fallback to other providers.
