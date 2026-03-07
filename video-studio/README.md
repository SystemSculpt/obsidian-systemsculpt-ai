# Video Studio

Standalone Remotion package for Apple-style product spots driven by the real SystemSculpt Obsidian UI contract.

## Commands

- `npm install`
- `npm run dev`
- `npm run render`
- `npm test`

## Rendering Approach

- Import the real plugin stylesheet from the repo root: `../../styles.css`.
- Reuse actual DOM builders from the plugin where they are already isolated enough to mount in a browser lane:
  - `src/views/chatview/ui/createInputUI.ts`
  - `src/modals/ContextSelectionModal.ts`
  - `src/views/chatview/renderers/InlineCollapsibleBlock.ts`
- Supply only a minimal inline Obsidian compatibility shim so those builders can run inside Remotion.
- No screen recording or placeholder capture boards are used in the canonical path.

## Current Composition

- `PdfAiAssistant30`
  - `1920x1080`
  - `60fps`
  - `1800` frames / `30s`
  - Story: PDF AI assistant transformation spot rendered from the plugin UI contract
