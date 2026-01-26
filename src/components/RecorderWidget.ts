import { Notice, ToggleComponent, setIcon } from "obsidian";
import type SystemSculptPlugin from "../main";
import type { SystemSculptSettings } from "../types";
const CHAT_VIEW_TYPE_ID = "systemsculpt-chat-view";

export interface RecorderWidgetHandles {
  root: HTMLElement;
  statusTextEl: HTMLElement;
  timerValueEl: HTMLElement;
  canvasEl: HTMLCanvasElement | null;
  liveBadgeEl: HTMLElement;
  dragHandleEl: HTMLElement;
}

export interface RecorderWidgetOptions {
  host: HTMLElement;
  plugin: SystemSculptPlugin;
  variant: "desktop" | "mobile";
  onStop: () => void;
  useHostAsRoot?: boolean;
  isChatContext?: boolean;
}

interface MiniAutomation {
  key: string;
  label: string;
  enabled: boolean;
  helper: string;
  locked?: boolean;
}

type RecorderAutomationSetting = keyof Pick<
  SystemSculptSettings,
  | "autoTranscribeRecordings"
  | "autoPasteTranscription"
  | "autoSubmitAfterTranscription"
  | "cleanTranscriptionOutput"
  | "postProcessingEnabled"
>;

const automationSettingKeys: Record<string, RecorderAutomationSetting | undefined> = {
  "auto-transcribe": "autoTranscribeRecordings",
  "auto-paste": "autoPasteTranscription",
  "auto-submit": "autoSubmitAfterTranscription",
  "clean-output": "cleanTranscriptionOutput",
  "post-processing": "postProcessingEnabled",
};

const buildAutomations = (plugin: SystemSculptPlugin, isChatContext: boolean): MiniAutomation[] => {
  const automations: MiniAutomation[] = [
    {
      key: "auto-transcribe",
      label: "Auto-transcribe",
      enabled: plugin.settings.autoTranscribeRecordings,
      helper: "Start transcription as soon as recording stops",
    },
    {
      key: "auto-paste",
      label: "Auto-paste",
      enabled: plugin.settings.autoPasteTranscription,
      helper: "Drop the finished text into the active note",
    },
    {
      key: "clean-output",
      label: "Clean output",
      enabled: plugin.settings.cleanTranscriptionOutput,
      helper: "Return a trimmed transcript without timestamps or blocks",
    },
    {
      key: "post-processing",
      label: "Post-processing",
      enabled: plugin.settings.postProcessingEnabled,
      helper: "Apply your cleanup prompt after the transcript",
    },
    {
      key: "auto-note",
      label: "Save transcript note",
      enabled: true,
      helper: "Automatically saves every recording as a Markdown note",
      locked: true,
    },
  ];

  if (isChatContext) {
    automations.splice(2, 0, {
      key: "auto-submit",
      label: "Auto-submit",
      enabled: plugin.settings.autoSubmitAfterTranscription,
      helper: "Send the chat message when transcription finishes",
    });
  }

  return automations;
};

export function createRecorderWidget(options: RecorderWidgetOptions): RecorderWidgetHandles {
  const { host, variant, onStop, useHostAsRoot = false } = options;
  host.replaceChildren();

  const root = useHostAsRoot ? host : document.createElement("div");
  if (!useHostAsRoot) {
    root.className = "ss-recorder-mini";
    host.appendChild(root);
  } else {
    root.classList.add("ss-recorder-mini");
  }
  root.dataset.variant = variant;
  root.dataset.state = "idle";

  const header = document.createElement("div");
  header.className = "ss-recorder-mini__header";
  root.appendChild(header);

  const headerInfo = document.createElement("div");
  headerInfo.className = "ss-recorder-mini__header-info";
  header.appendChild(headerInfo);

  const liveBadge = document.createElement("span");
  liveBadge.className = "ss-recorder-mini__live";
  liveBadge.textContent = "Recorder idle";
  headerInfo.appendChild(liveBadge);

  const heading = document.createElement("div");
  heading.className = "ss-recorder-mini__heading";
  headerInfo.appendChild(heading);

  const title = document.createElement("p");
  title.className = "ss-recorder-mini__title";
  title.textContent = "Recorder";
  heading.appendChild(title);

  const statusText = document.createElement("span");
  statusText.className = "ss-recorder-mini__status";
  statusText.textContent = "Preparing microphone...";
  heading.appendChild(statusText);

  const stopButton = document.createElement("button");
  stopButton.type = "button";
  stopButton.dataset.recorderStop = "true";
  stopButton.className = "ss-recorder-mini__stop mod-cta";
  stopButton.textContent = "Stop";
  let stopRequested = false;
  const requestStop = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    if (stopRequested) return;
    stopRequested = true;
    stopButton.disabled = true;
    stopButton.textContent = "Stopping…";
    onStop();
  };
  stopButton.addEventListener("pointerup", requestStop);
  stopButton.addEventListener("click", requestStop);
  header.appendChild(stopButton);

  const timer = document.createElement("div");
  timer.className = "ss-recorder-mini__timer";
  timer.setAttribute("role", "timer");
  root.appendChild(timer);

  const timerLabel = document.createElement("span");
  timerLabel.className = "ss-recorder-mini__timer-label";
  timerLabel.textContent = "Live";
  timer.appendChild(timerLabel);

  const timerValue = document.createElement("span");
  timerValue.className = "ss-recorder-mini__timer-value";
  timerValue.textContent = "00:00";
  timer.appendChild(timerValue);

  const settingsSection = document.createElement("div");
  settingsSection.className = "ss-recorder-mini__settings-section";
  root.appendChild(settingsSection);

  const settingsToggle = document.createElement("button");
  settingsToggle.type = "button";
  settingsToggle.className = "ss-recorder-mini__settings-toggle";
  settingsToggle.setAttribute("aria-expanded", "true");
  const settingsToggleLabel = document.createElement("span");
  settingsToggleLabel.className = "ss-recorder-mini__settings-toggle-label";
  settingsToggleLabel.textContent = "Recorder settings";
  const settingsToggleIcon = document.createElement("span");
  settingsToggleIcon.className = "ss-recorder-mini__settings-toggle-icon";
  setIcon(settingsToggleIcon, "chevron-up");
  settingsToggle.appendChild(settingsToggleLabel);
  settingsToggle.appendChild(settingsToggleIcon);
  settingsSection.appendChild(settingsToggle);

  const automationList = document.createElement("div");
  automationList.className = "ss-recorder-mini__settings";
  settingsSection.appendChild(automationList);

  let settingsCollapsed = true;
  const applySettingsCollapsed = (collapsed: boolean) => {
    settingsCollapsed = collapsed;
    settingsSection.dataset.collapsed = collapsed ? "true" : "false";
    settingsToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    automationList.toggleAttribute("hidden", collapsed);
    setIcon(settingsToggleIcon, collapsed ? "chevron-down" : "chevron-up");
  };

  settingsToggle.addEventListener("click", (event) => {
    event.preventDefault();
    applySettingsCollapsed(!settingsCollapsed);
  });
  applySettingsCollapsed(true);

  const plugin = options.plugin;
  const logger = plugin.getLogger();
  const isChatContext =
    typeof options.isChatContext === "boolean"
      ? options.isChatContext
      : plugin.app.workspace.activeLeaf?.view?.getViewType() === CHAT_VIEW_TYPE_ID;

  buildAutomations(plugin, !!isChatContext).forEach((automation) => {
    const item = document.createElement("div");
    item.className = "ss-recorder-mini__setting";
    item.dataset.feature = automation.key;
    item.dataset.enabled = automation.enabled ? "true" : "false";
    if (automation.locked) {
      item.dataset.locked = "true";
    }
    const helperCopy = automation.locked ? `${automation.helper} (always on)` : automation.helper;

    const headerRow = document.createElement("div");
    headerRow.className = "ss-recorder-mini__setting-row";
    item.appendChild(headerRow);

    const label = document.createElement("div");
    label.className = "ss-recorder-mini__setting-title";
    label.textContent = automation.label;
    headerRow.appendChild(label);

    const control = document.createElement("div");
    control.className = "ss-recorder-mini__setting-control";
    headerRow.appendChild(control);

    const toggle = new ToggleComponent(control);

    let isProgrammatic = false;
    const applyState = (enabled: boolean) => {
      item.dataset.enabled = enabled ? "true" : "false";
      isProgrammatic = true;
      toggle.setValue(enabled);
      isProgrammatic = false;
    };
    applyState(automation.enabled);
    if (automation.locked) {
      toggle.setDisabled(true);
    }

    const desc = document.createElement("div");
    desc.className = "ss-recorder-mini__setting-description";
    desc.textContent = helperCopy;
    item.appendChild(desc);

    const settingKey = automationSettingKeys[automation.key];
    if (!automation.locked && settingKey) {
      let isUpdating = false;
      toggle.onChange(async (value) => {
        if (isUpdating || isProgrammatic) return;
        isUpdating = true;
        const previous = item.dataset.enabled === "true";

        try {
          await plugin.getSettingsManager().updateSettings({
            [settingKey]: value,
          } as Partial<SystemSculptSettings>);
          applyState(value);
        } catch (error) {
          applyState(previous);
          logger.error("Failed to toggle recorder automation", error as Error, {
            source: "RecorderWidget",
            metadata: { automationKey: automation.key },
          });
          new Notice("Could not update recorder setting. Check logs for details.");
        } finally {
          isUpdating = false;
        }
      });
    } else {
      toggle.setDisabled(true);
    }

    automationList.appendChild(item);
  });

  // Preferred microphone selector
  const micRow = document.createElement("div");
  micRow.className = "ss-recorder-mini__setting ss-recorder-mini__setting--mic";
  automationList.appendChild(micRow);

  const micTitle = document.createElement("div");
  micTitle.className = "ss-recorder-mini__setting-title ss-recorder-mini__setting-title--stacked";
  micTitle.textContent = "Microphone";
  micRow.appendChild(micTitle);

  const micControl = document.createElement("div");
  micControl.className = "ss-recorder-mini__mic-control";
  micRow.appendChild(micControl);

  const micSelect = document.createElement("select");
  micSelect.className = "dropdown";
  micSelect.disabled = true;
  micControl.appendChild(micSelect);

  const setMicOptions = (options: Array<{ value: string; label: string }>, selected: string) => {
    micSelect.textContent = "";
    options.forEach((option) => {
      const opt = document.createElement("option");
      opt.value = option.value;
      opt.textContent = option.label;
      micSelect.appendChild(opt);
    });
    micSelect.value = selected;
  };

  const updateMicPreference = async (deviceId: string, label: string) => {
    try {
      await plugin.getSettingsManager().updateSettings({ preferredMicrophoneId: deviceId });
      micStatus.textContent = `Using: ${label}`;
    } catch (error) {
      micStatus.textContent = "Unable to save microphone preference.";
      logger.error("Failed to update microphone preference", error as Error);
    }
  };

  micSelect.addEventListener("change", () => {
    const selectedOption = micSelect.selectedOptions[0];
    if (!selectedOption) return;
    void updateMicPreference(selectedOption.value, selectedOption.textContent || selectedOption.value);
  });

  const loadMicrophones = async (explicitRefresh: boolean = false) => {
    const fallbackOptions = [{ value: "default", label: "Default microphone" }];
    const preferred = plugin.settings.preferredMicrophoneId || "default";

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
      setMicOptions(fallbackOptions, preferred);
      micSelect.disabled = false;
      micStatus.textContent = "Microphone selection isn't available in this environment.";
      return;
    }

    try {
      micStatus.textContent = explicitRefresh ? "Refreshing microphones..." : "Loading microphones...";
      micSelect.disabled = true;

      const baseDevices = await navigator.mediaDevices.enumerateDevices();
      const haveLabels = baseDevices.some((device) => device.kind === "audioinput" && device.label);
      if (!haveLabels) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((track) => track.stop());
        } catch (err) {
          micStatus.textContent = "Microphone access denied; showing generic device names.";
        }
      }

      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((device) => device.kind === "audioinput");
      const optionsList =
        audioInputs.length > 0
          ? [
              ...fallbackOptions,
              ...audioInputs.map((device) => ({
                value: device.deviceId,
                label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
              })),
            ]
          : fallbackOptions;

      setMicOptions(optionsList, optionsList.some((opt) => opt.value === preferred) ? preferred : "default");
      micSelect.disabled = false;
      micStatus.textContent = audioInputs.length ? "" : "No microphones detected.";
    } catch (error: any) {
      setMicOptions(fallbackOptions, "default");
      micSelect.disabled = false;
      micStatus.textContent = `Unable to load microphones: ${error?.message ?? error}`;
    }
  };

  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "clickable-icon ss-recorder-mini__mic-refresh";
  setIcon(refreshButton, "refresh-cw");
  refreshButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void loadMicrophones(true);
  });
  micControl.appendChild(refreshButton);

  const micDesc = document.createElement("div");
  micDesc.className = "ss-recorder-mini__setting-description";
  micDesc.textContent = "Choose which microphone SystemSculpt should use.";
  micRow.appendChild(micDesc);

  const micStatus = document.createElement("div");
  micStatus.className = "ss-recorder-mini__mic-status";
  micRow.appendChild(micStatus);

  void loadMicrophones();

  return {
    root,
    statusTextEl: statusText,
    timerValueEl: timerValue,
    canvasEl: null,
    liveBadgeEl: liveBadge,
    dragHandleEl: headerInfo,
  };
}
