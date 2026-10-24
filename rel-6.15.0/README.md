# SystemSculpt 6.15.0 release media

Screenshots and a demo for the 6.15.0 release PR. Everything was captured in an isolated Obsidian (installer 1.13.7, app 1.14.5) with a fresh profile and a synthetic demo vault. No personal notes or accounts appear.

## Builds

- **Release build**: `main.js` 6282f065…, `styles.css` 58abb733…, `manifest.json` 96426251… (release branch 82f8c15d). Used for `live-*-light`, `hosted-move-*` and every `fixture-*` file.
- **Release candidate** 25f87e4e (`styles.css` and `manifest.json` identical; `main.js` differs from the release only in #488's menu-Escape handling): `walkthrough.gif` and the `live-*-dark` frames.
- **Earlier candidates** with the same chat UI: `hosted-signed-out-dark` (ba18ce19) and `tablet-landscape-dark` (the #487 fix build).
- **Before**: `before-6.13.3-dark` is the released 6.13.3.

## What is real and what is a fixture

- `live-*`: real Claude Code and Codex on this Mac, with real replies and edits on synthetic notes. Every approval was read before answering.
- `walkthrough.gif`: real app snapshots of one session, with waits shortened (not a continuous recording): first open → first reply → edit request → Alt+Up and Enter approval → saved-chat search and switch. 24 s.
- `hosted-*`: real hosted SystemSculpt on owned QA accounts (signed out; paid plan Auto mode with a reviewed move approval).
- `tablet-landscape-dark`: Obsidian's tablet layout (mobile emulation, 1024×800 landscape) with a real hosted reply.
- `fixture-*`: the production renderer showing synthetic states (questions, plans, errors, loading, code, tools, resolved activity) at 320 px and 900 px, light and dark. These are not live provider results.
