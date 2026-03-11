# Troubleshooting

## Chat setup or availability

- `Account` should show license, credits, and support.
- Chat runs through SystemSculpt automatically; there is no chat picker in the plugin.
- If chat is unavailable, re-check your SystemSculpt license and credits first.

## Streaming issues

- Retry once after confirming your license and credits are valid.
- SystemSculpt may retry around upstream tool or image limitations automatically.
- Transient upstream rate limits are retried automatically when no assistant output has started yet.
- Check for notices/footnotes in chat that explain the failure.

## Similar Notes is empty

1. Enable embeddings in `Knowledge`.
2. Confirm your SystemSculpt license is active and embeddings processing has a healthy status.
3. Review exclusions (chat history, folders, patterns).
4. Run `Show Embeddings Database Statistics (Debug)`.
5. If needed, run `Rebuild Embeddings`.

## Audio/transcription failures

- Re-check your SystemSculpt license and credits.
- Retry once after confirming the source audio file is still available.
- On desktop, retry with automatic audio conversion enabled if the source format may be incompatible.

## Diagnostics helpers

- `Copy Resource Usage Report`
- Advanced tab: `Copy diagnostics snapshot`
- Advanced tab: `Open diagnostics folder`
