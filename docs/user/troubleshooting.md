# Troubleshooting

## “No models available” / provider errors

- Confirm your provider API key and endpoint in **Overview & Setup**.
- Some providers require specific base URLs or headers; verify the provider’s docs.
- If you see “API error 429: too many authentication failures,” update your API key/license and retry after a few minutes (the provider may temporarily lock out repeated failed auth attempts).
- If you’re on mobile, some transports/streaming behaviors differ; try switching models/providers to isolate the issue.

## Chat can’t stream / weird partial output

- Try a different provider/model to confirm it’s not provider-specific.
- If the provider rejects tools or images, the plugin may retry without them (you’ll usually see an inline notice/footnote in the UI).

## Document conversion fails (PDF/Office)

- Conversions are capped at ~4.4 MB due to serverless upload limits. Larger files will fail with “413 Request Entity Too Large”.
- Reduce the file size (compress/export) or split the document into smaller PDFs before converting.

## Similar Notes empty / embeddings not processing

1. Confirm **Embeddings & Search** is enabled and a model is selected.
2. Check exclusions (folder/file exclusions can exclude most of the vault).
3. Use **Show Embeddings Database Statistics (Debug)** (only appears when embeddings are enabled).
4. As a last resort, try **Rebuild Embeddings** (clears all embeddings).

See: [Similar Notes](similar-notes.md).

## Daily Vault streak or note creation issues

- Command palette → **Open Daily Vault Settings** and verify directory/name/template settings.
- Run **Open Today's Daily Note** once after changing configuration to ensure the plugin re-syncs.

## Diagnostics helpers (advanced)

These commands can help you capture lightweight diagnostics:

- **Copy Resource Usage Report**

They may save reports under `.systemsculpt/diagnostics` if clipboard copy fails.
