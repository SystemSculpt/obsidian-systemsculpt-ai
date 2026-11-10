import { mediaDisplayName } from "./ToolCardBlocks";

/**
 * Every file an answer embeds carries its name beneath it as a vault link: PDFs, audio and
 * video play in place, so their controls take every click; a picture also opens on click
 * (see AgentConversationRenderer), and its name says what it is, as every other embed's does.
 * The line reads as a generated picture's or video's caption does: the name alone.
 */
const SOURCE_EMBEDS: ReadonlyArray<readonly [kind: string, extensions: ReadonlySet<string>]> = [
  ["image", new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"])],
  ["pdf", new Set(["pdf"])],
  ["audio", new Set(["mp3", "wav", "m4a", "ogg", "flac", "3gp", "opus", "aac"])],
  ["video", new Set(["mp4", "webm", "ogv", "mov", "mkv", "m4v"])],
];

/** A reply's player shows play, time, sound and full screen, the same as a generated video's (TurnMedia). */
const PLAYER_CONTROLS = "nodownload noplaybackrate noremoteplayback";

function quietPlayer(embed: HTMLElement): void {
  const apply = (): boolean => {
    const player = embed.querySelector<HTMLMediaElement>("video, audio");
    if (!player) return false;
    player.setAttribute("controlslist", PLAYER_CONTROLS);
    if (player.tagName === "VIDEO") (player as HTMLVideoElement).disablePictureInPicture = true;
    return true;
  };
  if (apply()) return;
  // Obsidian may build the player once the file loads, after the reply's text renders.
  const observer = new MutationObserver(() => { if (apply()) observer.disconnect(); });
  observer.observe(embed, { childList: true, subtree: true });
}

export function embedTarget(embed: Element): string | null {
  const src = embed.getAttribute("src")?.trim();
  return src ? src.split("#")[0].split("|")[0].trim() || null : null;
}

export function enhanceMarkdownEmbeds(parent: HTMLElement): void {
  // Media written after text in the same paragraph ("A picture: ![[x.png]]") starts on its own
  // line, a paragraph's space below that text, as media in a paragraph of its own does.
  for (const embed of Array.from(parent.querySelectorAll<HTMLElement>("p > .internal-embed"))) {
    let previous = embed.previousSibling;
    while (previous?.nodeType === Node.TEXT_NODE && !previous.textContent?.trim()) previous = previous.previousSibling;
    embed.classList.toggle("is-after-text", previous !== null);
  }
  for (const embed of Array.from(parent.querySelectorAll<HTMLElement>(".internal-embed[src]"))) {
    if (embed.closest(".internal-embed") !== embed || embed.parentElement?.closest(".markdown-embed")) continue;
    const target = embedTarget(embed);
    const extension = target?.split(".").pop()?.toLowerCase() ?? "";
    const match = SOURCE_EMBEDS.find(([, extensions]) => extensions.has(extension));
    if (!target || !match) continue;
    if (match[0] === "audio" || match[0] === "video") quietPlayer(embed);
    const next = embed.nextElementSibling;
    if (next?.classList.contains("ss-embed-source") && next.getAttribute("data-href") === target) continue;
    const name = target.split("/").pop() ?? target;
    const link = embed.parentElement!.createEl("a", {
      cls: "internal-link ss-embed-source",
      attr: { href: target, "data-href": target, "aria-label": `Open ${name} in the vault`, "data-embed-kind": match[0] },
    });
    // The same name the chat gives the file everywhere else; its frame above says what kind it is.
    link.setText(mediaDisplayName(target));
    embed.after(link);
  }
}

/**
 * Obsidian's renderer draws a wikilink to a missing note like any other link in a reply; mark
 * it the way Obsidian marks it in a note, so the reply shows that a click would create it.
 */
export function markUnresolvedLinks(parent: HTMLElement, exists: (linkpath: string) => boolean): void {
  for (const link of Array.from(parent.querySelectorAll<HTMLElement>("a.internal-link:not(.ss-embed-source)"))) {
    const href = link.getAttribute("data-href") ?? link.getAttribute("href") ?? "";
    // A link to a heading of this same note ("#Plan") has no note to look for.
    const linkpath = href.split("#")[0].split("|")[0].trim();
    link.classList.toggle("is-unresolved", Boolean(linkpath) && !exists(linkpath));
  }
}
