
import { App, Setting, Notice, DropdownComponent, Platform } from "obsidian";
import SystemSculptPlugin from "../main";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { MobileDetection } from "../utils/MobileDetection";
import { AI_PROVIDERS, LOCAL_SERVICES } from '../constants/externalServices';
import { openVideoRecordingPermissionModal } from "../modals/VideoRecordingPermissionModal";

export async function displayRecorderTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  containerEl.empty();
  if (containerEl.classList.contains('systemsculpt-tab-content')) {
    containerEl.dataset.tab = "recorder";
  }
  const { app, plugin } = tabInstance;
  const mobileDetection = MobileDetection.getInstance();
  const isMobile = mobileDetection.isMobileDevice();

  containerEl.createEl('h3', { text: 'Recording' });

  await renderMicrophoneSetting(containerEl, tabInstance);

  if (Platform.isDesktopApp) {
    new Setting(containerEl)
      .setName('Show video record button in chat')
      .setDesc('Adds a quick toggle to record Obsidian window workflows (requires Pro).')
      .addToggle((toggle) => {
        toggle
          .setValue(plugin.settings.showVideoRecordButtonInChat ?? true)
          .onChange(async (value) => {
            await plugin.getSettingsManager().updateSettings({ showVideoRecordButtonInChat: value });
          });
      });

    new Setting(containerEl)
      .setName('Include system audio in video recordings')
      .setDesc('Capture desktop/system audio when the recording runtime supports it.')
      .addToggle((toggle) => {
        toggle
          .setValue(plugin.settings.videoCaptureSystemAudio ?? false)
          .onChange(async (value) => {
            await plugin.getSettingsManager().updateSettings({ videoCaptureSystemAudio: value });
          });
      });

    new Setting(containerEl)
      .setName('Include microphone audio in video recordings')
      .setDesc('Capture microphone/input audio in video recordings (uses your preferred microphone setting).')
      .addToggle((toggle) => {
        toggle
          .setValue(plugin.settings.videoCaptureMicrophoneAudio ?? false)
          .onChange(async (value) => {
            await plugin.getSettingsManager().updateSettings({ videoCaptureMicrophoneAudio: value });
          });
      });

    containerEl.createEl("p", {
      text: "Tip: Enable both toggles to capture system audio + microphone together when supported by your Obsidian/Electron runtime.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName('Show video permission reminder')
      .setDesc('Show a pre-recording popup explaining Screen & System Audio Recording access and direct-capture requests.')
      .addToggle((toggle) => {
        toggle
          .setValue(plugin.settings.showVideoRecordingPermissionPopup !== false)
          .onChange(async (value) => {
            await plugin.getSettingsManager().updateSettings({ showVideoRecordingPermissionPopup: value });
          });
      })
      .addButton((button) => {
        button
          .setButtonText('Preview popup')
          .onClick(async () => {
            const result = await openVideoRecordingPermissionModal(app);
            if (result.dontShowAgain) {
              await plugin.getSettingsManager().updateSettings({ showVideoRecordingPermissionPopup: false });
              new Notice('Video permission reminder disabled.');
              tabInstance.display();
              return;
            }
            if (!result.confirmed) {
              new Notice('Permission popup closed.');
            }
          });
      });
  }

  new Setting(containerEl)
    .setName('Auto-transcribe recordings')
    .setDesc('Transcribe recordings automatically when they finish.')
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.autoTranscribeRecordings)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ autoTranscribeRecordings: value });
        });
    });

  new Setting(containerEl)
    .setName('Auto-paste transcription')
    .setDesc('Paste the transcription into the active document when it completes.')
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.autoPasteTranscription)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ autoPasteTranscription: value });
        });
    });

  new Setting(containerEl)
    .setName('Keep recordings after transcription')
    .setDesc('Retain the source audio file after a successful transcription.')
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.keepRecordingsAfterTranscription)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ keepRecordingsAfterTranscription: value });
        });
    });

  new Setting(containerEl)
    .setName('Clean output only')
    .setDesc('Strip timestamps and metadata from transcription output.')
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.cleanTranscriptionOutput)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ cleanTranscriptionOutput: value });
        });
    });

  new Setting(containerEl)
    .setName('Auto-submit after transcription')
    .setDesc('Send the message automatically once transcription or post-processing finishes in chat views.')
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.autoSubmitAfterTranscription)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ autoSubmitAfterTranscription: value });
        });
    });

  new Setting(containerEl)
    .setName('Enable post-processing')
    .setDesc('Apply your post-processing prompt after transcription completes.')
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.postProcessingEnabled)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ postProcessingEnabled: value });
        });
    });

  containerEl.createEl('h3', { text: 'Transcription' });

  const providerSetting = new Setting(containerEl)
    .setName('Transcription provider')
    .setDesc('Choose the service used to transcribe recordings.');

  providerSetting.addDropdown((dropdown) => {
    dropdown
      .addOption('systemsculpt', 'SystemSculpt API')
      .addOption('custom', 'Custom')
      .setValue(plugin.settings.transcriptionProvider)
      .onChange(async (value: 'systemsculpt' | 'custom') => {
        if (plugin.settings.settingsMode !== 'advanced' && value === 'custom') {
          new Notice('Switch to Advanced mode to configure custom transcription providers.');
          dropdown.setValue('systemsculpt');
          return;
        }
        await plugin.getSettingsManager().updateSettings({ transcriptionProvider: value });
        tabInstance.display();
      });
  });

  if (!isMobile && plugin.settings.settingsMode === 'advanced') {
    new Setting(containerEl)
      .setName('Automatic audio format conversion')
      .setDesc('Convert incompatible audio files before transcription.')
      .addToggle((toggle) => {
        toggle
          .setValue(plugin.settings.enableAutoAudioResampling ?? true)
          .onChange(async (value) => {
            await plugin.getSettingsManager().updateSettings({ enableAutoAudioResampling: value });
            new Notice(value ? 'Audio conversion enabled' : 'Audio conversion disabled');
          });
      });
  }

  const isAdvancedMode = plugin.settings.settingsMode === 'advanced';
  const usingCustomProvider = plugin.settings.transcriptionProvider === 'custom' && isAdvancedMode;

  if (usingCustomProvider) {
    renderCustomTranscriptionSettings(containerEl, tabInstance);
  }
}

async function renderMicrophoneSetting(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  const { plugin } = tabInstance;

  const setting = new Setting(containerEl)
    .setName('Preferred microphone')
    .setDesc('Select which microphone to use for recordings.');

  let dropdownComponent: DropdownComponent | null = null;
  let dropdownEl: HTMLSelectElement | null = null;
  setting.addDropdown((dropdown) => {
    dropdownComponent = dropdown;
    dropdownEl = dropdown.selectEl;
    dropdown.addOption('default', 'Default microphone');
    dropdown.setValue(plugin.settings.preferredMicrophoneId || 'default');

    dropdown.onChange(async (value) => {
      await plugin.getSettingsManager().updateSettings({ preferredMicrophoneId: value });
      const label = dropdown.selectEl?.selectedOptions[0]?.text || value;
      new Notice(`Microphone preference saved: ${label}`);
    });
  });

  const statusEl = setting.descEl.createDiv({ cls: 'ss-inline-note' });

  const loadDevices = async () => {
    if (!dropdownComponent || !dropdownEl) return;
    dropdownEl.innerHTML = '';
    const dropdown = dropdownComponent;
    const addOption = (value: string, label: string) => {
      dropdown.addOption(value, label);
    };

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      addOption('default', 'Default microphone');
      dropdown.setValue(plugin.settings.preferredMicrophoneId || 'default');
      statusEl.setText('Microphone selection unavailable in this environment.');
      return;
    }

    try {
      statusEl.setText('Loading microphones...');
      const devices = await navigator.mediaDevices.enumerateDevices();
      const labeled = devices.some((device) => device.kind === 'audioinput' && device.label);
      if (!labeled) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((track) => track.stop());
        } catch (error: any) {
          statusEl.setText('Microphone access denied; using default device list.');
        }
      }

      const refreshed = await navigator.mediaDevices.enumerateDevices();
      const microphones = refreshed.filter((device) => device.kind === 'audioinput');

      addOption('default', 'Default microphone');
      microphones.forEach((mic) => {
        addOption(mic.deviceId, mic.label || `Microphone ${mic.deviceId.slice(0, 8)}`);
      });

      const current = plugin.settings.preferredMicrophoneId || 'default';
      dropdown.setValue(current);
      statusEl.setText(microphones.length ? '' : 'No microphones detected.');
    } catch (error: any) {
      statusEl.setText(`Unable to load microphones: ${error?.message || error}`);
      addOption('default', 'Default microphone');
      dropdown.setValue('default');
    }
  };

  setting.addExtraButton((button) => {
    button
      .setIcon('refresh-cw')
      .setTooltip('Refresh microphones')
      .onClick(() => {
        loadDevices();
      });
  });
  await loadDevices();
}

function renderCustomTranscriptionSettings(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  const { plugin } = tabInstance;

  new Setting(containerEl)
    .setName('Custom endpoint URL')
    .setDesc('OpenAI-compatible transcription endpoint.')
    .addText((text) => {
      text
        .setPlaceholder('https://api.example.com/v1/audio/transcriptions')
        .setValue(plugin.settings.customTranscriptionEndpoint)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ customTranscriptionEndpoint: value });
        });
    });

  new Setting(containerEl)
    .setName('API key')
    .setDesc('Only required if your endpoint needs authentication.')
    .addText((text) => {
      text
        .setPlaceholder('sk-...')
        .setValue(plugin.settings.customTranscriptionApiKey)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ customTranscriptionApiKey: value });
        });
      text.inputEl.type = 'password';
    });

  new Setting(containerEl)
    .setName('Model name')
    .setDesc('Identifier sent to your transcription endpoint.')
    .addText((text) => {
      text
        .setPlaceholder('whisper-large-v3')
        .setValue(plugin.settings.customTranscriptionModel)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ customTranscriptionModel: value });
        });
    });

  const presetSetting = new Setting(containerEl)
    .setName('Presets')
    .setDesc('Quickly configure common services.');

  presetSetting.addButton((button) => {
    button
      .setButtonText('Groq')
      .onClick(async () => {
        await plugin.getSettingsManager().updateSettings({
          customTranscriptionEndpoint: AI_PROVIDERS.GROQ.AUDIO_TRANSCRIPTIONS,
          customTranscriptionModel: 'whisper-large-v3',
        });
        new Notice('Groq endpoint configured.');
        tabInstance.display();
      });
  });

  presetSetting.addButton((button) => {
    button
      .setButtonText('OpenAI')
      .onClick(async () => {
        await plugin.getSettingsManager().updateSettings({
          customTranscriptionEndpoint: AI_PROVIDERS.OPENAI.AUDIO_TRANSCRIPTIONS,
          customTranscriptionModel: 'whisper-1',
        });
        new Notice('OpenAI endpoint configured.');
        tabInstance.display();
      });
  });

  presetSetting.addButton((button) => {
    button
      .setButtonText('Local')
      .onClick(async () => {
        await plugin.getSettingsManager().updateSettings({
          customTranscriptionEndpoint: LOCAL_SERVICES.LOCAL_WHISPER.AUDIO_TRANSCRIPTIONS,
          customTranscriptionModel: 'whisper-large-v3',
        });
        new Notice('Local Whisper endpoint configured.');
        tabInstance.display();
      });
  });
}
