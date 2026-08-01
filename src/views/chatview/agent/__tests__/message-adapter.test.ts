import {
  createTextAttachmentPart,
  parseAttachedTextContent,
} from "../../attachments/ChatAttachmentContent";
import type { ChatMessage } from "../../../../types";
import { toThinAgentUserMessage } from "../MessageAdapter";

function decodeDataUrl(url: string): string {
  const encoded = url.slice(url.indexOf(",") + 1);
  const bytes = Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

describe("thin-agent message adapter", () => {
  it("maps text files and images while rejecting empty or malformed input", () => {
    expect(() => toThinAgentUserMessage({
      role: "assistant",
      message_id: "assistant-invalid",
      content: "No",
    })).toThrow("Only a newly admitted user message can start a response.");

    expect(() => toThinAgentUserMessage({
      role: "user",
      message_id: "user-empty",
      content: "",
    })).toThrow("A message needs text or an attachment.");

    const attachedText = createTextAttachmentPart(
      "notes.txt",
      "text/plain",
      new TextEncoder().encode("Attached notes"),
    );
    const multipart: ChatMessage = {
      role: "user",
      message_id: "user-multipart",
      content: [
        { type: "text", text: "Prompt" },
        attachedText,
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AA==" },
        },
      ],
      attachmentMetadata: [{
        id: "text-attachment",
        name: "notes.txt",
        mimeType: "text/plain",
        byteLength: 14,
        kind: "text",
        contentPartIndex: 1,
      }, {
        id: "image-attachment",
        name: "image.png",
        mimeType: "image/png",
        byteLength: 1,
        kind: "image",
        contentPartIndex: 2,
      }],
    };

    expect(toThinAgentUserMessage(multipart).parts).toEqual([
      { type: "text", text: "Prompt" },
      expect.objectContaining({
        type: "file",
        filename: "notes.txt",
        mediaType: "text/plain",
      }),
      {
        type: "file",
        filename: "image.png",
        mediaType: "image/png",
        url: "data:image/png;base64,AA==",
      },
    ]);

    expect(() => toThinAgentUserMessage({
      role: "user",
      message_id: "user-malformed-image",
      content: [{
        type: "image_url",
        image_url: { url: "not-a-data-url" },
      }],
    })).toThrow("An attached image is malformed.");
  });

  it("sends extracted PDF markdown as one truthful, replay-stable file part", () => {
    const canary = "# PDF canary\n\nRésumé total: 42";
    const message: ChatMessage = {
      role: "user",
      message_id: "user-pdf",
      content: [
        { type: "text", text: "Read the attached report." },
        createTextAttachmentPart(
          "report.pdf",
          "text/markdown",
          new TextEncoder().encode(canary),
        ),
      ],
      attachmentMetadata: [{
        id: `document-${"a".repeat(64)}`,
        name: "report.pdf",
        mimeType: "application/pdf",
        byteLength: 1_024,
        kind: "document",
        contentPartIndex: 1,
      }],
    };

    const wireMessage = toThinAgentUserMessage(message);
    const file = wireMessage.parts.find((part) => part.type === "file");
    expect(file).toMatchObject({
      type: "file",
      filename: "report.pdf.extracted.md",
      mediaType: "text/markdown",
      url: expect.stringMatching(/^data:text\/markdown;base64,/),
    });
    if (!file || file.type !== "file") throw new Error("Expected the PDF file part.");

    expect(parseAttachedTextContent(decodeDataUrl(file.url))).toMatchObject({
      name: "report.pdf",
      mimeType: "text/markdown",
      body: canary,
      unavailable: false,
    });
    expect(JSON.parse(JSON.stringify(wireMessage))).toEqual(wireMessage);
  });
});
