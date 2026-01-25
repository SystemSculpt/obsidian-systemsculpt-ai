import { App, MarkdownView, Notice, WorkspaceLeaf, TFile } from "obsidian";
import SystemSculptPlugin from "../../main";
import { RibbonManager } from "./ribbons";
import { StandardModelSelectionModal, ModelSelectionResult, ModelSelectionOptions } from "../../modals/StandardModelSelectionModal";
import { ChatView } from "../../views/chatview/ChatView";
import { TitleGenerationService } from "../../services/TitleGenerationService";
import { TemplateSelectionModal } from "../../modals/TemplateSelectionModal";
import { ensureCanonicalId } from "../../utils/modelUtils";
import { DebugLogger } from "../../utils/debugLogger";
import { errorLogger } from "../../utils/errorLogger";
import { WORKFLOW_AUTOMATIONS } from "../../constants/workflowTemplates";
import { AutomationRunnerModal, AutomationOption } from "../../modals/AutomationRunnerModal";
import { AutomationBacklogModal } from "../../modals/AutomationBacklogModal";

export class CommandManager {
  private plugin: SystemSculptPlugin;
  private app: App;
  private ribbonManager: RibbonManager;

  constructor(plugin: SystemSculptPlugin, app: App) {
    this.plugin = plugin;
    this.app = app;
    this.ribbonManager = new RibbonManager(plugin, app);
  }

  registerCommands() {
    this.registerToggleAudioRecorder();
    this.registerOpenChat();
    this.registerOpenChatHistory();
    this.registerOpenJanitor();
    this.registerMeetingProcessor();
    this.registerOpenSystemSculptSearch();
    this.registerReloadObsidian();
    this.registerOpenSettings();
    this.registerChangeChatModel();
    this.registerSetDefaultChatModel();
    this.registerChatWithFile();
    this.registerResumeChat();
    this.registerChangeChatTitle();
    this.registerOpenTemplateModal();
    this.registerOpenEmbeddingsView();
    this.registerOpenBenchView();
    this.registerOpenBenchResultsView();
    this.registerQuickFileEdit();
    this.registerDebugCommands();
    this.registerEmbeddingsDatabaseCommands();
    this.registerDailyVaultCommands();
    this.registerRunAutomationCommand();
    this.registerAutomationBacklogCommand();
    this.registerYouTubeCanvas();
  }


  private registerToggleAudioRecorder() {
    this.plugin.addCommand({
      id: "toggle-audio-recorder",
      name: "Toggle Audio Recorder",
      callback: async () => {
        const alreadyInitialized = this.plugin.hasRecorderService();
        const logger = this.plugin.getLogger();

        logger.debug("Toggle audio recorder command received", {
          source: "CommandManager",
          method: "toggleAudioRecorder",
          metadata: {
            alreadyInitialized
          }
        });

        try {
          const recorderService = this.plugin.getRecorderService();
          await recorderService.toggleRecording();

          logger.info("Audio recorder toggled", {
            source: "CommandManager",
            method: "toggleAudioRecorder",
            metadata: {
              alreadyInitialized
            }
          });
        } catch (error) {
          logger.error("Failed to toggle audio recorder", error, {
            source: "CommandManager",
            method: "toggleAudioRecorder",
            metadata: {
              alreadyInitialized
            }
          });

          new Notice("Unable to toggle the audio recorder.", 8000);
        }
      },
      hotkeys: [{ modifiers: ["Mod"], key: "r" }],
    });
  }

  private registerOpenChat() {
    this.plugin.addCommand({
      id: "open-systemsculpt-chat",
      name: "Open SystemSculpt Chat",
      callback: async () => {
        await this.ribbonManager.openChatView();
      },
    });
  }

  private registerOpenChatHistory() {
    this.plugin.addCommand({
      id: "open-chat-history",
      name: "Open SystemSculpt Chat History",
      callback: () => {
        this.ribbonManager.openChatHistoryModal();
      },
    });
  }

  private registerOpenJanitor() {
    this.plugin.addCommand({
      id: "open-systemsculpt-janitor",
      name: "Open SystemSculpt Janitor",
      callback: () => {
        this.ribbonManager.openJanitorModal();
      },
    });
  }

  private registerMeetingProcessor() {
    this.plugin.addCommand({
      id: "open-meeting-processor",
      name: "Open Meeting Processor",
      callback: async () => {
        const { MeetingProcessorModal } = await import("../../modals/MeetingProcessorModal");
        const modal = new MeetingProcessorModal(this.plugin);
        modal.open();
      },
    });
  }

  private registerOpenSystemSculptSearch() {
    this.plugin.addCommand({
      id: "open-systemsculpt-search",
      name: "Open SystemSculpt Search",
      callback: async () => {
        const { SystemSculptSearchModal } = await import("../../modals/SystemSculptSearchModal");
        const modal = new SystemSculptSearchModal(this.plugin);
        modal.open();
      },
      hotkeys: [{ modifiers: ["Mod"], key: "k" }],
    });
  }

  private registerReloadObsidian() {
    this.plugin.addCommand({
      id: "reload-obsidian",
      name: "Reload Obsidian",
      callback: () => {
        window.location.reload();
      },
    });
  }

  private registerOpenSettings() {
    this.plugin.addCommand({
      id: "open-systemsculpt-settings",
      name: "Open SystemSculpt AI Settings",
      callback: () => {
        // @ts-ignore – this is a known Obsidian API bug
        this.app.setting.open();
        // @ts-ignore
        this.app.setting.openTabById(this.plugin.manifest.id);
      },
    });
  }


  private registerChangeChatModel() {
    this.plugin.addCommand({
      id: "change-chat-model",
      name: "Change Chat Model (Current Chat)",
      checkCallback: (checking: boolean) => {
        const chatView = this.app.workspace.getActiveViewOfType(ChatView);
        if (!chatView) {
          if (!checking) {
            new Notice("You need to be in an active SystemSculpt chat view to use this command.", 5000);
          }
          return false;
        }
        if (!checking) {
          (async () => {
            try {
              await this.plugin.modelService.getModels();

              const modal = new StandardModelSelectionModal({
                  app: this.app,
                  plugin: this.plugin,
                  currentModelId: chatView.getSelectedModelId() || "",
                  onSelect: async (result: ModelSelectionResult) => {
                    const canonicalId = ensureCanonicalId(result.modelId);
                    await chatView.setSelectedModelId(canonicalId);
                    new Notice("Model updated for this chat.", 2000);
                }
              });
              modal.open();
            } catch (err) {
              new Notice("Failed to fetch available models", 10000);
            }
          })();
        }
        return true;
      },
    });
  }

  private registerSetDefaultChatModel() {
    this.plugin.addCommand({
      id: "set-default-chat-model",
      name: "Set Default Chat Model",
      callback: async () => {
        if (!this.plugin) {
          new Notice("SystemSculpt plugin not available.", 10000);
          return;
        }

        try {
          await this.plugin.modelService.getModels();

          const modal = new StandardModelSelectionModal({
              app: this.app,
              plugin: this.plugin,
              currentModelId: this.plugin.settings.selectedModelId || "",
              onSelect: async (result: ModelSelectionResult) => {
                // Always set as default since this is the "select default model" command
                try {
                    const canonicalId = ensureCanonicalId(result.modelId);
                    await this.plugin.getSettingsManager().updateSettings({ selectedModelId: canonicalId });
                    new Notice("Default model for new chats updated.", 3000);
                } catch (saveError) {
                    new Notice("Failed to save default model setting.", 10000);
                }
              }
          });
          modal.open();
        } catch (err) {
          new Notice("Failed to fetch available models", 10000);
        }
      },
    });
  }

  private registerChatWithFile() {
    this.plugin.addCommand({
      id: "chat-with-file",
      name: "Chat with File",
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return false;
        const extension = activeFile.extension.toLowerCase();
        const supportedExtensions = [
          "md",
          "txt",
          "markdown",
          "pdf",
          "doc",
          "docx",
          "ppt",
          "pptx",
          "xls",
          "xlsx",
          "mp3",
          "wav",
          "m4a",
          "ogg",
          "webm",
          "jpg",
          "jpeg",
          "png",
          "gif",
          "webp",
          "svg",
        ];
        if (!supportedExtensions.includes(extension)) return false;
        if (!checking) {
          const leaf = this.app.workspace.getLeaf("tab");
          const view = new ChatView(leaf, this.plugin);
          leaf.open(view).then(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            this.app.workspace.setActiveLeaf(leaf, { focus: true });
            await view.addFileToContext(activeFile);
            view.focusInput();
          });
        }
        return true;
      },
    });
  }

  private registerResumeChat() {
    this.plugin.addCommand({
      id: "resume-chat-from-history",
      name: "Resume Chat from Current History File",
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        
        // Check if we have an active file and if it's a chat history file
        if (!activeFile || !this.plugin.resumeChatService) return false;
        
        const isChatHistory = this.plugin.resumeChatService.isChatHistoryFile(activeFile);
        
        if (!checking && isChatHistory) {
          // Extract chat ID and model from the file
          const chatId = this.plugin.resumeChatService.extractChatId(activeFile);
          const modelId = this.plugin.resumeChatService.getModelFromFile(activeFile);
          
          if (chatId) {
            // Resume the chat
            this.plugin.resumeChatService.openChat(chatId, modelId);
          } else {
            new Notice("Could not extract chat ID from this file.", 5000);
          }
        }
        
        return isChatHistory;
      },
    });
  }


  /**
   * Register command to change/generate title for chats and notes
   */
  private registerChangeChatTitle() {
    this.plugin.addCommand({
      id: "change-chat-title",
      name: "Change/Generate Title",
      checkCallback: (checking: boolean) => {
        // First check if we're in a chat view
        const chatView = this.app.workspace.getActiveViewOfType(ChatView);
        if (chatView) {
          if (chatView.messages.length === 0) return false;
          if (!checking) {
            (async () => {
              // Show initial notice
              const notice = new Notice("Generating title...", 0);

              try {
                const titleService = TitleGenerationService.getInstance(this.plugin);
                const title = await titleService.generateTitle(
                  chatView.getMessages(),
                  (title) => {
                    // No need to update UI during generation
                  },
                  (progress: number, status: string) => {
                    // Update notice text with progress
                    notice.setMessage(`Generating title... ${status}`);
                  }
                );

                if (title && title !== chatView.getChatTitle()) {
                  await chatView.setTitle(title);
                  notice.setMessage("Chat title updated successfully!");
                  notice.hide();
                } else {
                  notice.hide();
                }
              } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                notice.setMessage(`Failed to generate title: ${errorMessage}`);
                notice.hide();
              }
            })();
          }
          return true;
        }

        // If not in chat view, check if we're in a regular note
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
          if (!checking) {
            new Notice("You need to be within a note or chat view to change the title.", 5000);
          }
          return false;
        }

        // Only allow for markdown files
        if (activeFile.extension !== 'md') {
          if (!checking) {
            new Notice("Title generation is only available for markdown files.", 5000);
          }
          return false;
        }

        if (!checking) {
          (async () => {
            // Show initial notice
            const notice = new Notice("Generating title...", 0);

            try {
              const titleService = TitleGenerationService.getInstance(this.plugin);
              const title = await titleService.generateTitle(
                activeFile,
                (title) => {
                  // No need to update UI during generation
                },
                (progress: number, status: string) => {
                  // Update notice text with progress
                  notice.setMessage(`Generating title... ${status}`);
                }
              );

              if (title && title !== activeFile.basename) {
                // Get the new path with the new title
                const newPath = activeFile.path.replace(activeFile.basename, title);
                try {
                  await this.app.fileManager.renameFile(activeFile, newPath);
                  notice.setMessage("Note title updated successfully!");
                  notice.hide();
                } catch (error) {
                  const errorMessage = error instanceof Error ? error.message : String(error);
                  notice.setMessage(`Failed to rename file: ${errorMessage}`);
                  notice.hide();
                }
              } else {
                notice.hide();
              }
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              notice.setMessage(`Failed to generate title: ${errorMessage}`);
              notice.hide();
            }
          })();
        }
        return true;
      },
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "t" }],
    });
  }

  private registerOpenTemplateModal() {
    this.plugin.addCommand({
      id: "open-template-modal",
      name: "Open Template Selection",
      checkCallback: (checking: boolean) => {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

        // Only enable in a markdown view
        if (!activeView) return false;

        if (!checking) {
          const editor = activeView.editor;

          // Create and open the template selection modal
          const modal = new TemplateSelectionModal(
            this.app,
            this.plugin,
            async (file) => {
              try {
                // Get the template content
                const templateContent = await this.app.vault.read(file);

                // Get cursor position
                const cursor = editor.getCursor();

                // Insert the template content at cursor position
                editor.replaceRange(templateContent, cursor);

                // Move cursor to end of inserted text
                const lines = templateContent.split("\n");
                const endPosition = {
                  line: cursor.line + lines.length - 1,
                  ch: lines[lines.length - 1]?.length || 0
                };

                // Set cursor position after the inserted template
                editor.setCursor(endPosition);

                // Set focus back to editor
                activeView.editor.focus();

                // Show success message
                new Notice(`Template "${file.basename}" inserted`, 3000);
              } catch (error) {
                new Notice("Error inserting template", 10000);
              }
            }
          );

          modal.open();
        }

        return true;
      }
    });
  }

  private registerOpenEmbeddingsView() {
    this.plugin.addCommand({
      id: "open-embeddings-view",
      name: "Open Similar Notes Panel",
      callback: async () => {
        try {
          await this.plugin.getViewManager().activateEmbeddingsView();
        } catch (error) {
          new Notice(`Error opening similar notes panel: ${error.message}`);
        }
      },
    });
  }

  private registerOpenBenchView() {
    this.plugin.addCommand({
      id: "open-systemsculpt-benchmark",
      name: "Open SystemSculpt Benchmark",
      callback: async () => {
        await this.plugin.getViewManager().activateBenchView();
      },
    });
  }

  private registerOpenBenchResultsView() {
    this.plugin.addCommand({
      id: "open-systemsculpt-benchmark-results",
      name: "Open SystemSculpt Benchmark Results",
      callback: async () => {
        await this.plugin.getViewManager().activateBenchResultsView();
      },
    });
  }

  private registerQuickFileEdit() {
    this.plugin.addCommand({
      id: "quick-file-edit",
      name: "Quick Edit (Active File)",
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return false;
        if (!checking) {
          (async () => {
            const { showQuickEditWidget } = await import("../../components/QuickEditWidget");
            showQuickEditWidget(this.app, this.plugin);
          })();
        }
        return true;
      }
    });
  }

  private registerDailyVaultCommands() {
    const logger = this.plugin.getLogger();

    this.plugin.addCommand({
      id: "daily-vault-open-today",
      name: "Open Today's Daily Note",
      callback: async () => {
        try {
          await this.plugin.getDailyNoteService().openDailyNote();
        } catch (error) {
          logger?.error("Failed to open today's daily note", error, {
            source: "CommandManager",
            command: "daily-vault-open-today",
          });
          new Notice("Unable to open today's daily note. Check your Daily Vault settings.", 6000);
        }
      },
    });

    this.plugin.addCommand({
      id: "daily-vault-create-note",
      name: "Create Daily Note",
      callback: async () => {
        try {
          const note = await this.plugin.getDailyNoteService().createDailyNote();
          new Notice(`Daily note ready: ${note.basename}`, 4000);
        } catch (error) {
          logger?.error("Failed to create daily note", error, {
            source: "CommandManager",
            command: "daily-vault-create-note",
          });
          new Notice("Unable to create daily note. Verify your Daily Vault configuration.", 6000);
        }
      },
    });

    this.plugin.addCommand({
      id: "daily-vault-open-yesterday",
      name: "Open Yesterday's Daily Note",
      callback: async () => {
        try {
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          await this.plugin.getDailyNoteService().openDailyNote(yesterday, false);
        } catch (error) {
          logger?.warn("Yesterday's daily note not found", {
            source: "CommandManager",
            command: "daily-vault-open-yesterday",
          });
          new Notice("Couldn't find yesterday's daily note. Create it manually if needed.", 6000);
        }
      },
    });

    this.plugin.addCommand({
      id: "daily-vault-start-daily-review",
      name: "Start Daily Review",
      callback: async () => {
        try {
          await this.plugin.getDailyReviewService().startDailyReview();
        } catch (error) {
          logger?.error("Failed to start daily review", error, {
            source: "CommandManager",
            command: "daily-vault-start-daily-review",
          });
          new Notice("Daily review unavailable. Confirm your Daily Vault setup.", 6000);
        }
      },
    });

    this.plugin.addCommand({
      id: "daily-vault-start-weekly-review",
      name: "Start Weekly Review",
      callback: async () => {
        try {
          await this.plugin.getDailyReviewService().startWeeklyReview();
        } catch (error) {
          logger?.error("Failed to start weekly review", error, {
            source: "CommandManager",
            command: "daily-vault-start-weekly-review",
          });
          new Notice("Weekly review couldn't be prepared. Check your template path in Daily Vault settings.", 6000);
        }
      },
    });

    this.plugin.addCommand({
      id: "daily-vault-view-streak",
      name: "View Daily Streak",
      callback: async () => {
        try {
          await this.plugin.getDailyReviewService().showDailyStreakSummary();
        } catch (error) {
          logger?.error("Failed to display daily streak", error, {
            source: "CommandManager",
            command: "daily-vault-view-streak",
          });
          new Notice("Unable to load streak data. Ensure daily notes live in the configured directory.", 6000);
        }
      },
    });

    this.plugin.addCommand({
      id: "daily-vault-open-settings",
      name: "Open Daily Vault Settings",
      callback: async () => {
        try {
          // @ts-ignore – Obsidian API typing gap
          this.app.setting.open();
          // @ts-ignore – Obsidian API typing gap
          this.app.setting.openTabById(this.plugin.manifest.id);
          window.setTimeout(() => {
            this.plugin.getDailySettingsService();
            this.app.workspace.trigger("systemsculpt:settings-focus-tab", "daily-vault");
          }, 100);
        } catch (error) {
          logger?.error("Failed to open Daily Vault settings", error, {
            source: "CommandManager",
            command: "daily-vault-open-settings",
          });
          new Notice("Unable to open Daily Vault settings. Open SystemSculpt settings manually.", 6000);
        }
      },
    });
  }

  private registerRunAutomationCommand() {
    this.plugin.addCommand({
      id: "run-workflow-automation",
      name: "Run Workflow Automation",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("Open a note before running an automation.", 4000);
          return;
        }

        if (file.extension.toLowerCase() !== "md") {
          new Notice("Automations currently support markdown notes only.", 5000);
          return;
        }

        const options = this.buildAutomationOptions();
        if (options.length === 0) {
          new Notice("No automations available. Enable one under Settings → Automations.", 5000);
          return;
        }

        const modal = new AutomationRunnerModal(this.app, this.plugin, file, options);
        modal.open();
      },
    });
  }

  private registerAutomationBacklogCommand() {
    this.plugin.addCommand({
      id: "open-automation-backlog",
      name: "Show Automation Backlog",
      callback: async () => {
        const modal = new AutomationBacklogModal(this.app, this.plugin);
        modal.open();
      },
    });
  }

  private buildAutomationOptions(): AutomationOption[] {
    const automationSettings = this.plugin.settings.workflowEngine?.templates || {};

    return WORKFLOW_AUTOMATIONS.map((definition) => {
      const state = automationSettings[definition.id];
      return {
        id: definition.id,
        title: definition.title,
        subtitle: state?.destinationFolder || definition.destinationPlaceholder,
      };
    });
  }

  private registerYouTubeCanvas() {
    this.plugin.addCommand({
      id: "open-youtube-canvas",
      name: "YouTube Canvas - Extract transcript and create note",
      callback: async () => {
        const { YouTubeCanvasModal } = await import("../../modals/YouTubeCanvasModal");
        new YouTubeCanvasModal(this.app, this.plugin).open();
      },
    });
  }

  private registerDebugCommands() {}

  private getDebuggingGuideContent(): string {
    return `# SystemSculpt Diagnostics Guide

SystemSculpt no longer records plugin-specific logs. Use these steps when something looks off:

1. Make note of the action you just took and any notices Obsidian displayed.
2. Capture the workflow or screenshot that best shows the issue.
3. Share your SystemSculpt version, Obsidian version, and reproduction steps when you contact support.

Without dedicated logs, clear reproduction details are the quickest path to a fix.`;
  }

  private registerEmbeddingsDatabaseCommands() {
    // Diagnostic command for developers/debugging only - not shown in command palette 
    this.plugin.addCommand({
      id: "embeddings-database-stats",
      name: "Show Embeddings Database Statistics (Debug)",
      checkCallback: (checking: boolean) => {
        // Only show if embeddings are enabled
        const embeddingsEnabled = this.plugin.settings.embeddingsEnabled;
        if (!embeddingsEnabled) return false;
        
        if (!checking) {
          this.showEmbeddingsDatabaseStats();
        }
        return true;
      }
    });

    // User-visible: force refresh embeddings for current provider/model/schema
    this.plugin.addCommand({
      id: "rebuild-embeddings-current-model",
      name: "Rebuild Embeddings (Current Model)",
      checkCallback: (checking: boolean) => {
        // Only show if embeddings are enabled
        const enabled = this.plugin.settings.embeddingsEnabled;
        if (!enabled) return false;
        if (!checking) {
          (async () => {
            try {
              const { Notice } = require('obsidian');
              // Ask for confirmation
              const confirmed = confirm('This will delete and rebuild embeddings for the current provider/model/schema only. Continue?');
              if (!confirmed) return;
              new Notice('Rebuilding embeddings for current model…', 4000);
              const manager = this.plugin.getOrCreateEmbeddingsManager();
              await manager.forceRefreshCurrentNamespace();
              new Notice('Embeddings rebuild complete.', 4000);
            } catch (e: any) {
              const { Notice } = require('obsidian');
              new Notice(`Failed to rebuild embeddings: ${e?.message || e}`, 8000);
            }
          })();
        }
        return true;
      }
    });
  }

  private async showEmbeddingsDatabaseStats(): Promise<void> {
    try {
      const { Notice } = require("obsidian");
      
      // Get embeddings manager for stats
      const embeddingsManager = this.plugin.getOrCreateEmbeddingsManager();
      if (!embeddingsManager) {
        new Notice("Embeddings manager not available", 5000);
        return;
      }
      
      // Get basic stats from embeddings manager
      const isProcessing = embeddingsManager.isCurrentlyProcessing();
      const stats = embeddingsManager.getStats();

      const statsText = [
        "Embeddings Statistics:",
        `Status: ${isProcessing ? "Processing" : "Idle"}`,
        `Total Files: ${stats.total}`,
        `Needs Processing: ${stats.needsProcessing}`,
        `With embeddings: ${stats.present}`,
        `Sealed: ${stats.processed}`
      ].filter(Boolean).join("\n");
      
      // Show user-friendly summary
      new Notice(statsText, 8000);
      
    } catch (error) {
      const { Notice } = require("obsidian");
      new Notice(`Error getting database stats: ${error.message}`, 5000);
    }
  }

}
