import * as fs from "fs";
import * as path from "path";

describe("managed chat ownership structure", () => {
  it("requires admission before accepted commit and lifecycle construction", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../InputHandler.ts"), "utf8");
    const candidate = source.indexOf("const candidateMessageId = this.generateMessageId()");
    const admission = source.indexOf("this.managedChatAdmission.acquireChatTurnLease()");
    const commit = source.indexOf("this.commitAcceptedUserMessage(commitInput)");
    const lifecycle = source.indexOf("new ChatTurnLifecycleController", commit);
    expect(candidate).toBeGreaterThan(-1);
    expect(candidate).toBeLessThan(admission);
    expect(admission).toBeLessThan(commit);
    expect(commit).toBeLessThan(lifecycle);
    expect(source).not.toContain("NODE_ENV");
    expect(source).not.toContain("commitUser:");
  });
});
