import { RecorderModule } from "../RecorderModule";

export async function stopRecording(plugin: RecorderModule): Promise<void> {
  if (plugin.recordingStatusBarItem) {
    plugin.recordingStatusBarItem.hide();
  }

  if (plugin.recordingNotice) {
    const arrayBuffer = await plugin.recordingNotice
      .stopRecording()
      .catch((error) => {
        plugin.handleError(error, "Error stopping recording");
      });
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
  }
}
