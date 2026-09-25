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
- The same exclusions hide notes from vault search and from the agent's
  `list_items`, `find`, and `search` tools. Those tools also hide an excluded
  folder, or a folder when a rule such as `Daily/**` excludes everything
  inside it. A rule such as `Daily/*` hides only the notes it matches.
- Excluded patterns are globs, such as `*.png`, `Daily/**`, or `**/Archive/*`.
  A pattern without `/` matches file names. Obsidian exclusions follow
  Obsidian's own rules.
- If SystemSculpt updates the embeddings setup, a rebuild may be required.
  The index keeps the searchable generation and the one being built, and
  removes older generations automatically.
- A portable copy of the index lives in `.systemsculpt/embeddings/`: a small
  `index.json` plus binary files in `shards/`. File-level sync and backups
  (iCloud, Dropbox, Syncthing, git) carry it to other devices, so a new
  device can restore the index instead of re-embedding every note. Obsidian
  Sync skips dot-folders and does not carry it. An edit rewrites only the
  shard holding that note, and unchanged notes cause no writes. Releases
  before this format write a single large `index.json`; this release still
  restores from it and replaces it on its first update.
