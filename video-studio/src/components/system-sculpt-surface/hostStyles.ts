import type { CSSProperties } from "react";

export const obsidianThemeStyle: CSSProperties = {
  colorScheme: "dark",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
  color: "#dadada",
  background: "#1e1e1e",
  ["--font-ui-smallest" as string]: "11px",
  ["--font-ui-smaller" as string]: "12px",
  ["--font-ui-small" as string]: "13px",
  ["--font-ui-medium" as string]: "14px",
  ["--font-medium" as string]: "600",
  ["--size-2-1" as string]: "4px",
  ["--size-2-2" as string]: "8px",
  ["--size-2-3" as string]: "10px",
  ["--size-4-1" as string]: "6px",
  ["--size-4-2" as string]: "10px",
  ["--size-4-3" as string]: "14px",
  ["--size-4-8" as string]: "28px",
  ["--radius-s" as string]: "8px",
  ["--radius-m" as string]: "8px",
  ["--icon-m" as string]: "18px",
  ["--icon-xl" as string]: "28px",
  ["--checkbox-size" as string]: "18px",
  ["--background-primary" as string]: "#1e1e1e",
  ["--background-primary-rgb" as string]: "30, 30, 30",
  ["--background-primary-alt" as string]: "#242424",
  ["--background-primary-alt-rgb" as string]: "36, 36, 36",
  ["--background-secondary" as string]: "#262626",
  ["--background-secondary-alt" as string]: "#363636",
  ["--background-secondary-rgb" as string]: "38, 38, 38",
  ["--background-modifier-border" as string]: "#363636",
  ["--background-modifier-border-rgb" as string]: "54, 54, 54",
  ["--background-modifier-border-hover" as string]: "#4a4a4a",
  ["--background-modifier-border-focus" as string]: "hsl(258, 88%, 66%)",
  ["--background-modifier-hover" as string]: "#2c2c2c",
  ["--background-modifier-active-hover" as string]: "#323232",
  ["--background-modifier-form-field" as string]: "#242424",
  ["--background-modifier-success" as string]: "#1f3b2b",
  ["--text-normal" as string]: "#dadada",
  ["--text-muted" as string]: "#b3b3b3",
  ["--text-muted-rgb" as string]: "179, 179, 179",
  ["--text-faint" as string]: "#8f8f8f",
  ["--text-accent" as string]: "hsl(258, 88%, 66%)",
  ["--text-accent-hover" as string]: "hsl(258, 88%, 72%)",
  ["--text-on-accent" as string]: "#ffffff",
  ["--text-error" as string]: "#ff8585",
  ["--text-error-rgb" as string]: "255, 133, 133",
  ["--text-warning" as string]: "#e4b75f",
  ["--interactive-normal" as string]: "#2b2b2b",
  ["--interactive-hover" as string]: "#343434",
  ["--interactive-accent" as string]: "hsl(258, 88%, 66%)",
  ["--interactive-accent-rgb" as string]: "138, 92, 245",
  ["--interactive-accent-hover" as string]: "hsl(258, 88%, 72%)",
  ["--ss-layer-base" as string]: "#1e1e1e",
  ["--color-yellow" as string]: "#d9a441",
  ["--color-green" as string]: "#2e9f69",
  ["--color-green-rgb" as string]: "46, 159, 105",
  ["--color-red" as string]: "#d14343",
  ["--color-red-rgb" as string]: "209, 67, 67",
  ["--icon-color" as string]: "#b3b3b3",
  ["--icon-color-disabled" as string]: "#7d7d7d",
};

export const hostControlCss = `
.systemsculpt-video-host button {
  font: inherit;
}

.systemsculpt-video-host .clickable-icon {
  appearance: none;
  -webkit-appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  margin: 0;
  background: transparent;
  box-shadow: none;
  color: var(--icon-color);
  cursor: pointer;
  flex-shrink: 0;
  line-height: 1;
}

.systemsculpt-video-host .clickable-icon:hover:not(:disabled),
.systemsculpt-video-host .clickable-icon:focus-visible:not(:disabled) {
  color: var(--text-normal);
  background: var(--interactive-hover);
}

.systemsculpt-video-host .clickable-icon:disabled {
  color: var(--icon-color-disabled);
  background: transparent;
  cursor: default;
  opacity: 0.6;
}

.systemsculpt-video-host .clickable-icon svg,
.systemsculpt-video-host .clickable-icon .svg-icon {
  width: 16px;
  height: 16px;
  stroke: currentColor;
  flex-shrink: 0;
}

.systemsculpt-video-host .systemsculpt-chat-composer-button,
.systemsculpt-video-host .systemsculpt-chat-composer-action,
.systemsculpt-video-host .systemsculpt-attachment-pill-remove {
  border: 0;
  background: transparent;
}

.systemsculpt-video-host .systemsculpt-attachment-pill-remove {
  color: var(--text-faint);
}

.systemsculpt-video-host .systemsculpt-attachment-pill-remove:hover,
.systemsculpt-video-host .systemsculpt-attachment-pill-remove:focus-visible {
  color: var(--text-normal);
}

.systemsculpt-video-host .systemsculpt-message-group,
.systemsculpt-video-host .systemsculpt-message,
.systemsculpt-video-host .systemsculpt-user-message,
.systemsculpt-video-host .systemsculpt-assistant-message,
.systemsculpt-video-host .systemsculpt-message-toolbar,
.systemsculpt-video-host .systemsculpt-citations-container,
.systemsculpt-video-host .systemsculpt-chat-structured-block,
.systemsculpt-video-host .systemsculpt-inline-collapsible-wrapper,
.systemsculpt-video-host .ss-modal,
.systemsculpt-video-host .ss-modal__item,
.systemsculpt-video-host .ss-search__item,
.systemsculpt-video-host .ss-search__pill,
.systemsculpt-video-host .ss-search__clear,
.systemsculpt-video-host .ss-search__input-row {
  animation: none !important;
  transition: none !important;
}

.systemsculpt-video-host input,
.systemsculpt-video-host textarea {
  caret-color: transparent;
}

.systemsculpt-video-host .ss-reveal-cursor {
  display: inline-block;
  margin-left: 1px;
  color: var(--text-accent);
  font-weight: 600;
}
`;

export const workspaceStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  background: "var(--background-primary)",
};

export const leafContentStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  minHeight: 0,
  background: "var(--background-primary)",
};

export const viewContentStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
};

export const overlayMountStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
};
