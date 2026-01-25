import { SystemSculptService } from "./SystemSculptService";

import type SystemSculptPlugin from "../main";
import { ChatMessage, DEFAULT_TITLE_GENERATION_PROMPT } from "../types";
import { TFile, Notice } from "obsidian";
import { sanitizeChatTitle } from "../utils/titleUtils";
import { ensureCanonicalId, parseCanonicalId, createCanonicalId } from "../utils/modelUtils";
import { SystemSculptError, ERROR_CODES } from "../utils/errors";
import { showAlert } from "../core/ui/notifications";
import { showPopup } from "../core/ui/modals/PopupModal";
import { StandardModelSelectionModal, ModelSelectionResult } from "../modals/StandardModelSelectionModal";

/**
 * Service for generating titles for chats and notes
 * Handles both automatic and manual title generation
 */
export class TitleGenerationService {
  private static instance: TitleGenerationService;
  private sculptService: SystemSculptService;
  private defaultModelId: string | null = null;

  private constructor(private plugin: SystemSculptPlugin) {
    // Use singleton instance instead of creating new one
    this.sculptService = SystemSculptService.getInstance(plugin);
  }

  /**
   * Get the singleton instance of the TitleGenerationService
   * @param plugin The SystemSculptPlugin instance
   * @returns The TitleGenerationService instance
   */
  static getInstance(plugin: SystemSculptPlugin): TitleGenerationService {
    if (!TitleGenerationService.instance) {
      TitleGenerationService.instance = new TitleGenerationService(plugin);
    }
    return TitleGenerationService.instance;
  }

  /**
   * Sanitizes a title to ensure it doesn't contain characters that are invalid in filenames
   * @param title The title to sanitize
   * @returns A sanitized title safe for use as a filename
   */
  sanitizeTitle(title: string): string {
    return sanitizeChatTitle(title);
  }

  /**
   * Helper method to determine if we're in note context
   */
  private isNoteContext(messages: ChatMessage[] | TFile): boolean {
    return messages instanceof TFile;
  }

  /**
   * Get the prompt content to use for title generation
   * Handles different prompt types and custom prompts from files
   * @param isNoteContext Whether the content is a note (true) or chat (false)
   * @returns The prompt content to use
   */
  private async getTitleGenerationPrompt(isNoteContext: boolean = false): Promise<string> {
    const { titleGenerationPromptType, titleGenerationPrompt, titleGenerationPromptPath } = this.plugin.settings;

    // If using a custom prompt from settings, return it directly
    if (titleGenerationPrompt) {
      return this.adaptPromptToContext(titleGenerationPrompt, isNoteContext);
    }

    // If using a preset prompt type
    if (titleGenerationPromptType === "precise") {
      return this.adaptPromptToContext(DEFAULT_TITLE_GENERATION_PROMPT, isNoteContext);
    }

    // If using movie-style preset
    if (titleGenerationPromptType === "movie-style") {
      const movieStylePrompt = `You are a creative title generation assistant focused on creating engaging, movie-style titles.

Your task is to analyze the provided ${isNoteContext ? 'note' : 'conversation'} and generate a single, attention-grabbing title that:
- Has a cinematic, dramatic quality similar to movie titles
- Uses creative, evocative language that captures the essence of the ${isNoteContext ? 'note' : 'conversation'}
- Is between 2-6 words long
- May use metaphors, wordplay, or allusions when appropriate
- Maintains proper capitalization (typically capitalize all major words)
- NEVER includes characters that are invalid in filenames: \\ / : * ? " < > |
- Uses proper spacing between all words

The title should be memorable and distinctive while still reflecting the actual content of the ${isNoteContext ? 'note' : 'conversation'}.
Respond with ONLY the title, nothing else.`;
      return movieStylePrompt;
    }

    // If using a custom prompt from a file
    if (titleGenerationPromptType === "custom" && titleGenerationPromptPath) {
      try {
        const file = this.plugin.app.vault.getAbstractFileByPath(titleGenerationPromptPath);
        if (file instanceof TFile) {
          const promptContent = await this.plugin.app.vault.read(file);
          return this.adaptPromptToContext(promptContent, isNoteContext);
        }
      } catch (error) {
      }
    }

    // Fallback to default prompt
    return this.adaptPromptToContext(DEFAULT_TITLE_GENERATION_PROMPT, isNoteContext);
  }

  /**
   * Adapt a prompt to the current context (note or chat)
   * @param prompt The original prompt
   * @param isNoteContext Whether the content is a note (true) or chat (false)
   * @returns The adapted prompt
   */
  private adaptPromptToContext(prompt: string, isNoteContext: boolean): string {
    if (isNoteContext) {
      // Replace conversation-specific terms with note-specific terms
      return prompt
        .replace(/conversation/gi, 'note')
        .replace(/chat/gi, 'note')
        .replace(/messages/gi, 'content');
    }
    return prompt;
  }

  /**
   * Generate a title based on the content of messages or a file
   * @param messages The chat messages or file to generate a title for
   * @param onProgress Optional callback for progress updates with the current title
   * @param onStatusUpdate Optional callback for status updates
   * @param additionalContext Optional additional context from user to help with title generation
   * @param retryCount Internal retry counter to prevent infinite loops
   * @returns The generated title
   */
  async generateTitle(
    messages: ChatMessage[] | TFile,
    onProgress?: (title: string) => void,
    onStatusUpdate?: (progress: number, status: string) => void,
    additionalContext?: string,
    retryCount: number = 0
  ): Promise<string> {
    // Declare variables outside try block so they're available in catch
    let canonicalModelId: string = "";
    let usedFallback = false;
    
    try {
      // Determine the canonical model ID to use for title generation
      const useLatestEverywhere = this.plugin.settings.useLatestModelEverywhere ?? true;
      const isStandardMode = this.plugin.settings.settingsMode !== 'advanced';
      const tgId = (useLatestEverywhere || isStandardMode)
        ? "" // force fallback to global selected model below
        : this.plugin.settings.titleGenerationModelId;
      const tgProvider = (useLatestEverywhere || isStandardMode)
        ? ""
        : this.plugin.settings.titleGenerationProviderId;

      if (tgId) {
        if (tgId.includes('@@')) {
          // Already canonical
          canonicalModelId = tgId;
        } else if (tgProvider) {
          // Construct canonical ID from separate provider + model
          canonicalModelId = createCanonicalId(tgProvider, tgId);
        } else {
          // Best-effort canonicalization with default provider
          canonicalModelId = ensureCanonicalId(tgId);
        }
      } else {
        // Fallback to globally selected chat model
        const globalDefault = this.plugin.settings.selectedModelId;
        if (globalDefault) {
          canonicalModelId = ensureCanonicalId(globalDefault);
        }
      }

      if (!canonicalModelId) {
        throw new Error("Failed to determine a valid model for title generation.");
      }

      // Validate chosen model and find an alternative if unavailable
      try {
        const { isAvailable, alternativeModel } = await this.plugin.modelService.validateSpecificModel(canonicalModelId);
        if (!isAvailable && alternativeModel) {
          canonicalModelId = alternativeModel.id;
          usedFallback = true;
        }
      } catch (_) {
        // If validation fails unexpectedly, proceed; server-side will handle errors and we have retry flow
      }

      // Prepare content for title generation
      let contentXml = "";

      if (messages instanceof TFile) {
        // Handle regular Obsidian note
        onStatusUpdate?.(20, "Reading note content...");
        const content = await this.plugin.app.vault.read(messages);
        contentXml = `<content_to_generate_title_from>
<note_title>${messages.basename}</note_title>
<note_content>
${content}
</note_content>
${additionalContext ? `<user_provided_context>
${additionalContext}
</user_provided_context>` : ''}
</content_to_generate_title_from>`;
      } else {
        // Handle chat messages
        onStatusUpdate?.(20, "Processing chat messages...");

        // Check if there are any messages to process
        if (!messages.length) {
          throw new Error("No chat messages to generate a title from.");
        }

        // Take up to first 25 messages for context
        const messagesToUse = messages.slice(0, 25);
        contentXml = `<content_to_generate_title_from>
${messagesToUse.map(msg => {
  // Handle potential non-string content safely
  let contentStr = '';
  if (typeof msg.content === 'string') {
    contentStr = msg.content;
  } else if (Array.isArray(msg.content)) {
    // Extract text parts from multipart content for title generation context
    contentStr = msg.content
      .filter(part => part.type === 'text')
      // @ts-ignore // We know it's TextContent here
      .map(part => part.text)
      .join('\n');
  }
  return `[${msg.role}]: ${contentStr}`;
}).join('\n')}
${additionalContext ? `\n<user_provided_context>
${additionalContext}
</user_provided_context>` : ''}
</content_to_generate_title_from>`;
      }

      onStatusUpdate?.(40, "Analyzing content...");

      // Get the appropriate prompt content based on context
      const isNoteContext = messages instanceof TFile;
      const systemPromptContent = await this.getTitleGenerationPrompt(isNoteContext);

      // Prepare messages for the AI
      const promptMessages: ChatMessage[] = [
        {
          role: "system",
          content: systemPromptContent,
          message_id: crypto.randomUUID(),
        },
        {
          role: "user",
          content: contentXml,
          message_id: crypto.randomUUID(),
        },
      ];

      // Stream the title generation
      let generatedTitle = "";
      const parsedForStatus = parseCanonicalId(canonicalModelId);
      const statusModelId = parsedForStatus?.modelId || canonicalModelId; // Cleaner model name for status
      onStatusUpdate?.(60, `Generating title using ${statusModelId}${usedFallback ? ' (fallback)' : ''}...`);

      // Set a timeout to prevent hanging
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Title generation timed out after 30 seconds")), 30000);
      });

      // Create the streaming promise
      const streamingPromise = (async () => {
        const stream = this.sculptService.streamMessage({
          messages: promptMessages,
          model: canonicalModelId,
        });
        for await (const event of stream) {
          if (event.type === "content") {
            generatedTitle += event.text;
            if (onProgress) {
              onProgress(generatedTitle.trim());
            }
          }
        }
        return generatedTitle;
      })();

      // Race the streaming against the timeout
      generatedTitle = await Promise.race([streamingPromise, timeoutPromise]);

      onStatusUpdate?.(80, "Finalizing title...");

      // Sanitize and validate the title
      const finalTitle = this.sanitizeTitle(generatedTitle.trim());
      if (!finalTitle) {
        return "Untitled Chat"; // Return a default if generation fails or results in empty string
      }

      return finalTitle;
    } catch (error) {

      // Check if this is a model-related error that we can help the user resolve
      if (error instanceof SystemSculptError && 
          (error.code === ERROR_CODES.MODEL_UNAVAILABLE || error.code === ERROR_CODES.MODEL_REQUEST_ERROR)) {
        
        // Prevent infinite retry loops - max 2 retries
        if (retryCount >= 2) {
          new Notice("Unable to generate title after multiple attempts. Using default title.", 5000);
          return this.isNoteContext(messages) ? "Untitled Note" : "Untitled Chat";
        }

        // Show a generic error and offer model selection
        try {
          const parsedModel = parseCanonicalId(canonicalModelId);
          const modelDisplayName = parsedModel?.modelId || canonicalModelId;
          
          const errorMessage = `The model "${modelDisplayName}" is not available for title generation. This could be because the model is not found, the provider is unavailable, or the model requires different configuration.`;
          
          // Show error and ask if user wants to select a different model
          const wantToSelectModel = await showPopup(
            this.plugin.app,
            errorMessage + "\n\nWould you like to select a different model for title generation?",
            {
              title: "Title Generation Failed",
              primaryButton: "Select Model", 
              secondaryButton: "Cancel",
              icon: "alert-circle"
            }
          );

          if (wantToSelectModel?.confirmed) {
            // Use a Promise to handle the async model selection
            const modelSelectionResult = await new Promise<ModelSelectionResult | null>((resolve) => {
              const modelSelectionModal = new StandardModelSelectionModal({
                app: this.plugin.app,
                plugin: this.plugin,
                currentModelId: this.plugin.settings.titleGenerationModelId || this.plugin.settings.selectedModelId || "",
                onSelect: async (result: ModelSelectionResult) => {
                  if (result && result.modelId) {
                    // Save the new model selection
                    const parsed = parseCanonicalId(result.modelId);
                    if (parsed) {
                      await this.plugin.getSettingsManager().updateSettings({
                        titleGenerationProviderId: parsed.providerId,
                        titleGenerationModelId: result.modelId
                      });
                      new Notice(`Title generation model set to: ${parsed.providerId} / ${parsed.modelId}`);
                    }
                    resolve(result);
                  } else {
                    resolve(null);
                  }
                }
              });

              // Open the modal
              modelSelectionModal.open();
            });
            
            if (modelSelectionResult && modelSelectionResult.modelId) {
              // User selected a new model, retry generation
              return await this.generateTitle(messages, onProgress, onStatusUpdate, additionalContext, retryCount + 1);
            } else {
              // User cancelled model selection
              new Notice("Title generation cancelled. Using default title.", 3000);
              return this.isNoteContext(messages) ? "Untitled Note" : "Untitled Chat";
            }
          } else {
            // User chose not to select a model
            new Notice("Title generation cancelled. Using default title.", 3000);
            return this.isNoteContext(messages) ? "Untitled Note" : "Untitled Chat";
          }
        } catch (modalError) {
          // Fall back to the original error handling
          new Notice(`Title generation failed: ${error.message}`, 5000);
          throw error;
        }
      } else {
        // For non-model errors, use the original error handling
        const errorMessage = error instanceof Error
          ? error.message
          : "Unknown error occurred";

        new Notice(`Title generation failed: ${errorMessage}`, 5000);
        throw error;
      }
    }
  }
}
