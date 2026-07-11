import * as fs from "fs";
import * as path from "path";

describe("ChatView accepted user API", () => {
  it("preserves the void compatibility wrapper and exposes authoritative commit results", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../ChatView.ts"), "utf8");
    expect(source).toContain("persistSubmittedUserMessage(message: ChatMessage): Promise<void>");
    expect(source).toContain("commitAcceptedUserMessage(input: AcceptedUserCommitInput): Promise<AcceptedUserCommitResult>");
    expect(source).toContain("const accepted = await transcript.commitAcceptedUser(input)");
    expect(source).toContain("return accepted;");
  });
});
