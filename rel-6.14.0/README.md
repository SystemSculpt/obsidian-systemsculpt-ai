# SystemSculpt 6.14.0 release demo

Real Obsidian UI in isolated, synthetic vaults. No personal vault data, account details, credentials or private home-directory names are shown.

- `before-modal.png`: published 6.13.3 modal approval.
- `detected-claude.png`, `detected-codex.png`: fresh welcome → detected native agent in Auto. The Codex fixture makes Claude unavailable only in the isolated process; Codex uses its real installed CLI and login.
- `claude-auto.png`, `fresh-codex-auto.png`: native Auto creates and edits notes without a prompt.
- `claude-card-light.png`, `codex-card-dark.png`: real inline requests, keyboard focus and waiting status. Ask was selected deliberately. The Codex request targets an explicitly authorized synthetic file outside the vault, so its full external path is intentionally labelled.
- `native-chat.gif`: 22-second montage of real captured screens: Claude Auto results → keyboard approval → Codex Auto results → keyboard approval. Every request was read before approval.

Native card recordings use the release presentation fix in `33ac8c7e`; the subsequent entitlement migration fix does not alter these screens. These are candidate QA captures, not a substitute for the release's exact-byte verification.
