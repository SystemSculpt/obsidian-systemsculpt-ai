import { Notice, TFile } from "obsidian";
// import { AudioChunkingAnalyzer } from "../tests/RunAudioChunkingAnalysis";
import type SystemSculptPlugin from "../main";

/**
 * Run the audio chunking analysis and save the results to a file
 * @param plugin The SystemSculpt plugin instance
 */
export async function runAudioAnalysis(plugin: SystemSculptPlugin): Promise<void> {
  try {
    new Notice(`Running audio chunking analysis...`);

    // const analyzer = new AudioChunkingAnalyzer(plugin);
    // const report = await analyzer.runAnalysis();
    const report = "Audio chunking analysis functionality is disabled (test files not available)";

    // Save the report to a file in the vault
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = `AudioChunkingAnalysis-${timestamp}.md`;

    await plugin.app.vault.create(filePath, report);

    new Notice(`Analysis complete. Results saved to ${filePath}`);

    // Open the file
    const file = plugin.app.vault.getAbstractFileByPath(filePath);
    if (file && file instanceof TFile) {
      plugin.app.workspace.getLeaf().openFile(file);
    }
  } catch (error) {
    new Notice(`Error running analysis: ${error instanceof Error ? error.message : String(error)}`);
  }
}
