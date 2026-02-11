# Troubleshooting

## Provider or model list issues

- Verify provider setup under `Settings -> SystemSculpt AI -> Overview & Setup`.
- Re-check API keys/endpoints for the selected provider.
- If model lists fail, test with a second provider to isolate provider-side issues.

## Agent Mode tool behavior seems wrong

- Confirm Agent Mode is enabled in the current chat.
- Remember destructive filesystem tools may require approval.
- If behavior is unexpected, disable allowlisted tools and retry.

## Streaming issues

- Try a different model/provider first.
- Some providers reject tools or images; service layer may retry without them.
- Check for notices/footnotes in chat that explain fallback behavior.

## Similar Notes is empty

1. Enable embeddings in `Embeddings & Search`.
2. Verify provider/model config.
3. Review exclusions (chat history, folders, patterns).
4. Run `Show Embeddings Database Statistics (Debug)`.
5. If needed, run `Rebuild Embeddings`.

## Daily Vault issues

- Use `Open Daily Vault Settings` and verify format/path/template fields.
- Run `Open Today's Daily Note` once after changing settings.

## Audio/transcription failures

- Verify transcription provider credentials and endpoint.
- Verify the model supports transcription.
- For local endpoints, verify local connectivity and process health.

## Diagnostics helpers

- `Copy Resource Usage Report`
- Advanced tab: `Copy diagnostics snapshot`
- Advanced tab: `Open diagnostics folder`
