import { presentChatMessage, presentMessageContent } from "../ChatMessagePresentation";

describe("presentMessageContent", () => {
  it("keeps mixed images and text while preserving their order-independent labels", () => {
    const presented = presentMessageContent([
      { type: "text", text: "Compare these references." },
      { type: "image_url", image_url: { url: "data:image/png;base64,one" } },
      { type: "image_url", image_url: { url: "data:image/webp;base64,two" } },
    ]);
    expect(presented).toEqual({
      markdown: "Compare these references.",
      attachments: [
        { kind: "image", label: "Attached image 1", url: "data:image/png;base64,one" },
        { kind: "image", label: "Attached image 2", url: "data:image/webp;base64,two" },
      ],
    });
  });

  it("presents attached text files as compact files without echoing their payload", () => {
    const presented = presentMessageContent([{ type: "text", text: [
      "--- BEGIN ATTACHED FILE: data.csv (text/csv) ---",
      "secret,large,payload",
      "--- END ATTACHED FILE: data.csv ---",
    ].join("\n") }]);
    expect(presented.markdown).toBe("");
    expect(presented.attachments).toEqual([{ kind: "file", label: "data.csv", mimeType: "text/csv" }]);
  });

  it("marks unavailable hydrated attachments explicitly", () => {
    const presented = presentMessageContent([{ type: "text", text: [
      "--- BEGIN ATTACHED FILE: diagram.png (image/png) ---",
      "[[SYSTEMSCULPT_ATTACHMENT_UNAVAILABLE]]",
      "--- END ATTACHED FILE: diagram.png ---",
    ].join("\n") }]);
    expect(presented).toEqual({
      markdown: "",
      attachments: [{ kind: "file", label: "diagram.png", mimeType: "image/png", unavailable: true }],
    });
  });
});

describe("presentChatMessage", () => {
  it("renders compact attachment metadata without loading a CAS payload", () => {
    const presented = presentChatMessage({
      role: "user",
      message_id: "user-1",
      content: "Compare this",
      attachmentMetadata: [{
        id: "image-1",
        name: "diagram.png",
        mimeType: "image/png",
        byteLength: 3,
        kind: "image",
        contentPartIndex: 1,
        contentRef: {
          schema: "systemsculpt-chat-attachment-v1",
          payload: "image-bytes",
          sha256: "a".repeat(64),
          byteLength: 3,
        },
      }],
    });

    expect(presented).toEqual({
      markdown: "Compare this",
      attachments: [{
        kind: "image",
        label: "diagram.png",
        mimeType: "image/png",
      }],
    });
  });

  it("uses a hydrated image preview without duplicating its metadata chip", () => {
    const presented = presentChatMessage({
      role: "user",
      message_id: "user-1",
      content: [
        { type: "text", text: "Compare this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
      ],
      attachmentMetadata: [{
        id: "image-1",
        name: "diagram.png",
        mimeType: "image/png",
        byteLength: 3,
        kind: "image",
        contentPartIndex: 1,
      }],
    });

    expect(presented.attachments).toEqual([{
      kind: "image",
      label: "diagram.png",
      mimeType: "image/png",
      url: "data:image/png;base64,AQID",
    }]);
  });

  it("renders a lazy queue image as a compact chip without a fake preview", () => {
    const presented = presentChatMessage({
      role: "user",
      message_id: "user-1",
      content: [{
        type: "image_url",
        image_url: {
          url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XyG7WQAAAABJRU5ErkJggg==",
        },
      }],
      attachmentMetadata: [{
        id: "image-1",
        name: "diagram.png",
        mimeType: "image/png",
        byteLength: 3,
        kind: "image",
        contentPartIndex: 0,
        contentRef: {
          schema: "systemsculpt-chat-attachment-v1",
          payload: "image-bytes",
          sha256: "a".repeat(64),
          byteLength: 3,
        },
      }],
    });

    expect(presented.attachments).toEqual([{
      kind: "image",
      label: "diagram.png",
      mimeType: "image/png",
    }]);
  });
});
