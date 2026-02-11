# Similar Notes (Embeddings)

Similar Notes is semantic search for your vault.

## Configure

Open `Settings -> SystemSculpt AI -> Embeddings & Search`.

Core controls:

- `Enable embeddings`
- `Embeddings provider` (`SystemSculpt` or `Custom provider`)
- Custom provider fields (endpoint, API key, model)
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
- If provider/model changes, embeddings namespaces may need rebuilding.
