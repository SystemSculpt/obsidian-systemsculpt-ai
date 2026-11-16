/** @jest-environment jsdom */
import { App, TFile } from "obsidian";
import type { AgentToolPart } from "../../../chat/ChatConversation";
import { AgentConversationRenderer } from "../AgentConversationRenderer";

const claude = { agent: "claude" as const, workingDirectory: "/vault", vaultRoot: "/vault" };

function setup(existing: readonly string[]) {
  const app = new App();
  (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation(
    (path: string) => existing.includes(path) ? new TFile({ path }) : null,
  );
  const onOpenArtifact = jest.fn();
  const host = document.body.createDiv();
  const renderer = new AgentConversationRenderer(host, {
    app, sourcePath: () => "", onApprove: jest.fn(), onOpenArtifact, onCopyArtifactPath: jest.fn(),
  });
  let order = 0;
  const label = async (part: Partial<AgentToolPart>): Promise<HTMLElement> => {
    const node = host.createDiv();
    order += 1;
    await (renderer as unknown as { tools: { render(node: HTMLElement, part: AgentToolPart): Promise<void> } }).tools.render(node, {
      id: `tool-${order}`, order, kind: "tool", messageId: "m", callId: `call-${order}`,
      location: "vault", state: "succeeded", ...part,
    } as AgentToolPart);
    return node.querySelector<HTMLElement>(".systemsculpt-agent-tool-label")!;
  };
  return { label, onOpenArtifact };
}

describe("a tool row's label", () => {
  it("links a note that exists, and opens it", async () => {
    const { label, onOpenArtifact } = setup(["Notes/Garden.md"]);
    const row = await label({
      name: "read", input: { paths: ["Notes/Garden.md"] },
      output: { data: { files: [{ path: "Notes/Garden.md", content: "# Garden" }] } },
    });
    expect(row.textContent).toBe("Read Garden");
    const link = row.querySelector<HTMLAnchorElement>('a[data-testid="chat.tool.open-path"]')!;
    expect(link.textContent).toBe("Garden");
    expect(link.className).toBe("ss-tool-target is-whole");
    link.click();
    expect(onOpenArtifact).toHaveBeenCalledWith(expect.objectContaining({ path: "Notes/Garden.md" }));
  });

  it("never links a note that doesn't exist, so a click can't create it", async () => {
    const { label } = setup([]);
    const missing = await label({
      name: "read", state: "failed", input: { paths: ["Notes/Missing.md"] },
      output: { data: { files: [{ path: "Notes/Missing.md", error: "File not found" }] } },
      error: { code: "TOOL_EXECUTION_FAILED", message: "File not found: Notes/Missing.md" },
    });
    expect(missing.textContent).toBe("Couldn't read Missing");
    expect(missing.querySelector("a")).toBeNull();
    expect(missing.querySelector("span.ss-tool-target")?.textContent).toBe("Missing");

    const denied = await label({
      name: "write", state: "denied", input: { path: "Notes/Secret.md", content: "x" },
      approvalId: "a1", approvalDecision: "denied", error: { code: "USER_DENIED", message: "denied" },
    });
    expect(denied.textContent).toBe("Create Secret · Denied");
    expect(denied.querySelector("a")).toBeNull();
    expect(denied.querySelector("span.ss-tool-target")?.textContent).toBe("Secret");
  });

  it("sets a command in code type, keeping a short one whole", async () => {
    const { label } = setup([]);
    const short = await label({
      name: "Bash", location: "server", native: claude, input: { command: "git status --short" }, output: { data: "" },
    });
    expect(short.textContent).toBe("Ran git status --short");
    expect(short.querySelector(".ss-tool-target")?.className).toBe("ss-tool-target is-command is-whole");

    const long = await label({
      name: "Bash", location: "server", native: claude,
      input: { command: "npm run build -- --filter=@systemsculpt/plugin --verbose" }, output: { data: "" },
    });
    // A long one may wrap where it must.
    expect(long.querySelector(".ss-tool-target")?.className).toBe("ss-tool-target is-command");
  });
});
