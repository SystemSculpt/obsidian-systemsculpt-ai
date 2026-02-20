import { App, Modal } from "obsidian";
import { getVideoCapturePermissionStatus, type VideoCapturePermissionStatus } from "../services/video/VideoCapturePermissionStatus";

export interface VideoRecordingPermissionModalResult {
  confirmed: boolean;
  dontShowAgain: boolean;
}

/**
 * Explains why video capture permissions are required before recording starts.
 */
export const openVideoRecordingPermissionModal = async (
  app: App
): Promise<VideoRecordingPermissionModalResult> => {
  let status: VideoCapturePermissionStatus;
  try {
    status = await getVideoCapturePermissionStatus();
  } catch {
    status = {
      screenAndSystemAudio: {
        state: "unknown",
        detail: "Unable to verify in this runtime.",
      },
      directWindowAccess: {
        state: "unknown",
        detail: "Unable to verify in this runtime.",
      },
    };
  }

  const getStateLabel = (state: "done" | "needs-action" | "unknown"): string => {
    if (state === "done") return "Done";
    if (state === "needs-action") return "Action needed";
    return "Unable to verify";
  };

  const buildNextStep = (permissionStatus: VideoCapturePermissionStatus): string => {
    if (permissionStatus.screenAndSystemAudio.state !== "done") {
      return "Next step: Enable Screen & System Audio Recording for Obsidian in macOS Settings first.";
    }
    if (permissionStatus.directWindowAccess.state !== "done") {
      return "Next step: When macOS prompts for direct window access/bypass, allow it. If not available, use the window picker and choose Obsidian.";
    }
    return "Next step: You're set. Start recording and choose the Obsidian window if prompted.";
  };

  return await new Promise<VideoRecordingPermissionModalResult>((resolve) => {
    const modal = new (class extends Modal {
      private confirmed = false;
      private dontShowAgain = false;

      constructor(modalApp: App) {
        super(modalApp);
      }

      public onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl("h3", { text: "Video Capture Permissions" });
        contentEl.createEl("p", {
          text: "To record your Obsidian workflow, macOS must allow screen capture for Obsidian.",
        });
        contentEl.createEl("p", {
          text: "On current macOS versions, this permission appears as Screen & System Audio Recording. If microphone capture is enabled, macOS may also request microphone permission.",
        });

        contentEl.createEl("h4", { text: "Detected Status" });
        const statusList = contentEl.createEl("ul");
        statusList.createEl("li", {
          text: `Screen & System Audio Recording: ${getStateLabel(status.screenAndSystemAudio.state)} — ${status.screenAndSystemAudio.detail}`,
        });
        statusList.createEl("li", {
          text: `Direct Obsidian-window access (private-picker bypass): ${getStateLabel(status.directWindowAccess.state)} — ${status.directWindowAccess.detail}`,
        });
        contentEl.createEl("p", {
          text: buildNextStep(status),
        });

        contentEl.createEl("h4", { text: "What You Need To Allow" });
        const permissionsList = contentEl.createEl("ul");
        permissionsList.createEl("li", {
          text: "Enable Obsidian under System Settings > Privacy & Security > Screen & System Audio Recording.",
        });
        permissionsList.createEl("li", {
          text: "If macOS asks about bypassing the private window picker for direct capture, allow it so recording can start reliably.",
        });
        permissionsList.createEl("li", {
          text: "When a system source picker appears, select the Obsidian window to keep the capture focused.",
        });

        contentEl.createEl("h4", { text: "Why This Is Needed" });
        const whyList = contentEl.createEl("ul");
        whyList.createEl("li", {
          text: "Without this permission, macOS blocks all screen capture APIs and recording cannot start.",
        });
        whyList.createEl("li", {
          text: "Some Obsidian/Electron runtimes require a direct-capture fallback that bypasses the private picker to avoid startup failures.",
        });
        whyList.createEl("li", {
          text: "Recordings are saved locally in your configured SystemSculpt video recordings folder.",
        });

        const checkboxRow = contentEl.createDiv({ cls: "ss-video-permission-modal-checkbox" });
        const checkbox = checkboxRow.createEl("input", { type: "checkbox" });
        checkbox.id = "ss-video-permission-modal-hide";
        const label = checkboxRow.createEl("label", {
          text: "Do not show this reminder again",
        });
        label.setAttr("for", checkbox.id);

        checkbox.addEventListener("change", () => {
          this.dontShowAgain = checkbox.checked;
        });

        const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
        const cancelButton = buttonRow.createEl("button", { text: "Cancel" });
        cancelButton.addEventListener("click", () => {
          this.confirmed = false;
          this.close();
        });

        const continueButton = buttonRow.createEl("button", { text: "Continue" });
        continueButton.addClass("mod-cta");
        continueButton.addEventListener("click", () => {
          this.confirmed = true;
          this.close();
        });
      }

      public onClose(): void {
        resolve({
          confirmed: this.confirmed,
          dontShowAgain: this.dontShowAgain,
        });
      }
    })(app);

    modal.open();
  });
};
