import { RecorderModule } from '../RecorderModule';

export async function getSelectedMicrophone(
  plugin: RecorderModule
): Promise<MediaDeviceInfo | undefined> {
  const microphones = await plugin.getMicrophones();
  const selectedMic = microphones.find(
    microphone =>
      microphone.deviceId === plugin.settings.selectedMicrophone || 'default'
  );
  if (!selectedMic) {
    plugin.settings.selectedMicrophone = 'default';
    await plugin.saveSettings();
  }
  return selectedMic;
}
