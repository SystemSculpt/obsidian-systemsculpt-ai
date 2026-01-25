# Similar Notes (Embeddings)

Similar Notes is SystemSculpt’s semantic search feature. It uses embeddings (vector representations) to find notes that are meaningfully related, not just keyword matches.

## Enable

1. Obsidian Settings → **SystemSculpt AI** → **Embeddings & Search**
2. Enable embeddings
3. Choose an embeddings provider/model (or configure a custom OpenAI-compatible endpoint)

## Open the panel

- Command palette → **Open Similar Notes Panel**
- Or click the **Open Similar Notes Panel** ribbon icon

## What to expect

- Embeddings are processed in the background as needed (processing is not typically a one-shot “run once” action).
- Results update as you change the active file (and depending on UI flow, as your chat context changes).
- You can exclude folders/files and optionally respect Obsidian’s own exclusions.

## Useful commands

See the full list in: [Commands & hotkeys](commands.md).

- **Find Similar Notes (Current Note)**: jumps you into Similar Notes for the active file
- **Rebuild Embeddings**: clears all embeddings and re-processes
- **Rebuild Embeddings (Current Model)**: rebuild only the current provider/model namespace
- **Show Embeddings Database Statistics (Debug)**: quick stats when embeddings are enabled

## Troubleshooting

If Similar Notes shows empty results:

1. Confirm embeddings are enabled and a provider/model is selected
2. Check exclusions (folder/file exclusions can remove most of the vault)
3. Try **Show Embeddings Database Statistics (Debug)** to confirm files are being processed

More: [Troubleshooting](troubleshooting.md).

