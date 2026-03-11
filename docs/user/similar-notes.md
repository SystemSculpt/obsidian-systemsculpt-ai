# Similar Notes (Embeddings)

Similar Notes is semantic search for your vault.

## Configure

Open `Settings -> SystemSculpt AI -> Knowledge`.

Similar Notes settings now live inside the `Knowledge` tab.

Core controls:

- `Enable embeddings`
- `Embeddings execution` (`SystemSculpt`)
- `Processing status` (refresh + remaining-files modal)
- `Clear embeddings data`
- Exclusions: chat history, Obsidian exclusions, excluded folders, excluded patterns

## Open Similar Notes

- Command: `Open Similar Notes Panel`
- Ribbon: `Open Similar Notes Panel`

## Related commands

- `Find Similar Notes (Current Note)`
- `Rebuild Embeddings`
- `Rebuild Embeddings (Current Model)`
- `Show Embeddings Database Statistics (Debug)`

## Notes

- Processing is background/on-demand, not a single one-shot job.
- Exclusions can dramatically reduce indexed content.
- If SystemSculpt updates the embeddings setup, a rebuild may be required.
