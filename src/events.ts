import { Plugin, TAbstractFile, TFile } from 'obsidian';
import { RecorderModule } from './modules/recorder/RecorderModule';

export function registerMp3ContextMenu(
  plugin: Plugin,
  recorderModule: RecorderModule
) {
  plugin.registerEvent(
    plugin.app.workspace.on('file-menu', (menu, file: TAbstractFile) => {
      if (
        file instanceof TFile &&
        (file.extension === 'mp3' || file.extension === 'mp4')
      ) {
        menu.addItem(item => {
          item
            .setTitle('SystemSculpt - Transcribe')
            .setIcon('microphone')
            .onClick(async () => {
              await recorderModule.transcribeSelectedFile(file);
            });
        });
      }
    })
  );
}
