import { localAgentPromptText } from "../LocalAgentMessageParts";
import { bytesToBase64 } from "../../../utils/base64";

function dataUrl(mediaType: string, text: string): string {
  return `data:${mediaType};base64,${bytesToBase64(new TextEncoder().encode(text))}`;
}

describe("localAgentPromptText", () => {
  it("writes attached notes into the prompt under their vault path and keeps images beside it", () => {
    const images: string[] = [];
    const parts = [
      { type: "text" as const, text: "Tighten [[Plan]]" },
      { type: "file" as const, mediaType: "text/markdown", filename: "Projects/Plan.md", url: dataUrl("text/markdown", "# Plan\n- Beta") },
      { type: "file" as const, mediaType: "image/png", filename: "shot.png", url: "data:image/png;base64,AAAA" },
    ];
    const prompt = parts.map((part) => localAgentPromptText(part, images, "Claude Code")).join("\n");
    expect(prompt).toContain("Tighten [[Plan]]");
    expect(prompt).toContain("--- BEGIN ATTACHED FILE: Projects/Plan.md (text/markdown) ---\n# Plan\n- Beta\n--- END ATTACHED FILE: Projects/Plan.md ---");
    expect(images).toEqual(["data:image/png;base64,AAAA"]);
  });

  it("still refuses binary files it cannot read as text", () => {
    expect(() => localAgentPromptText(
      { type: "file", mediaType: "application/pdf", url: "data:application/pdf;base64,JVBERg==" },
      [],
      "Codex",
    )).toThrow("This attachment must be converted to text or an image before sending it to Codex.");
    expect(() => localAgentPromptText(
      { type: "file", mediaType: "text/plain", url: "https://example.com/notes.txt" },
      [],
      "Codex",
    )).toThrow("converted to text");
  });
});
