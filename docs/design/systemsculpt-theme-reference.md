<!-- SystemSculpt brand palette reference generated from systemsculpt-website -->
# SystemSculpt Brand Reference

## Brand Character
- Modern, confident automation studio identity anchored in electric blue primaries and calm slate neutrals
- Interfaces lean on crisp contrast, rounded corners (`--radius: 0.5rem`), and subtle elevation vs. heavy shadows
- Motion stays deliberate (`var(--ss-transition-normal)` ≈ 200 ms easing) and favors fade/slide pairings over bouncy easing

## Core Color Tokens (HSL Values)

### Light Theme (`:root`)
- **Background** `--background: 0 0% 100%`
- **Foreground** `--foreground: 222.2 84% 4.9%`
- **Card / Popover** `--card`, `--popover: 0 0% 100%`
- **Card/Popover Foreground** `--card-foreground`, `--popover-foreground: 222.2 84% 4.9%`
- **Primary** `--primary: 228 92% 52%` (electric azure)
- **Primary Foreground** `--primary-foreground: 210 40% 98%`
- **Secondary / Muted / Accent Surfaces** `--secondary`, `--muted`, `--accent: 210 40% 96.1%`
- **Secondary / Muted / Accent Foreground** `--secondary-foreground`, `--accent-foreground: 222.2 47.4% 11.2%`
- **Muted Foreground** `--muted-foreground: 215.4 16.3% 42%`
- **Destructive** `--destructive: 0 84% 45%`
- **Destructive Foreground** `--destructive-foreground: 210 40% 98%`
- **Border** `--border: 215 20% 65%`
- **Input** `--input: 214.3 31.8% 91.4%`
- **Ring** `--ring: 228 92% 52%`
- **Sidebar** surfaces range `--sidebar-background: 0 0% 98%` to `--sidebar-primary: 240 5.9% 10%`

### Dark Theme (`.dark`)
- **Background / Card / Popover** `--background`, `--card`, `--popover: 222.2 84% 4.9%`
- **Foreground** `--foreground: 210 40% 98%`
- **Primary** `--primary: 228 88% 58%` (brighter azure for contrast)
- **Secondary / Muted / Accent Surfaces** `--secondary`, `--muted`, `--accent: 217.2 32.6% 17.5%`
- **Muted Foreground** `--muted-foreground: 215 20.2% 65.1%`
- **Border/Input** `--border`, `--input: 217 26% 30%`
- **Sidebar** surfaces deepen from `--sidebar-background: 240 5.9% 10%` to `--sidebar-primary: 224.3 76.3% 48%`
- **Destructive** `--destructive: 0 62.8% 30.6%`

### Extended Accent Ramp
- `--chart-1: 12 76% 61%` (ember orange)
- `--chart-2: 173 58% 39%` (teal)
- `--chart-3: 197 37% 24%` (deep cyan)
- `--chart-4: 43 74% 66%` (warm amber)
- `--chart-5: 27 87% 67%` (golden peach)

### Interaction States
- Hover conventions lean on Tailwind opacity helpers (`bg-primary/90`, `hover:bg-accent`, `hover:text-blue-600`)
- Focus uses dual guard: border switch (`focus-visible:border-ring`) plus soft halo (`focus-visible:ring-ring/50` at 3 px)
- Disabled states keep opacity reductions and block pointer events

## Typography & Spacing
- **Base Font**: Tailwind `font-sans` stack (Inter/var ↔ system sans)
- **Display Weight**: nav & headings lean on `font-semibold` / `font-bold`
- **Sizes**: `text-xl` hero nav, `text-base` body, `text-sm` controls, matching `--ss-font-size-*` tokens (11–18 px range)
- **Tracking**: `tracking-tight` on logotype for compact feel
- **Spacing Scale**: `--ss-space-sm` 8 px, `--ss-space-md` 16 px, `--ss-space-lg` 24 px; reinforces modular rhythm across layouts
- **Radius**: shared `--radius: 0.5rem` cascades to Tailwind `rounded-md/lg`

## Imagery & Iconography Cues
- Navigation uses rounded logo tile (`logo-128.webp`), blue-on-dark gradient brandmark
- Icons inherit currentColor for easy palette alignment; prefer outline strokes (1.5 px) with rounded caps

## Application Notes
- Light and dark modes already optimized for WCAG AA with white or near-white text; maintain this when extending tokens
- Sidebar palettes intentionally desaturate neutrals to keep the electric primary from overwhelming small spaces
- Gradients: when needed, pivot around the primary hue (220–232°) with 10–15° hue offsets for depth without rainbowing

## Core Surface Coverage
- Graph view hooks align WebGL tokens with brand colors (`--graph-node`, `--graph-line`, `--graph-controls*`) while styling controls, hover states, and background glow directly in `theme.css`.
- Canvas inherits SystemSculpt surfaces via `--canvas-*` tokens; nodes gain rounded elevation, selection halos, and brand-aware connection strokes.
- File explorer, outline, and search panes adopt unified hover/active backgrounds, pointer affordances, and selection glows to keep navigation consistent.

## Markdown Treatments
- Callout palette extends beyond `summary` to cover info, success, warning, danger, quotes, and more—each mixes SystemSculpt primary/semantic colors with accessible contrast.
- Code blocks share a dedicated palette (`src/css/base/code-blocks.css`) that restyles Prism tokens, CodeMirror syntax, and copy buttons with brand-linked hues.
- Dataview tables, lists, and inline metadata chips render with SystemSculpt cards, zebra stripes, and accent chips for quick scanning.

## Plugin Integrations
- Dataview styling lives in `src/css/components/dataview.css`, covering table chrome, inline fields, and list modes.
- Templater prompts, multi-suggesters, and CodeMirror hints receive elevated surfaces, accent focus rings, and branded action buttons.
- Shared suggestion menus (`.CodeMirror-hints`, command palette entries) reuse interactive accent and pointer affordances for consistency across plugins.

## Mobile Polish
- Mobile tab bar, toolbar, drawers, and command palette restyle to match SystemSculpt surfaces, with upgraded tap targets and focus cues.
- Recorder, drawer, and provider modals already adapt to full-height mobile layouts with branded borders and padding.

Use this sheet as ground truth when building the SystemSculpt Obsidian theme and its token mapping.

