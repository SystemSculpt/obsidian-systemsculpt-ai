import type { ChatMessage } from "../../../types";
import { MANAGED_EMBEDDING_LIMITS } from "../ManagedEmbeddingsContract";
import {
  buildChatSemanticQuery,
  buildNoteSemanticQuery,
} from "../SemanticQuery";

function message(messageId: string, content: ChatMessage["content"], role: ChatMessage["role"] = "user"): ChatMessage {
  return { message_id: messageId, role, content };
}

describe("SemanticQuery", () => {
  it("deterministically bounds a long note to the managed 8,000-character contract", () => {
    const content = `NOTE-HEAD ${"a".repeat(10_000)} NOTE-TAIL`;

    const first = buildNoteSemanticQuery(content);
    const second = buildNoteSemanticQuery(content);

    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(MANAGED_EMBEDDING_LIMITS.maxCharsPerText);
    expect(first).toContain("NOTE-HEAD");
    expect(first).toContain("NOTE-TAIL");
    expect(first).toContain("…");
  });

  it("keeps all five selected turns represented when every turn exceeds the input budget", () => {
    const messages = Array.from({ length: 6 }, (_, index) => message(
      String(index + 1),
      `TURN-${index + 1} ${String(index + 1).repeat(4_000)} END-${index + 1}`,
      index % 2 === 0 ? "user" : "assistant",
    ));

    const query = buildChatSemanticQuery(messages);

    expect(query.length).toBeLessThanOrEqual(MANAGED_EMBEDDING_LIMITS.maxCharsPerText);
    expect(query).toContain("TURN-1");
    expect(query).toContain("TURN-2");
    expect(query).toContain("TURN-3");
    expect(query).not.toContain("TURN-4");
    expect(query).toContain("TURN-5");
    expect(query).toContain("TURN-6");
  });

  it("includes prompt, pasted text, and extracted document parts while skipping images", () => {
    const query = buildChatSemanticQuery([
      message("mixed", [
        { type: "text", text: "PROMPT: compare these sources" },
        {
          type: "text",
          text: `--- BEGIN ATTACHED FILE: notes.txt (text/plain) ---\nTEXT-FILE ${"t".repeat(9_000)}\n--- END ATTACHED FILE: notes.txt ---`,
        },
        { type: "image_url", image_url: { url: "data:image/png;base64,PRIVATE-IMAGE-DATA" } },
        {
          type: "text",
          text: `--- BEGIN ATTACHED FILE: report.pdf (application/pdf) ---\nPDF-CONTENT ${"p".repeat(9_000)}\n--- END ATTACHED FILE: report.pdf ---`,
        },
      ]),
    ]);

    expect(query.length).toBeLessThanOrEqual(MANAGED_EMBEDDING_LIMITS.maxCharsPerText);
    expect(query).toContain("PROMPT: compare these sources");
    expect(query).toContain("notes.txt");
    expect(query).toContain("TEXT-FILE");
    expect(query).toContain("report.pdf");
    expect(query).toContain("PDF-CONTENT");
    expect(query).not.toContain("PRIVATE-IMAGE-DATA");
  });
});
