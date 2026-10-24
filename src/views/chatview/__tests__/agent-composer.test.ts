/**
 * @jest-environment jsdom
 */

import { App, Menu, TFile } from "obsidian";
import { AgentComposer, type AgentComposerOptions } from "../AgentComposer";
import { findComposerMentionTrigger } from "../AgentComposerMentions";
import type { ChatMessage } from "../../../types";

type MockMenu = Menu & {
  items: Array<{ title: string; separator?: boolean; click: () => void }>;
  shown: boolean;
  select: (title: string) => void;
};

function lastMenu(): MockMenu {
  const instances = (Menu as unknown as { instances: MockMenu[] }).instances;
  return instances[instances.length - 1];
}

function menuTitles(menu: MockMenu): string[] {
  return menu.items.filter((item) => !item.separator).map((item) => item.title);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

/** Waits for the composer's queued attachment work, however slow the host. */
async function idle(composer: AgentComposer): Promise<void> {
  await settle();
  await (composer as unknown as { attachmentQueue: Promise<void> }).attachmentQueue;
  await settle();
}

function byteFile(name: string, type: string, text: string): File {
  const file = new File([text], name, { type });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode(text).buffer });
  return file;
}

function vaultApp(files: TFile[], options: { active?: TFile | null; contents?: Record<string, string> } = {}) {
  const app = new App();
  (app.vault.getFiles as jest.Mock).mockReturnValue(files);
  (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) =>
    files.find((file) => file.path === path) ?? null);
  (app.vault as any).readBinary = jest.fn(async (file: TFile) =>
    Uint8Array.from(Buffer.from(options.contents?.[file.path] ?? `# ${file.basename}`)).buffer);
  (app.workspace.getActiveFile as jest.Mock).mockReturnValue(options.active ?? null);
  (app.workspace as any).getLastOpenFiles = jest.fn(() => []);
  const openFile = jest.fn(async () => undefined);
  (app.workspace as any).getLeaf = jest.fn(() => ({ openFile }));
  (app.metadataCache as any).fileToLinktext = jest.fn((file: TFile) =>
    file.extension === "md" ? file.basename : file.name);
  return { app, openFile };
}

function mount(options: Partial<AgentComposerOptions> = {}) {
  const parent = document.body.createDiv({ cls: "systemsculpt-agent-workspace" });
  const viewport = parent.createDiv({ cls: "systemsculpt-agent-viewport", attr: { tabindex: "0" } });
  const submissions: any[] = [];
  const composer = new AgentComposer(parent, {
    onSubmit: async (submission) => { submissions.push(submission); },
    onStop: jest.fn(),
    onAttach: jest.fn(),
    onRemoveAttachment: jest.fn(),
    ...options,
  });
  composer.load();
  const input = parent.querySelector<HTMLTextAreaElement>('[data-testid="chat.composer.input"]')!;
  const query = <T extends HTMLElement = HTMLButtonElement>(selector: string) => parent.querySelector<T>(selector);
  return { parent, viewport, composer, input, submissions, query };
}

function type(input: HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.setSelectionRange(value.length, value.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function key(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("AgentComposer", () => {
  const nativeArrayBuffer = Object.getOwnPropertyDescriptor(Blob.prototype, "arrayBuffer");
  beforeAll(() => {
    // jsdom's Blob.arrayBuffer resolves a buffer from another realm, which
    // reads as empty here; FileReader stays in the test realm, as Obsidian does.
    Object.defineProperty(Blob.prototype, "arrayBuffer", {
      configurable: true,
      value(this: Blob) {
        return new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as ArrayBuffer);
          reader.onerror = () => reject(reader.error);
          reader.readAsArrayBuffer(this);
        });
      },
    });
  });
  afterAll(() => {
    if (nativeArrayBuffer) Object.defineProperty(Blob.prototype, "arrayBuffer", nativeArrayBuffer);
  });

  afterEach(() => {
    document.body.empty();
    (Menu as unknown as { instances: unknown[] }).instances.length = 0;
  });

  it("sends while idle, queues while running, and preserves line breaks", async () => {
    const { composer, input, submissions, query, parent } = mount();
    const onStop = (composer as any).options.onStop as jest.Mock;

    expect(query('[aria-label="Add files and notes"]')?.getAttribute("aria-haspopup")).toBe("menu");
    expect(parent.textContent).not.toContain("Enter to send");

    composer.setValue("First request");
    key(input, { key: "Enter" });
    await idle(composer);
    expect(submissions).toEqual([{ text: "First request", mode: "send" }]);

    composer.setRunning(true);
    query('[aria-label="Stop response"]')!.click();
    expect(onStop).toHaveBeenCalledTimes(1);
    composer.setValue("Follow up");
    key(input, { key: "Enter" });
    await idle(composer);
    expect(submissions.at(-1)).toEqual({ text: "Follow up", mode: "queue" });

    composer.setValue("Keep me");
    const newline = key(input, { key: "Enter", shiftKey: true });
    expect(newline.defaultPrevented).toBe(false);
    expect(composer.getValue()).toBe("Keep me");
    composer.unload();
  });

  it("shows Stop while running, and turns Send into Queue only once there is text", () => {
    const { composer, query } = mount();
    const send = query('[data-testid="chat.composer.send"]')!;
    const stop = query('[data-testid="chat.composer.stop"]')!;
    expect(send.hidden).toBe(false);
    expect(send.disabled).toBe(true);
    expect(stop.hidden).toBe(true);

    composer.setRunning(true);
    expect(stop.hidden).toBe(false);
    expect(send.hidden).toBe(true);

    composer.setValue("Also check the links");
    expect(send.hidden).toBe(false);
    expect(send.getAttribute("aria-label")).toBe("Queue follow-up");
    expect(send.disabled).toBe(false);

    composer.setRunning(false);
    expect(stop.hidden).toBe(true);
    expect(send.getAttribute("aria-label")).toBe("Send message");
    composer.unload();
  });

  it("names the agent in the placeholder and follows the running, after-deny, and read-only states", async () => {
    const { composer, input } = mount();
    expect(input.placeholder).toBe("Ask SystemSculpt to work in your vault…");
    expect(input.getAttribute("aria-label")).toBe("Message SystemSculpt");

    composer.setAgentName("Claude Code");
    expect(input.placeholder).toBe("Ask Claude Code to work in your vault…");
    expect(input.getAttribute("aria-label")).toBe("Message Claude Code");

    composer.setRunning(true);
    expect(input.placeholder).toBe("Queue a follow-up…");
    composer.setRunning(false);

    composer.showSteeringPlaceholder();
    expect(input.placeholder).toBe("Tell Claude Code what to do instead…");
    composer.setValue("Use the Archive folder instead");
    key(input, { key: "Enter" });
    await idle(composer);
    expect(input.placeholder).toBe("Ask Claude Code to work in your vault…");

    composer.setReadOnly("View-only saved chat. Start a new chat to continue.");
    expect(input.placeholder).toBe("Start a new chat to continue.");
    composer.unload();
  });

  it("makes a saved-history composer visibly read-only until a new chat enables it", async () => {
    const { composer, input, query, parent } = mount();
    const options = (composer as any).options;
    composer.setValue("Draft that must not be sent");
    composer.setAttachments([{ id: "legacy-context", label: "Legacy.md", path: "Legacy.md", kind: "vault" }]);

    composer.setReadOnly("View-only saved chat. Start a new chat to continue.");

    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe("Start a new chat to continue.");
    expect(query(".systemsculpt-agent-prompt-hint")?.textContent)
      .toBe("View-only saved chat. Start a new chat to continue.");
    expect(query('[aria-label="Send message"]')!.disabled).toBe(true);
    expect(query('[aria-label="Add files and notes"]')!.disabled).toBe(true);
    expect(parent.querySelector<HTMLSelectElement>('[aria-label="Vault changes"]')!.disabled).toBe(true);
    expect(query('[aria-label="Unpin Legacy.md"]')!.disabled).toBe(true);

    key(input, { key: "Enter" });
    query('[aria-label="Unpin Legacy.md"]')!.click();
    await Promise.resolve();
    expect(options.onRemoveAttachment).not.toHaveBeenCalled();
    expect(composer.getValue()).toBe("Draft that must not be sent");

    composer.setReadOnly(null);

    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe("Ask SystemSculpt to work in your vault…");
    expect(query(".systemsculpt-agent-prompt-hint")!.hidden).toBe(true);
    query('[aria-label="Send message"]')!.click();
    await idle(composer);
    expect((composer as any).options.onSubmit).toBeDefined();
    composer.unload();
  });

  it("exposes a footer slot under the card for the run line", () => {
    const { composer, query } = mount();
    const card = query<HTMLElement>(".systemsculpt-agent-prompt")!;
    expect(composer.footerSlot.parentElement).toBe(composer.element);
    expect(card.nextElementSibling).toBe(composer.footerSlot);
    expect(composer.footerSlot.classList.contains("systemsculpt-agent-composer-footer")).toBe(true);
    composer.unload();
  });

  it("grows from one line to 40% of the view, never capping below six lines, then scrolls", () => {
    const { input, parent, composer } = mount();
    Object.defineProperty(parent, "clientHeight", { configurable: true, value: 1000 });
    let content = 48;
    Object.defineProperty(input, "scrollHeight", { configurable: true, get: () => content });

    type(input, "One line");
    expect(input.style.height).toBe("48px");
    expect(input.classList.contains("is-scrollable")).toBe(false);

    content = 900;
    type(input, "Many\nlines");
    expect(input.style.height).toBe("400px");
    expect(input.classList.contains("is-scrollable")).toBe(true);

    // A short view still allows six lines (the 20px fallback line height here,
    // plus the field's vertical padding).
    Object.defineProperty(parent, "clientHeight", { configurable: true, value: 200 });
    type(input, "Many\nmore\nlines");
    const sixLines = Number.parseInt(input.style.height, 10);
    expect(sixLines).toBeGreaterThanOrEqual(120);
    expect(sixLines).toBeLessThan(140);

    content = 24;
    composer.setValue("");
    expect(input.style.height).toBe("24px");

    // A view that isn't laid out yet keeps the natural one-line height.
    content = 0;
    composer.setValue("Typed while hidden");
    expect(input.style.height).toBe("");
    composer.unload();
  });

  it("stops a running response with Escape, and leaves Escape alone while idle", () => {
    const onStop = jest.fn();
    const { composer, input } = mount({ onStop });
    expect(key(input, { key: "Escape" }).defaultPrevented).toBe(false);
    expect(onStop).not.toHaveBeenCalled();

    composer.setRunning(true);
    expect(key(input, { key: "Escape" }).defaultPrevented).toBe(true);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(key(input, { key: "Escape", isComposing: true }).defaultPrevented).toBe(false);
    expect(onStop).toHaveBeenCalledTimes(1);
    composer.unload();
  });

  it("inserts a newline on touch keyboards and sends with the button", async () => {
    const matchMedia = jest.fn((query: string) => ({ matches: query === "(pointer: coarse)" }));
    const original = window.matchMedia;
    (window as any).matchMedia = matchMedia;
    try {
      const { composer, input, submissions, query } = mount();
      composer.setValue("Line one");
      expect(key(input, { key: "Enter" }).defaultPrevented).toBe(false);
      expect(submissions).toHaveLength(0);
      query('[data-testid="chat.composer.send"]')!.click();
      await idle(composer);
      expect(submissions).toEqual([{ text: "Line one", mode: "send" }]);
      composer.unload();
    } finally {
      (window as any).matchMedia = original;
    }
  });

  it("recalls earlier prompts with Up and Down from an empty box", async () => {
    const { composer, input } = mount();
    const history: ChatMessage[] = [
      { role: "user", content: "Summarize Plan.md", message_id: "u1" },
      { role: "assistant", content: "Done.", message_id: "a1" },
      { role: "user", content: "Now add owners", message_id: "u2" },
    ];
    composer.setPromptHistory(history);

    expect(key(input, { key: "ArrowUp" }).defaultPrevented).toBe(true);
    expect(input.value).toBe("Now add owners");
    expect(input.selectionStart).toBe(0);
    key(input, { key: "ArrowUp" });
    expect(input.value).toBe("Summarize Plan.md");
    // Nothing older: Up does nothing more.
    expect(key(input, { key: "ArrowUp" }).defaultPrevented).toBe(false);

    input.setSelectionRange(input.value.length, input.value.length);
    key(input, { key: "ArrowDown" });
    expect(input.value).toBe("Now add owners");
    key(input, { key: "ArrowDown" });
    expect(input.value).toBe("");

    // A typed draft keeps Up for the caret, and Alt+Up stays free for the review pill.
    type(input, "My own draft");
    input.setSelectionRange(0, 0);
    expect(key(input, { key: "ArrowUp" }).defaultPrevented).toBe(false);
    expect(input.value).toBe("My own draft");
    composer.setValue("");
    expect(key(input, { key: "ArrowUp", altKey: true }).defaultPrevented).toBe(false);
    expect(input.value).toBe("");

    // Sent prompts join the history right away.
    composer.setValue("Third prompt");
    key(input, { key: "Enter" });
    await idle(composer);
    key(input, { key: "ArrowUp" });
    expect(input.value).toBe("Third prompt");
    composer.unload();
  });

  it("sends typing from the conversation to the message box, and Escape returns there", () => {
    const { composer, input, viewport, parent } = mount();
    const toolLine = viewport.createEl("button", { text: "Read Plan.md" });
    toolLine.focus();

    const typed = key(toolLine, { key: "a" });
    expect(typed.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("a");

    toolLine.focus();
    key(toolLine, { key: "Escape" });
    expect(document.activeElement).toBe(input);

    // Space activates the focused control; shortcuts and cards keep their keys.
    toolLine.focus();
    expect(key(toolLine, { key: " " }).defaultPrevented).toBe(false);
    expect(key(toolLine, { key: "k", metaKey: true }).defaultPrevented).toBe(false);
    const card = viewport.createDiv({ cls: "systemsculpt-agent-approval" });
    const approve = card.createEl("button", { text: "Approve" });
    approve.focus();
    expect(key(approve, { key: "1" }).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(approve);
    // Header chrome is outside the conversation.
    const header = parent.createDiv({ cls: "systemsculpt-agent-header" });
    const more = header.createEl("button");
    more.focus();
    expect(key(more, { key: "x" }).defaultPrevented).toBe(false);
    expect(input.value).toBe("a");
    composer.unload();
  });

  it("offers the + menu: current note, vault notes, upload, and pins", async () => {
    const plan = new TFile({ path: "Projects/Plan.md" });
    const { app } = vaultApp([plan], { active: plan });
    const onAttach = jest.fn();
    const { composer, query, parent } = mount({ app, onAttach });
    const picker = parent.querySelector<HTMLInputElement>('[data-testid="chat.composer.file-picker"]')!;
    const pickerClick = jest.spyOn(picker, "click").mockImplementation(() => undefined);

    query('[data-testid="chat.composer.add"]')!.click();
    let menu = lastMenu();
    expect(menu.shown).toBe(true);
    expect(menuTitles(menu)).toEqual([
      "Add current note: Plan",
      "Add notes from vault…",
      "Upload from computer…",
      "Pin files for every message…",
    ]);
    menu.select("Upload from computer…");
    expect(pickerClick).toHaveBeenCalledTimes(1);

    query('[data-testid="chat.composer.add"]')!.click();
    lastMenu().select("Pin files for every message…");
    expect(onAttach).toHaveBeenCalledTimes(1);

    query('[data-testid="chat.composer.add"]')!.click();
    lastMenu().select("Add current note: Plan");
    await idle(composer);
    const chip = query<HTMLElement>(".systemsculpt-agent-attachment.is-message")!;
    expect(chip.textContent).toContain("Plan.md");
    expect(composer.getMessageAttachments()).toEqual([
      expect.objectContaining({ name: "Projects/Plan.md", kind: "text" }),
    ]);

    (app.workspace.getActiveFile as jest.Mock).mockReturnValue(null);
    query('[data-testid="chat.composer.add"]')!.click();
    menu = lastMenu();
    expect(menuTitles(menu)).not.toContain("Add current note: Plan");
    menu.hide();
    await idle(composer);
    expect(document.activeElement).toBe(query('[data-testid="chat.composer.add"]'));

    // A click elsewhere closes the menu without pulling focus back.
    query('[data-testid="chat.composer.add"]')!.click();
    const elsewhere = document.body.createEl("button");
    elsewhere.focus();
    elsewhere.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    lastMenu().hide();
    await idle(composer);
    expect(document.activeElement).toBe(elsewhere);
    composer.unload();
  });

  it("suggests the active note as a ghost chip only while the composer is empty, and never adds it by itself", async () => {
    const plan = new TFile({ path: "Plan.md" });
    const { app } = vaultApp([plan], { active: plan });
    const { composer, input, query, submissions } = mount({ app });
    const ghost = query('[data-testid="chat.composer.suggest-note"]')!;
    expect(ghost.hidden).toBe(false);
    expect(ghost.getAttribute("aria-label")).toBe("Add current note: Plan");
    expect(composer.getMessageAttachments()).toEqual([]);

    type(input, "Hello");
    expect(ghost.hidden).toBe(true);
    key(input, { key: "Enter" });
    await idle(composer);
    expect(submissions[0].attachments).toBeUndefined();
    expect(ghost.hidden).toBe(false);

    ghost.click();
    await idle(composer);
    expect(ghost.hidden).toBe(true);
    expect(composer.getMessageAttachments()).toHaveLength(1);
    composer.unload();
  });

  it("opens the mention popover on @ and [[, inserts a readable link, and adds the note as a chip", async () => {
    const files = [
      new TFile({ path: "Projects/Plan.md" }),
      new TFile({ path: "Projects/Planning notes.md" }),
      new TFile({ path: "Assets/plan.png" }),
      new TFile({ path: "Audio/plan.mp3" }),
      ...Array.from({ length: 12 }, (_, index) => new TFile({ path: `Pile/Plank ${index}.md` })),
    ];
    const { app } = vaultApp(files);
    const { composer, input, query } = mount({ app });
    const popover = query<HTMLElement>('[data-testid="chat.composer.mention"]')!;

    type(input, "Tighten @pla");
    expect(popover.hidden).toBe(false);
    expect(input.getAttribute("role")).toBe("combobox");
    const options = Array.from(popover.querySelectorAll<HTMLElement>('[role="option"]'));
    expect(options).toHaveLength(8);
    expect(options[0].textContent).toContain("Plan");
    expect(options[0].textContent).toContain("Projects");
    expect(popover.textContent).not.toContain("plan.mp3");

    key(input, { key: "ArrowDown" });
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    key(input, { key: "ArrowUp" });
    const insert = key(input, { key: "Enter" });
    expect(insert.defaultPrevented).toBe(true);
    await idle(composer);
    expect(input.value).toBe("Tighten [[Plan]] ");
    expect(popover.hidden).toBe(true);
    expect(input.hasAttribute("role")).toBe(false);
    expect(composer.getMessageAttachments()).toEqual([
      expect.objectContaining({ name: "Projects/Plan.md" }),
    ]);

    type(input, "Tighten [[Plan]] and [[Planning");
    expect(popover.hidden).toBe(false);
    key(input, { key: "Tab" });
    await idle(composer);
    expect(input.value).toBe("Tighten [[Plan]] and [[Planning notes]] ");
    expect(composer.getMessageAttachments()).toHaveLength(2);

    // Escape closes the popover without stopping or clearing anything.
    composer.setRunning(true);
    type(input, `${input.value}@pl`);
    expect(popover.hidden).toBe(false);
    key(input, { key: "Escape" });
    expect(popover.hidden).toBe(true);
    expect((composer as any).options.onStop).not.toHaveBeenCalled();
    composer.unload();
  });

  it("queues a second note added while the first is still being read instead of dropping it", async () => {
    const plan = new TFile({ path: "Plan.md" });
    const ideas = new TFile({ path: "Ideas.md" });
    const { app } = vaultApp([plan, ideas]);
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => { releaseFirst = resolve; });
    (app.vault as any).readBinary = jest.fn(async (file: TFile) => {
      if (file === plan) await firstRead;
      return Uint8Array.from(Buffer.from(`# ${file.basename}`)).buffer;
    });
    const { composer } = mount({ app });
    const first = (composer as any).addVaultFiles([plan]);
    const second = (composer as any).addVaultFiles([ideas]);
    await settle();
    expect(composer.getMessageAttachments()).toEqual([]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(composer.getMessageAttachments().map((attachment) => attachment.name)).toEqual(["Plan.md", "Ideas.md"]);
    composer.unload();
  });

  it("only treats @ at a word start and an open [[ as mentions", () => {
    expect(findComposerMentionTrigger("email me@x", 10)).toBeNull();
    expect(findComposerMentionTrigger("@", 1)).toEqual({ start: 0, end: 1, query: "", kind: "@" });
    expect(findComposerMentionTrigger("see [[My no", 11)).toEqual({ start: 4, end: 11, query: "My no", kind: "[[" });
    expect(findComposerMentionTrigger("see [[Done]] now", 16)).toBeNull();
    expect(findComposerMentionTrigger("see [[Pl]]", 8)).toEqual({ start: 4, end: 10, query: "Pl", kind: "[[" });
  });

  it("distinguishes pinned files from one-message attachments, with a chip menu for each", async () => {
    const plan = new TFile({ path: "Projects/Plan.md" });
    const { app, openFile } = vaultApp([plan]);
    const onRemoveAttachment = jest.fn();
    const onVaultContextDrop = jest.fn();
    const { composer, query, parent } = mount({ app, onRemoveAttachment, onVaultContextDrop });
    composer.setAttachments([{ id: "a", label: "Plan.md", path: "[[Projects/Plan.md]]", kind: "vault" }]);
    const list = query<HTMLElement>(".systemsculpt-agent-composer-attachments")!;
    expect(list.getAttribute("role")).toBe("list");
    expect(list.getAttribute("aria-label")).toBe("Message attachments and pinned files");
    expect(list.getAttribute("aria-description")).toContain("Pinned files are reread for every message");
    const pinned = query<HTMLElement>(".systemsculpt-agent-attachment.is-pinned")!;
    expect(pinned.getAttribute("role")).toBe("listitem");
    expect(pinned.title).toBe("Projects/Plan.md. Pinned and reread for every message.");
    expect(pinned.querySelector(".systemsculpt-agent-attachment-icon.is-pin")).not.toBeNull();

    pinned.querySelector<HTMLButtonElement>('[data-testid="chat.composer.attachment.open"]')!.click();
    expect(menuTitles(lastMenu())).toEqual(["Open", "Unpin"]);
    lastMenu().select("Open");
    await Promise.resolve();
    expect(openFile).toHaveBeenCalledWith(plan);

    query('[aria-label="Unpin Plan.md"]')!.click();
    expect(onRemoveAttachment).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));

    composer.setAttachments([]);
    query('[data-testid="chat.composer.add"]')!.click();
    expect(menuTitles(lastMenu())).toContain("Add notes from vault…");
    lastMenu().hide();
    await (composer as any).addVaultFiles([plan]);
    const message = parent.querySelector<HTMLElement>(".systemsculpt-agent-attachment.is-message")!;
    message.querySelector<HTMLButtonElement>('[data-testid="chat.composer.attachment.open"]')!.click();
    expect(menuTitles(lastMenu())).toEqual(["Open", "Pin for every message", "Remove"]);
    lastMenu().select("Pin for every message");
    await idle(composer);
    expect(onVaultContextDrop).toHaveBeenCalledWith("Projects/Plan.md");
    expect(composer.getMessageAttachments()).toEqual([]);

    const upload = byteFile("notes.txt", "text/plain", "notes");
    await (composer as any).ingestFiles([upload]);
    parent.querySelector<HTMLButtonElement>(".is-message [data-testid='chat.composer.attachment.open']")!.click();
    expect(menuTitles(lastMenu())).toEqual(["Remove"]);
    composer.unload();
  });

  it("keeps a vault image thumbnail visible after selection", () => {
    const { composer, parent } = mount();
    composer.setAttachments([{
      id: "image",
      label: "Diagram.png",
      path: "[[Images/Diagram.png]]",
      kind: "image",
      previewUrl: "app://local/Images/Diagram.png",
    }]);

    const preview = parent.querySelector<HTMLImageElement>(
      ".systemsculpt-agent-attachment.is-pinned .systemsculpt-agent-attachment-preview",
    )!;
    expect(preview.src).toContain("Images/Diagram.png");
    expect(preview.alt).toBe("");
    expect(preview.loading).toBe("lazy");
    expect(preview.decoding).toBe("async");
    expect(preview.draggable).toBe(false);

    preview.dispatchEvent(new Event("error"));
    expect(parent.querySelector(".systemsculpt-agent-attachment.is-pinned img")).toBeNull();
    expect(parent.querySelector(".systemsculpt-agent-attachment.is-pinned .systemsculpt-agent-attachment-icon"))
      .not.toBeNull();
    composer.unload();
  });

  it("preserves pasted text while ingesting multiple mixed clipboard files", async () => {
    const { composer, parent, input, submissions } = mount();
    const text = byteFile("plan.md", "text/markdown", "# Plan");
    const image = new File([new Uint8Array([1, 2, 3])], "diagram.png", { type: "image/png" });
    Object.defineProperty(image, "arrayBuffer", { value: async () => new Uint8Array([1, 2, 3]).buffer });

    composer.setValue("Pasted instructions");
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { types: ["Files", "text/plain"], files: [text, image], items: [], getData: () => "Pasted instructions" },
    });
    input.dispatchEvent(paste);
    await idle(composer);

    expect(paste.defaultPrevented).toBe(false);
    expect(parent.querySelectorAll(".systemsculpt-agent-attachment.is-message")).toHaveLength(2);
    expect(parent.querySelector<HTMLImageElement>(".systemsculpt-agent-attachment-preview")?.src)
      .toMatch(/^data:image\/png;base64,/);
    parent.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click();
    await idle(composer);

    expect(submissions).toHaveLength(1);
    expect(submissions[0].text).toBe("Pasted instructions");
    expect(submissions[0].attachments.map((item: any) => item.kind)).toEqual(["text", "image"]);
    expect(parent.querySelectorAll(".systemsculpt-agent-attachment.is-message")).toHaveLength(0);
    composer.unload();
  });

  it("pastes an image alone as a chip without inserting anything", async () => {
    const { composer, parent, input } = mount();
    const image = new File([new Uint8Array([4, 5])], "image.png", { type: "image/png" });
    Object.defineProperty(image, "arrayBuffer", { value: async () => new Uint8Array([4, 5]).buffer });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { types: ["Files"], files: [image], items: [], getData: () => "" },
    });
    input.dispatchEvent(paste);
    await idle(composer);
    expect(paste.defaultPrevented).toBe(true);
    expect(parent.querySelectorAll(".systemsculpt-agent-attachment.is-message.is-image")).toHaveLength(1);
    composer.unload();
  });

  it("ingests multiple mixed files through the native picker and sends attachment-only", async () => {
    const { composer, parent, submissions } = mount();
    const text = byteFile("notes.txt", "text/plain", "notes");
    const image = new File([new Uint8Array([7, 8])], "photo.webp", { type: "image/webp" });
    Object.defineProperty(image, "arrayBuffer", { value: async () => new Uint8Array([7, 8]).buffer });
    const picker = parent.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(picker, "files", { configurable: true, value: [text, image] });
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await idle(composer);

    expect(parent.querySelectorAll(".systemsculpt-agent-attachment.is-message")).toHaveLength(2);
    parent.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click();
    await idle(composer);

    expect(submissions).toHaveLength(1);
    expect(submissions[0].text).toBe("");
    expect(submissions[0].attachments.map((item: any) => item.kind)).toEqual(["text", "image"]);
    composer.unload();
  });

  it("says in words why a file can't be sent, under the chips, until dismissed", async () => {
    const { composer, parent, query } = mount();
    const heic = byteFile("shot.heic", "image/heic", "heic");
    await (composer as any).ingestFiles([heic]);
    const errors = query<HTMLElement>(".systemsculpt-agent-composer-errors")!;
    expect(errors.hidden).toBe(false);
    expect(errors.getAttribute("role")).toBe("alert");
    expect(errors.textContent).toContain("shot.heic is not supported. Attach PDF, image, Markdown, text, or source files.");
    expect(parent.querySelectorAll(".systemsculpt-agent-attachment")).toHaveLength(0);

    query('[data-testid="chat.composer.errors.dismiss"]')!.click();
    expect(errors.hidden).toBe(true);
    composer.unload();
  });

  it("restores a rejected submission without overwriting the newer draft", () => {
    const { composer } = mount();
    composer.setValue("New draft typed while waiting");
    const rejectedAttachment = {
      status: "ready" as const,
      id: "text-hash",
      name: "brief.md",
      mimeType: "text/markdown",
      byteLength: 7,
      kind: "text" as const,
      contentPart: {
        type: "text" as const,
        text: "--- BEGIN ATTACHED FILE: brief.md (text/markdown) ---\n# Brief\n--- END ATTACHED FILE: brief.md ---",
      },
    };

    composer.restoreRejectedSubmission({ text: "Rejected request", attachments: [rejectedAttachment] });

    expect(composer.getValue()).toBe("Rejected request\n\nNew draft typed while waiting");
    expect(composer.getMessageAttachments()).toEqual([rejectedAttachment]);
    expect(composer.hasDraft()).toBe(true);
    composer.unload();
  });

  it("blocks a mixed batch when PDF processing fails, says why, then submits the whole batch after retry", async () => {
    let attempt = 0;
    const { composer, parent, submissions, query } = mount({
      documentAttachmentProcessor: {
        prepare: jest.fn(async () => {
          attempt += 1;
          if (attempt === 1) throw new Error("conversion failed");
          return { operationId: "pdf-retry", markdown: "Recovered document" };
        }),
        complete: jest.fn(async () => undefined),
        discard: jest.fn(async () => undefined),
      },
    });
    const picker = parent.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(picker, "files", {
      configurable: true,
      value: [
        byteFile("notes.md", "text/markdown", "notes"),
        byteFile("broken.pdf", "application/pdf", "%PDF"),
        byteFile("diagram.png", "image/png", "image"),
      ],
    });
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await idle(composer);

    expect(query<HTMLElement>(".systemsculpt-agent-composer-errors")!.textContent)
      .toContain("broken.pdf could not be processed: conversion failed");
    const send = query('[aria-label="Send message"]')!;
    expect(parent.querySelectorAll(".systemsculpt-agent-attachment.is-message")).toHaveLength(3);
    expect(query<HTMLElement>(".systemsculpt-agent-attachment.is-failed")?.textContent).toContain("broken.pdf");
    expect(send.disabled).toBe(true);
    send.click();
    expect(submissions).toEqual([]);

    query('[data-testid="chat.composer.attachment.retry"]')!.click();
    await idle(composer);

    expect(query<HTMLElement>(".systemsculpt-agent-composer-errors")!.hidden).toBe(true);
    expect(send.disabled).toBe(false);
    send.click();
    await idle(composer);
    expect(submissions).toHaveLength(1);
    expect(submissions[0].attachments.map((attachment: any) => attachment.name)).toEqual([
      "notes.md", "broken.pdf", "diagram.png",
    ]);
    composer.unload();
  });

  it("shows a reading chip and a stop control while documents process, and stops them when clicked or when the chat closes (#420)", async () => {
    const signals: AbortSignal[] = [];
    const { composer, parent, query } = mount({
      documentAttachmentProcessor: {
        prepare: jest.fn((_input, { signal }) => new Promise<never>((_resolve, reject) => {
          signals.push(signal);
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })),
        complete: jest.fn(async () => undefined),
        discard: jest.fn(async () => undefined),
      },
    });
    const stop = query('[data-testid="chat.composer.attachment.cancel"]')!;
    expect(stop.hidden).toBe(true);

    const picker = parent.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(picker, "files", { configurable: true, value: [byteFile("slow.pdf", "application/pdf", "%PDF")] });
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    for (let turn = 0; signals.length === 0 && turn < 100; turn++) await Promise.resolve();
    expect(stop.hidden).toBe(false);
    const reading = query<HTMLElement>(".systemsculpt-agent-attachment.is-processing")!;
    expect(reading.textContent).toContain("Reading slow.pdf…");
    expect(reading.querySelector(".systemsculpt-agent-attachment-icon.is-spinning")).not.toBeNull();
    stop.click();
    await idle(composer);

    expect(signals[0].aborted).toBe(true);
    expect(stop.hidden).toBe(true);
    expect(query<HTMLElement>(".systemsculpt-agent-composer-errors")!.textContent)
      .toContain("slow.pdf could not be processed: processing was stopped. Retry to process it.");
    expect(query<HTMLElement>(".systemsculpt-agent-attachment.is-failed")?.textContent).toContain("slow.pdf");

    query('[data-testid="chat.composer.attachment.retry"]')!.click();
    for (let turn = 0; signals.length === 1 && turn < 100; turn++) await Promise.resolve();
    expect(query<HTMLElement>(".systemsculpt-agent-attachment.is-processing")).not.toBeNull();
    composer.unload();
    expect(signals[1].aborted).toBe(true);
    await idle(composer);
  });

  it.each(["resolve", "reject"] as const)("Remove during Retry keeps the PDF removed after a late %s", async (outcome) => {
    let finish!: () => void;
    let signal!: AbortSignal;
    const { composer, parent, query } = mount({
      documentAttachmentProcessor: {
        prepare: jest.fn().mockRejectedValueOnce(new Error("First failure"))
          .mockImplementationOnce((_input, options) => {
            signal = options.signal;
            return new Promise((resolve, reject) => {
              finish = () => outcome === "resolve"
                ? resolve({ operationId: "late", markdown: "Late result" })
                : reject(new Error("Late failure"));
            });
          }),
        complete: jest.fn(async () => undefined),
        discard: jest.fn(async () => undefined),
      },
    });
    const picker = parent.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(picker, "files", { configurable: true, value: [byteFile("remove.pdf", "application/pdf", "%PDF")] });
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await idle(composer);
    query('[data-testid="chat.composer.attachment.retry"]')!.click();
    await Promise.resolve();
    query('[data-testid="chat.composer.attachment.remove"]')!.click();
    const abortedOnRemove = signal.aborted;
    finish();
    await idle(composer);
    expect(abortedOnRemove).toBe(true);
    expect(parent.querySelectorAll(".systemsculpt-agent-attachment.is-message")).toHaveLength(0);
    expect(query('[data-testid="chat.composer.attachment.cancel"]')!.hidden).toBe(true);
    expect(query<HTMLElement>(".systemsculpt-agent-composer-errors")!.hidden).toBe(true);
    composer.setValue("Send without the removed PDF");
    expect(query('[aria-label="Send message"]')!.disabled).toBe(false);
    composer.unload();
  });

  it("shows the drop overlay over the whole chat and adds dropped OS files as chips", async () => {
    const { composer, parent, viewport } = mount();
    const overlay = parent.querySelector<HTMLElement>('[data-testid="chat.composer.drop-overlay"]')!;
    const transfer = { types: ["Files"], files: [byteFile("dropped.md", "text/markdown", "# Dropped")], items: [], getData: () => "" };
    const enter = new Event("dragenter", { bubbles: true, cancelable: true });
    Object.defineProperty(enter, "dataTransfer", { value: transfer });
    viewport.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(overlay.hidden).toBe(false);
    expect(overlay.textContent).toContain("Drop to add to your message");

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: transfer });
    viewport.dispatchEvent(drop);
    expect(overlay.hidden).toBe(true);
    await idle(composer);
    expect(composer.getMessageAttachments()).toEqual([expect.objectContaining({ name: "dropped.md" })]);

    const leaveEnter = new Event("dragenter", { bubbles: true, cancelable: true });
    Object.defineProperty(leaveEnter, "dataTransfer", { value: transfer });
    viewport.dispatchEvent(leaveEnter);
    viewport.dispatchEvent(new Event("dragleave", { bubbles: true }));
    expect(overlay.hidden).toBe(true);
    composer.unload();
    expect(overlay.isConnected).toBe(false);
  });

  it("adds notes dragged from Obsidian's file explorer as message chips", async () => {
    const plan = new TFile({ path: "Projects/Plan.md" });
    const { app } = vaultApp([plan]);
    (app as any).dragManager = { draggable: { type: "file", file: plan } };
    const { composer, viewport } = mount({ app });
    const transfer = { types: ["text/plain"], files: [], items: [], getData: () => "" };
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(over, "dataTransfer", { value: transfer });
    viewport.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: transfer });
    viewport.dispatchEvent(drop);
    await idle(composer);
    expect(drop.defaultPrevented).toBe(true);
    expect(composer.getMessageAttachments()).toEqual([expect.objectContaining({ name: "Projects/Plan.md" })]);
    composer.unload();
  });

  it("turns a Similar Notes drag payload into a pinned file instead of a message attachment", () => {
    const onVaultContextDrop = jest.fn();
    const { composer } = mount({ onVaultContextDrop });
    const transfer = {
      types: ["application/x-systemsculpt-similar-note"],
      files: [],
      items: [],
      getData: jest.fn(() => JSON.stringify({ path: "Research/Project.md", title: "Project", source: "similar-notes" })),
    };
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: transfer });

    composer.element.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(true);
    expect(onVaultContextDrop).toHaveBeenCalledWith("Research/Project.md");
    expect(composer.getMessageAttachments()).toEqual([]);
    composer.unload();
  });

  it("does not enable send for pinned files without prompt text or message attachments", () => {
    const { composer, query } = mount();
    composer.setAttachments([{ id: "context", label: "Project.md", path: "Project.md", kind: "vault" }]);
    expect(query('[aria-label="Send message"]')?.disabled).toBe(true);
    composer.unload();
  });

  it("offers Auto, Ask and Full access modes in the composer", () => {
    const onApprovalModeChange = jest.fn();
    const { composer, parent } = mount({ onApprovalModeChange });
    const select = parent.querySelector<HTMLSelectElement>('[aria-label="Vault changes"]')!;
    expect(Array.from(select.options).map((option) => option.text)).toEqual(["Auto", "Ask", "Full access"]);
    composer.setApprovalMode("full-access");
    expect(select.value).toBe("full-access");
    select.value = "ask";
    select.dispatchEvent(new Event("change"));
    expect(onApprovalModeChange).toHaveBeenCalledWith("ask");
    composer.unload();
  });

  it("announces a queued follow-up through the view's live region", async () => {
    const announce = jest.fn();
    const { composer, input } = mount({ announce });
    composer.setRunning(true);
    composer.setValue("After that, tidy the links");
    key(input, { key: "Enter" });
    await idle(composer);
    expect(announce).toHaveBeenCalledWith("Message queued.");
    composer.unload();
  });
});
