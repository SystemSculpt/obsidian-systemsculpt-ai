import { setIcon } from "obsidian";

/**
 * Embedded PDFs, audio and video in an answer play in place; their controls
 * take every click, so each gets its file name as a vault link beneath it.
 * Images open their file on click instead (see AgentConversationRenderer).
 */
const SOURCE_EMBEDS: ReadonlyArray<readonly [kind: string, icon: string, extensions: ReadonlySet<string>]> = [
  ["pdf", "file-text", new Set(["pdf"])],
  ["audio", "audio-lines", new Set(["mp3", "wav", "m4a", "ogg", "flac", "3gp", "opus", "aac"])],
  ["video", "video", new Set(["mp4", "webm", "ogv", "mov", "mkv", "m4v"])],
];

export function embedTarget(embed: Element): string | null {
  const src = embed.getAttribute("src")?.trim();
  return src ? src.split("#")[0].split("|")[0].trim() || null : null;
}

export function enhanceMarkdownEmbeds(parent: HTMLElement): void {
  for (const embed of Array.from(parent.querySelectorAll<HTMLElement>(".internal-embed[src]"))) {
    if (embed.closest(".internal-embed") !== embed || embed.parentElement?.closest(".markdown-embed")) continue;
    const target = embedTarget(embed);
    const extension = target?.split(".").pop()?.toLowerCase() ?? "";
    const match = SOURCE_EMBEDS.find(([, , extensions]) => extensions.has(extension));
    if (!target || !match) continue;
    const next = embed.nextElementSibling;
    if (next?.classList.contains("ss-embed-source") && next.getAttribute("data-href") === target) continue;
    const doc = parent.ownerDocument;
    const link = doc.createElement("a");
    link.className = "internal-link ss-embed-source";
    link.setAttribute("href", target);
    link.setAttribute("data-href", target);
    link.setAttribute("aria-label", `Open ${target.split("/").pop()} in the vault`);
    link.dataset.embedKind = match[0];
    const icon = link.appendChild(doc.createElement("span"));
    icon.className = "ss-embed-source-icon";
    icon.setAttribute("aria-hidden", "true");
    setIcon(icon, match[1]);
    link.appendChild(doc.createTextNode(target.split("/").pop() ?? target));
    embed.after(link);
  }
}
