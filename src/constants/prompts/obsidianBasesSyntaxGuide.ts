/**
 * Obsidian Bases syntax guide (injected only when relevant).
 *
 * NOTE: `.base` files must be valid YAML. Most "syntax errors" we see in practice
 * are actually YAML treating a leading `!` as a *tag* instead of a string.
 */
export const OBSIDIAN_BASES_SYNTAX_GUIDE = `<obsidian_bases_syntax_guide>
Obsidian Bases use \`.base\` YAML files to define interactive database views.

MOST COMMON FAILURE (Unresolved tag):
- In YAML, a leading \`!\` starts a YAML tag (custom type), NOT a string.
- In Bases expressions, \`!\` means logical NOT, but the whole expression must be a YAML string.
- Fix: quote any expression that starts with \`!\`.

Examples:
\`\`\`yaml
filters:
  and:
    - 'status != "done"'
    - file.inFolder("Projects")
    # ✅ OK: expression starts with ! so it must be quoted
    - '!file.name.contains("Archive")'
    - '!status'
    # ❌ WRONG (YAML tag): - !status
\`\`\`

TOP-LEVEL STRUCTURE (common keys):
\`\`\`yaml
filters:     # optional; applies to all views
formulas:    # optional; computed fields
properties:  # optional; per-property UI config (e.g. displayName/hidden)
summaries:   # optional; named summary formulas
views:       # required; list of views to render
\`\`\`

VIEWS:
\`\`\`yaml
views:
  - type: table
    name: "Active Projects"
    filters:
      and:
        - file.inFolder("Projects")
        - 'status != "archived"'
    order:            # table column order
      - file.name
      - status
      - file.mtime
    limit: 200
    groupBy:
      - property: status
        direction: asc
    summaries:
      status: count
\`\`\`

FILTERS:
- A filter can be:
  - a string expression (recommended to quote)
  - or an object with \`and:\`, \`or:\`, \`not:\` keys (each takes a list of filters)

Negation (preferred over leading \`!\`):
\`\`\`yaml
filters:
  not:
    - file.inFolder("Archive")
\`\`\`

COMMON EXPRESSIONS:
- Folder: \`file.inFolder("Projects")\`
- Filename: \`file.name.contains("Weekly")\`
- Properties: \`status == "done"\`, \`priority > 2\`
- Missing/falsey property: \`!status\` (quote it if it starts the expression)

RULES OF THUMB:
- Always quote expressions that contain \`!\`, \`:\`, \`#\`, or start with \`!\`.
- Prefer \`not:\` blocks for negation to avoid YAML tag pitfalls.
- When editing an existing \`.base\`, preserve indentation and only change the minimal relevant section.
</obsidian_bases_syntax_guide>`;

