import { RecorderModule } from "../RecorderModule";
import { showCustomNotice } from "../../../modals";

export async function stopRecording(plugin: RecorderModule): Promise<void> {
  if (plugin.recordingStatusBarItem) {
    plugin.recordingStatusBarItem.hide();
  }

  if (plugin.recordingNotice) {
    try {
      const arrayBuffer = await plugin.recordingNotice.stopRecording();
      plugin.recordingNotice.hide();
      plugin.recordingNotice = null;

      if (arrayBuffer) {
        const { file: recordingFile, isTemporary } =
          await plugin.saveRecording(arrayBuffer);
        if (recordingFile && plugin.settings.autoTranscriptionEnabled) {
          await plugin.handleTranscription(arrayBuffer, recordingFile);
        }
        if (isTemporary) {
          await plugin.plugin.app.vault.delete(recordingFile);
        }
      }
    } catch (error) {
      console.error("Error stopping recording:", error);
      showCustomNotice("Error stopping recording. Forcing stop...");
      plugin.forceStopRecording();
    }
  } else {
    showCustomNotice("No active recording to stop.");
  }
}
