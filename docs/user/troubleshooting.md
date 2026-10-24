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
- Hosted chat reconnects automatically after a dropped connection. Repeated
  attempts back off rather than fetching the conversation every few seconds.
  Recovery waits while your device is offline and resumes when it comes online.
  A hidden chat checks less often; returning to it prompts another check.
- A reconnecting or stalled response keeps its last output visible without a
  moving progress indicator or elapsed timer. This does not mean the server has
  stopped the response: you can still use Stop, and new server activity restores
  the live display.

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

- Advanced tab: `Record diagnostics`. Off by default. Turn it on while you
  reproduce a problem: SystemSculpt then records a resource sample once a
  minute (paused while Obsidian is hidden) and long-frame freezes in
  `.systemsculpt/diagnostics`. Chat lifecycle events stay in memory for support
  reports; saving them to disk requires an Info or Debug log level, or debug
  mode. Recording diagnostics does not override the log level. Failed chat
  runs save incident reports whether or not recording is on.
- `Copy Resource Usage Report`
- Advanced tab: `Copy diagnostics snapshot`
- Advanced tab: `Open diagnostics folder`
