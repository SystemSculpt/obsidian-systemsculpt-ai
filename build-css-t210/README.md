# CSS build housekeeping — visual evidence

Production SystemSculpt 6.14.0 plugin running inside an isolated **Obsidian 1.14.5** instance on macOS, at 1280 × 920 and device scale 1. Built-in light/dark themes; no community theme or CSS snippets. Baseline CSS from `b3dc149e` versus the esbuild-bundled/minified stylesheet built from the same CSS sources.

Only synthetic QA content is shown. No account, credentials, real notes, model calls, or customer data were used. The everyday vault, its plugin artifacts, and its watcher were not changed.

## Size and identity

- Before: **337,094 bytes**
- After: **251,985 bytes**
- Saved: **85,109 bytes / 25.25%**
- Final CSS SHA-256: `6937f181be99e4b760b827ff581355457204871bdf8ec9a987f5928aea8e70f9`
- Production main.js SHA-256: `6b0c4baa441040ac36790d16d75bbe82f54b27aeb0506204874e96c52d2102a1`
- Manifest SHA-256: `5d0ba6b619dc9043ae31cb7f102f52167dd16d5159603b51dddcbba8f992fd43`
- No dependency versions changed; the Obsidian declaration pin is the already-locked 1.12.3.

## Method and result

The exact production bundle was loaded in native Obsidian. Chat was opened through the plugin command and populated with a synthetic conversation using its presentation interface (not a model turn). Settings was opened in Obsidian's native settings pop-out and its Chat tab clicked. Studio was opened through its command; its Add menu was used to create a JSON node.

For each surface and theme, the baseline and final CSS were swapped on the **same real DOM**. The loaded final stylesheet was checked against the build hash. Animations, transitions, and the caret were disabled only for deterministic capture. Every visible plugin-surface element's computed standard CSS properties and bounding rectangle were compared. CSS custom-property source spelling was excluded because minification can normalize equivalent tokens. Pseudo-element computed styles were not compared separately. All six final screenshots were visually inspected; the light Chat baseline was inspected too.

| Surface | Theme | Visible elements compared | Computed-style / geometry differences | Different image pixels |
|---|---|---:|---:|---:|
| Chat | Light | 104 | 0 | 936 (one horizontal separator row, y=119) |
| Chat | Dark | 104 | 0 | 0 |
| Settings | Light | 60 | 0 | 0 |
| Settings | Dark | 60 | 0 | 0 |
| Studio | Light | 109 | 0 | 1 (selected node edge) |
| Studio | Dark | 109 | 0 | 0 |

No visible layout, typography, focus-ring, menu, or node-port regression was observed. This is a desktop presentation comparison, not a complete accessibility or native-mobile certification. Deterministic mobile and compiled-bundle gates provide separate coverage.

No product setting, default, migration, or source CSS declaration changed. Settings screenshots use a fresh plugin data file. Screenshots and synthetic presentation setup are supplemental QA, not committed application fixtures.
