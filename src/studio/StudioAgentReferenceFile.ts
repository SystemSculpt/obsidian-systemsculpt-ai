import { App, normalizePath } from "obsidian";
import {
  STUDIO_AGENT_DOCS_PATH,
  renderStudioAgentReferenceMarkdown,
} from "./StudioProjectAgentContract";

/**
 * Publishes the generated agent documentation for .systemsculpt files to the
 * vault. Project files carry only a pointer to this document, so it must
 * exist and match the running plugin's node registry; content is fully
 * derived, so a byte comparison decides whether a rewrite is needed. Best
 * effort by design: a vault that cannot be written must never block opening
 * or creating a project.
 */
export class StudioAgentReferenceFile {
  private ensured = false;

  constructor(private readonly app: App) {}

  async ensureCurrent(): Promise<void> {
    if (this.ensured) {
      return;
    }
    this.ensured = true;
    try {
      const path = normalizePath(STUDIO_AGENT_DOCS_PATH);
      const adapter = this.app.vault.adapter;
      const content = renderStudioAgentReferenceMarkdown();
      if ((await adapter.exists(path)) && (await adapter.read(path)) === content) {
        return;
      }
      const segments = path.split("/").slice(0, -1);
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const dir = segments.slice(0, depth).join("/");
        if (!(await adapter.exists(dir))) {
          await adapter.mkdir(dir);
        }
      }
      await adapter.write(path, content);
    } catch (error) {
      this.ensured = false;
      console.warn("[SystemSculpt Studio] Could not refresh the agent reference document", error);
    }
  }
}
