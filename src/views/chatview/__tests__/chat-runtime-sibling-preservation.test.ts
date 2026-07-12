import * as fs from "fs";
import * as path from "path";

const root = path.resolve(__dirname, "../../../..");
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), "utf8");

function methodSlice(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Missing structural seam: ${start} -> ${end}`);
  return source.slice(startIndex, endIndex);
}

describe("standard Chat runtime sibling preservation", () => {
  it("keeps standard Chat unconditional on the managed adapter with no legacy stream path", () => {
    const input = read("src/views/chatview/InputHandler.ts");
    const router = methodSlice(input, "private async streamAssistantTurn", "private async streamManagedAssistantTurn");
    const managed = methodSlice(input, "private async streamManagedAssistantTurn", "private shouldContinueHostedToolLoop");

    expect(router).toContain("this.streamManagedAssistantTurn");
    expect(managed).toContain("getCurrentRuntimeAdapter()");
    expect(managed).not.toContain("streamMessage(");
    expect(managed).not.toContain("getMessages()");
    expect(managed).not.toContain("composeAcceptedLegacyContinuation");
    expect(managed).not.toMatch(/fallback|NODE_ENV|acquireLease|withLease/);
    expect(input).not.toContain("streamMessage(");
    expect(input).not.toMatch(/PiSession|getPiSession|runtime:\s*["']pi["']/);
  });

  it("keeps the shared streamMessage interface only for Studio", () => {
    const service = read("src/services/SystemSculptService.ts");
    expect(service).toMatch(/async \*streamMessage\(options:/);
    expect(read("src/studio/StudioApiExecutionAdapter.ts")).toContain(".streamMessage(");
  });

  it("keeps only the managed selection seam", () => {
    const input = read("src/views/chatview/InputHandler.ts");
    expect(input).not.toContain("this.aiService.streamMessage(");
    expect(input.match(/getCurrentRuntimeAdapter\(\)/g)).toHaveLength(2);
    const view = read("src/views/chatview/ChatView.ts");
    expect(view).toContain("new CurrentRuntimeAdapter(");
    expect(view).toContain("new ManagedChatRuntimeAdapter(this.plugin.getManagedCapabilityClient())");
  });
});
