# Troubleshooting

## Chat setup or availability

- Check the run line below the message box: it names the backend, mode and model or hosted credits. Each part opens a menu.
- On desktop, Claude Code and Codex use their own installed app and sign-in, not SystemSculpt credits. If an agent is missing or signed out, finish its native setup and choose **Detect again** in the backend menu.
- For hosted SystemSculpt (including mobile), check your connection and credits in **Account**. A SystemSculpt account is not required to use your own desktop agents.
- Saved chats keep their original backend. Switching backend starts a new chat while carrying your draft and attachments; use **Back** to return to the previous conversation.

## Browser sign-in did not finish

- If the browser cannot return to Obsidian, paste its connection code into the
  sign-in screen and choose **Complete sign-in**.
- If sign-in reports that it is unavailable, choose **Start sign-in again**.
  If Obsidian also reports that settings could not be saved, resolve the vault's
  disk-space or write-permission problem first, then retry.

## Streaming issues

- For hosted chat, check your connection and credits before retrying. For Claude Code or Codex, check that the native app is still signed in.
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
5. If needed, run `Rebuild SystemSculpt embeddings`.

## Audio/transcription failures

- Re-check your SystemSculpt license and credits.
- Retry once after confirming the source audio file is still available.
- On desktop, retry with automatic audio conversion enabled if the source format may be incompatible.

## Studio history from before 6.10

- Studio before 6.10 kept a copy of every save, media included, in
  `.systemsculpt/studio/projects/` inside your vault. Studio no longer uses it.
- After you update, SystemSculpt asks once, in one notice, whether
  to delete that history for the projects that open now, and shows the space it
  frees. It deletes nothing unless you choose **Delete**. It leaves a project's
  history in place when the project fails to open or no longer exists.
- To be asked again, delete `.systemsculpt/studio/legacy-generations-check.json`.

## Diagnostics helpers

- Advanced tab: `Record diagnostics`. Off by default. Turn it on while you
  reproduce a problem: SystemSculpt then records a resource sample once a
  minute (paused while Obsidian is hidden) and long-frame freezes in
  `.systemsculpt/diagnostics`. Chat lifecycle events stay in memory for support
  reports; saving them to disk requires an Info or Debug log level, or debug
  mode. Recording diagnostics does not override the log level. Failed chat
  runs save incident reports whether or not recording is on.
- Failed chat cards show `Preparing report…` while their local incident report
  is saving. `Copy report ID` appears only once that report is saved. If saving
  fails, `Report unavailable` and `Retry report` let you try saving it again
  without rerunning the chat turn. Reopened chats check that the report is still
  available on this device; an ID in chat history alone is not a saved report.
- `Copy Resource Usage Report`
- Advanced tab: `Copy diagnostics snapshot`
- Advanced tab: `Open diagnostics folder`
