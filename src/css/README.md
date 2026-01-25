# SystemSculpt CSS Architecture

This directory contains all CSS styles for the SystemSculpt Obsidian plugin.

## Namespace Convention

**All CSS classes MUST use one of these prefixes:**

- `ss-` - Short prefix for most components (preferred)
- `systemsculpt-` - Full prefix for top-level containers and views

```css
/* Component classes */
.ss-{component}-{element}
.ss-{component}--{modifier}

/* Top-level containers */
.systemsculpt-{view-name}
.systemsculpt-{component}-modal
```

## CSS Variable Convention

All CSS custom properties should use the `--ss-` prefix:

```css
:root {
  --ss-spacing-sm: 8px;
  --ss-color-accent: var(--interactive-accent);
}
```

## Forbidden Patterns

The CSS lint script (`npm run lint:css`) enforces these rules:

### Never use bare Obsidian selectors:

```css
/* BAD - affects all workspace leaves */
.workspace-leaf-content [role="button"] { ... }

/* GOOD - scoped to plugin views only */
.workspace-leaf-content[data-type="systemsculpt-chat"] [role="button"] { ... }

/* GOOD - scoped with plugin class */
.systemsculpt-chat-view [role="button"] { ... }
```

### Never use bare attribute selectors:

```css
/* BAD - affects all buttons everywhere */
[role="button"] { ... }

/* GOOD - scoped to plugin containers */
.ss-modal [role="button"] { ... }
```

### Always scope Obsidian overrides:

```css
/* BAD - could affect file explorer, other plugins */
.workspace-leaf-content { ... }
.nav-folder { ... }
.tree-item { ... }

/* GOOD - only affects our views */
.workspace-leaf-content[data-type="systemsculpt-chat"] { ... }
```

## Directory Structure

```
src/css/
├── index.css                    # Entry point - imports all CSS
├── base/                        # Foundation styles
│   ├── variables.css            # CSS custom properties
│   ├── reset.css               # Base resets
│   ├── animations.css          # Keyframe animations
│   └── typography.css          # Font styles
├── components/                  # UI components
│   ├── buttons.css
│   ├── modals.css
│   ├── inputs.css
│   └── ...
├── layout/                      # Layout utilities
│   ├── containers.css
│   ├── grid.css
│   └── drawer.css
├── views/                       # View-specific styles
│   ├── chat.css
│   ├── settings.css
│   └── ...
├── modals/                      # Modal-specific styles
├── obsidian-overrides/          # AUDIT TARGET
│   ├── view-content.css         # Scoped overrides (OK)
│   └── DANGER-global.css        # Should be EMPTY
└── fixes/                       # Bug fixes and workarounds
```

## Adding New CSS

1. **Choose the right location:**
   - New component? → `components/`
   - View-specific? → `views/`
   - Modal? → `modals/`
   - Bug fix? → `fixes/`

2. **Use the correct prefix:**
   - Component: `.ss-component-name`
   - Container: `.systemsculpt-container-name`

3. **Add to index.css:**
   ```css
   @import 'components/your-component.css';
   ```

4. **Run the linter:**
   ```bash
   npm run lint:css
   ```

## Obsidian Overrides Policy

Any CSS that targets Obsidian's native selectors (`.workspace-*`, `.modal`, etc.) MUST:

1. Be scoped with `[data-type="systemsculpt-*"]` or a plugin-specific class
2. Live in `obsidian-overrides/view-content.css`
3. Pass the CSS lint check

The `DANGER-global.css` file should **remain empty**. If global overrides are absolutely necessary:

1. Get explicit approval
2. Document the reason in a comment
3. Test that it doesn't break other plugins

## Historical Context

In December 2025, a bug was reported where folder items in Obsidian's file explorer kept indenting right on each click. Root cause was an unscoped selector:

```css
/* This was in favorite-toggle.css:477 */
.workspace-leaf-content [role="button"] {
  position: relative;
}
```

This affected ALL buttons in ANY workspace leaf, including the file explorer. The CSS architecture and lint script were created to prevent such issues.
