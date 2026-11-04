import { resolveStudioNodeSurface } from "../StudioNodeSurface";

const resolve = (kind: string, context?: Partial<{ hasMedia: boolean; placeholder: boolean }>) =>
  resolveStudioNodeSurface({ kind }, { hasMedia: false, placeholder: false, ...context });

describe("resolveStudioNodeSurface", () => {
  it("makes media the card when it can be shown, and a source picker otherwise", () => {
    expect(resolve("studio.media_ingest", { hasMedia: true })).toEqual({ kind: "media", sourceToggle: false });
    expect(resolve("studio.media_ingest")).toEqual({ kind: "form", sourceToggle: false });
  });

  it("keeps text chromeless", () => {
    expect(resolve("studio.text")).toEqual({ kind: "text", sourceToggle: false });
  });

  it.each(["studio.script", "studio.json", "studio.value", "studio.process", "studio.cli_command", "studio.terminal"])("treats %s source as the content", kind => {
    expect(resolve(kind)).toEqual({ kind: "code", sourceToggle: false });
  });

  it.each(["studio.collection", "studio.run_collection", "studio.command_center", "studio.button", "studio.workflow"])("gives %s a panel with one Source toggle", kind => {
    expect(resolve(kind)).toEqual({ kind: "panel", sourceToggle: true });
  });

  it.each(["studio.image_generation", "studio.text_generation", "studio.codex", "studio.transcription", "studio.input", "studio.note", "studio.dataset", "studio.unknown"])("shows %s as a form without any source view", kind => {
    expect(resolve(kind)).toEqual({ kind: "form", sourceToggle: false });
  });

  it("renders managed placeholders through the form path regardless of kind", () => {
    expect(resolve("studio.media_ingest", { hasMedia: true, placeholder: true }).kind).toBe("form");
    expect(resolve("studio.text_output", { placeholder: true }).kind).toBe("form");
  });
});
