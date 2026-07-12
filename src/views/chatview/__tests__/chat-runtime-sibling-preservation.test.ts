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
  it("keeps standard Chat unconditional on the managed adapter while Pi retains its session stream path", () => {
    const input = read("src/views/chatview/InputHandler.ts");
    const router = methodSlice(input, "private async streamAssistantTurn", "private async streamManagedAssistantTurn");
    const managed = methodSlice(input, "private async streamManagedAssistantTurn", "private async streamPiAssistantTurn");
    const pi = methodSlice(input, "private async streamPiAssistantTurn", "private getHostedContinuationTarget");

    expect(router).toContain('options?.runtime === "pi"');
    expect(router).toContain("this.streamManagedAssistantTurn");
    expect(managed).toContain("getCurrentRuntimeAdapter()");
    expect(managed).not.toContain("streamMessage(");
    expect(managed).not.toContain("getMessages()");
    expect(managed).not.toContain("composeAcceptedLegacyContinuation");
    expect(managed).not.toMatch(/fallback|NODE_ENV|acquireLease|withLease/);
    expect(pi).toContain("this.aiService.streamMessage(");
    expect(pi).toContain("getPiSessionFile");
    expect(pi).toContain("getPiSessionId");
    expect(pi).toContain("onPiSessionReady");
    expect(pi).not.toContain("getCurrentRuntimeAdapter");
  });

  it("keeps the shared streamMessage interface and every non-Chat production consumer", () => {
    const service = read("src/services/SystemSculptService.ts");
    expect(service).toMatch(/async \*streamMessage\(options:/);

    const expectedConsumers = [
      "src/modals/MeetingProcessorModal.ts",
      "src/modals/StandardAIResponseModal.ts",
      "src/modals/YouTubeCanvasModal.ts",
      "src/services/PostProcessingService.ts",
      "src/services/TitleGenerationService.ts",
      "src/services/transcription/TranscriptionTitleService.ts",
      "src/services/workflow/WorkflowEngineService.ts",
      "src/studio/StudioApiExecutionAdapter.ts",
    ] as const;
    for (const relative of expectedConsumers) expect(read(relative)).toContain(".streamMessage(");
  });

  it("keeps one legacy stream call isolated inside the Pi method and one managed selection seam", () => {
    const input = read("src/views/chatview/InputHandler.ts");
    expect(input.match(/this\.aiService\.streamMessage\(/g)).toHaveLength(1);
    expect(input.match(/getCurrentRuntimeAdapter\(\)/g)).toHaveLength(2);
    const view = read("src/views/chatview/ChatView.ts");
    expect(view).toContain("new CurrentRuntimeAdapter(");
    expect(view).toContain("new ManagedChatRuntimeAdapter(this.plugin.getManagedCapabilityClient())");
  });
});
