# SystemSculpt 6.15.0 email media

Captured 2026-10-24 for the Oct 28 newsletter (T-433 → T-42). The extra approval, composer and motion assets are supplemental media for the website redesign (T-418/T-423), not replacements for its Kestrel Coast S01–S15 shot list.

## Recommended newsletter pair

| File | Pixels | Recommended display | Bytes |
|---|---:|---:|---:|
| `auto-light.png` | 1200 × 1080 | 600 × 540, 2× | 65,662 |
| `auto-dark.png` | 1200 × 1080 | 600 × 540, 2× | 66,589 |

**Alt text (both):** SystemSculpt chat in Obsidian: Claude Code in Auto mode reads and edits Weekly plan.md, adds a short walk, and shows “Changed 1 note.”

Both are the same real completed turn. The visible run line is **Claude Code on this Mac · Auto · Opus**. There is no approval card, tooltip, focus ring, status-bar badge, account information, personal name or external file path.

## Supplemental assets

| File | Pixels | Bytes | Description |
|---|---:|---:|---|
| `auto-wide-light.png` | 2400 × 1124 | 73,529 | Same Auto turn, 1200-logical-pixel chat pane at 2× |
| `auto-wide-dark.png` | 2400 × 1124 | 74,396 | Same wide chat, dark theme |
| `approval-light.png` | 1200 × 1678 | 128,836 | Real pending edit request, light theme |
| `approval-dark.png` | 1200 × 1678 | 128,253 | Same pending request, dark theme |
| `composer-light.png` | 1200 × 334 | 25,684 | Unsent prompt and attached Weekly plan.md, light theme |
| `composer-dark.png` | 1200 × 334 | 25,935 | Same composer, dark theme |
| `auto-turn-light.gif` | 900 × 810 | 165,566 | 8.84-second loop; a separate real Auto turn from submission through the final receipt |

**Approval alt:** Claude Code asks to change “Review the draft” to “Finish the draft” in Weekly plan.md, with an inline diff and Approve and Deny buttons.

**Composer alt:** SystemSculpt's composer with Weekly plan.md attached, a question about this week's focus, and the Claude Code Auto run line.

**GIF alt:** A real SystemSculpt chat turn: Claude Code reads Weekly plan.md, adds a short walk in Auto mode, and reports that one note changed.

**GIF caption:** A real turn in a sample vault. Waits are shortened.

The GIF excludes the typing segment (and its normal input focus ring), starts just before submission, keeps the actual read/edit/result frames in order, and holds the final receipt for three seconds. No response text or tool result was fabricated or edited. The underlying capture lasted 16.709 seconds including typing; the UI reports 13 seconds for the model turn. All selected source frames were visually checked.

## Provenance

- Plugin: released **6.15.0**, tag commit `f8e94ea469a19436d26b033f4c67ca47b37ca00c`.
- Release: https://github.com/SystemSculpt/obsidian-systemsculpt-ai/releases/tag/6.15.0
- Files downloaded from that release, installed without rebuilding or modification:
  - `main.js`: SHA-256 `6282f065a948321ea678d577d539328a2ba1983bea7739af3fc776727369b0ab`
  - `styles.css`: SHA-256 `58abb73383e793bbbea39a90646f4b2d59f07110131f65ecfb61a6853a08dc7d`
  - `manifest.json`: SHA-256 `9642625160af023d7fa94a6577b32c835195a044be8211c00c353108e4809e8e`
- Host: isolated Obsidian **1.13.7**, new profile, default light/dark themes, 16 px base font, accent `#2B59D6`, 100% zoom, capture at device scale 2.
- Backend: installed, already signed-in Claude Code, selected Opus. No hosted SystemSculpt account or credit spending; SystemSculpt production traffic blocked in the isolated host.
- Synthetic vault only, one neutral note, no personal data. Native operations were actual Read/Edit calls. The pending manual request was read in full before approving once; its sole edit was inside the synthetic vault.
- The approved manual turn finished and the expected note changes were verified on disk. Auto turns requested no permission card.
- Presentation-only cleanup: chat-pane crops exclude host chrome; Obsidian status bar hidden, stale tooltips dismissed, controls blurred. No plugin code, layout CSS, tool output or response wording changed. Chat titles were renamed with the real title control.
- Every delivered still was visually inspected in light and dark. Both 1200-wide newsletter PNGs were inspected at native resolution. The temporary Obsidian instance and profile were removed after capture.

## Initial synthetic note

```markdown
# Weekly plan

A little focus for the week ahead.

## Priorities
- [ ] Review the draft
- [ ] Organize research notes
- [ ] Plan next week

## Friday review
Make time to reflect on what worked.
```

Newsletter prompt: `Read Weekly plan.md and add “Take a short walk” to the priorities. Keep your reply brief.`

Manual approval prompt: `Read Weekly plan.md and change “Review the draft” to “Finish the draft”. Keep your reply brief.`

The GIF repeats the newsletter prompt in a fresh chat after removing the earlier demo's added walk checkbox from the synthetic note. The draft item was already changed by the manual approval demonstration. The GIF's real reply therefore differs slightly from the newsletter stills.
