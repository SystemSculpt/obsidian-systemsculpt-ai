import { App, TFile, TFolder, normalizePath, Notice } from "obsidian";
import SystemSculptPlugin from "../../../main";
import { 
  ManageWorkspaceParams, 
  ManageContextParams, 
  WorkspaceManagementResult,
  ContextManagementResult
} from "../types";
import { FILESYSTEM_LIMITS } from "../constants";
import { getFilesFromFolder, normalizeVaultPath } from "../utils";
import { openFileInMainWorkspace } from '../../../utils/workspaceUtils';

/**
 * Management operations for MCP Filesystem tools (workspace, context)
 */
export class ManagementOperations {
  constructor(
    private app: App,
    private plugin: SystemSculptPlugin,
    private allowedPaths: string[]
  ) {}

  /**
   * Manage workspace by opening files with intelligent placement
   */
  async manageWorkspace(params: ManageWorkspaceParams): Promise<WorkspaceManagementResult> {
    const { files } = params;
    const opened: string[] = [];
    const errors: string[] = [];
    const currentLeaf = this.app.workspace.activeLeaf;
    let shouldRestoreFocus = true;

    for (const file of files) {
      const filePath = normalizePath(normalizeVaultPath(file.path));
      const { leaf, action } = await openFileInMainWorkspace(this.app, filePath);

      if (leaf) {
        opened.push(filePath);
        // If any file action was just a tab switch, don't restore focus to chat
        if (action === 'switched_in_pane') {
          shouldRestoreFocus = false;
        }
      } else {
        // The utility function now handles its own console warnings for not found/not a file
        errors.push(`Failed to open file: ${filePath}`);
      }
    }
    
    // Restore focus to original leaf only if it existed and we didn't just switch tabs
    if (currentLeaf && shouldRestoreFocus) {
        this.app.workspace.setActiveLeaf(currentLeaf, { focus: true });
    }

    return { opened, errors };
  }

  /**
   * Manage context by adding or removing files from the current chat's context window
   */
  async manageContext(params: ManageContextParams): Promise<ContextManagementResult> {
    const { action, paths } = params;
    
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error("The 'paths' parameter must be a non-empty array of file or directory paths");
    }

    if (paths.length > 10) {
      throw new Error("Maximum 10 paths allowed per request to prevent context overflow");
    }

    const MAX_FILES_PER_REQUEST = FILESYSTEM_LIMITS.MAX_FILES_PER_REQUEST;
    const results: Array<{path: string; success: boolean; reason?: string}> = [];
    let totalFilesProcessed = 0;
    
    // Get the current active chat view to access its context manager
    const currentChatView = this.getCurrentChatView();
    if (!currentChatView) {
      throw new Error("No active chat view found. This tool can only be used from within a chat conversation.");
    }

    if (action === "add") {
      // Handle adding files to context
      let filesInCurrentRequest = 0;
      
      for (const path of paths) {
        try {
          const normalized = normalizePath(normalizeVaultPath(path));
          const abstractFile = this.app.vault.getAbstractFileByPath(normalized);
          
          if (!abstractFile) {
            results.push({ path, success: false, reason: "File or directory not found" });
            continue;
          }

          if (abstractFile instanceof TFolder) {
            // Get all files in the directory recursively
            const folderFiles = getFilesFromFolder(abstractFile);
            
            if (folderFiles.length > MAX_FILES_PER_REQUEST) {
              results.push({ 
                path, 
                success: false, 
                reason: `Directory contains ${folderFiles.length} files, which exceeds the limit of ${MAX_FILES_PER_REQUEST} files per request. Please specify individual files instead.` 
              });
              continue;
            }

            // Check if we can add all files without exceeding the limit
            if (filesInCurrentRequest + folderFiles.length > MAX_FILES_PER_REQUEST) {
              const remainingSlots = MAX_FILES_PER_REQUEST - filesInCurrentRequest;
              results.push({ 
                path, 
                success: false, 
                reason: `Cannot add ${folderFiles.length} files from directory. Only ${remainingSlots} slots remaining in this request.` 
              });
              continue;
            }

            // Add files from directory using the existing DocumentContextManager
            const { DocumentContextManager } = await import("../../../services/DocumentContextManager");
            const documentContextManager = DocumentContextManager.getInstance(this.app, this.plugin);
            
            const addedCount = await documentContextManager.addFilesToContext(
              folderFiles, 
              currentChatView.contextManager, 
              {
                showNotices: false,
                saveChanges: false, // We'll save once at the end
                maxFiles: 100 // Use the global context limit
              }
            );

            if (addedCount > 0) {
              results.push({ path, success: true });
              filesInCurrentRequest += addedCount;
              totalFilesProcessed += addedCount;
            } else {
              results.push({ path, success: false, reason: "No files were added from directory" });
            }

          } else if (abstractFile instanceof TFile) {
            // Check if we've reached the per-request limit
            if (filesInCurrentRequest >= MAX_FILES_PER_REQUEST) {
              results.push({ 
                path, 
                success: false, 
                reason: "Reached maximum of 10 files per request" 
              });
              continue;
            }

            // Add individual file using DocumentContextManager
            const { DocumentContextManager } = await import("../../../services/DocumentContextManager");
            const documentContextManager = DocumentContextManager.getInstance(this.app, this.plugin);
            
            const success = await documentContextManager.addFileToContext(
              abstractFile, 
              currentChatView.contextManager, 
              {
                showNotices: false,
                saveChanges: false // We'll save once at the end
              }
            );

            if (success) {
              results.push({ path, success: true });
              filesInCurrentRequest++;
              totalFilesProcessed++;
            } else {
              results.push({ path, success: false, reason: "Failed to add file to context (may already be in context)" });
            }
          }

        } catch (error) {
          results.push({ 
            path, 
            success: false, 
            reason: error.message || "Unknown error occurred" 
          });
        }
      }

      // Save changes once at the end
      if (totalFilesProcessed > 0) {
        await currentChatView.contextManager.triggerContextChange();
      }

    } else if (action === "remove") {
      // Handle removing files from context
      for (const path of paths) {
        try {
          // Normalize the path to match how files are stored in context
          const normalized = normalizePath(normalizeVaultPath(path));
          const wikiLink = `[[${normalized}]]`;
          const hasFile = currentChatView.contextManager.hasContextFile(wikiLink) || 
                         currentChatView.contextManager.hasContextFile(normalized);

          if (hasFile) {
            // Remove from context using the new public method
            const removed = await currentChatView.contextManager.removeFromContextFiles(normalized);
            if (removed) {
              results.push({ path, success: true });
              totalFilesProcessed++;
            } else {
              results.push({ 
                path, 
                success: false, 
                reason: "Failed to remove file from context" 
              });
            }
          } else {
            results.push({ 
              path, 
              success: false, 
              reason: "File not found in current context" 
            });
          }
        } catch (error) {
          results.push({ 
            path, 
            success: false, 
            reason: error.message || "Unknown error occurred" 
          });
        }
      }
    } else {
      throw new Error("Invalid action. Must be 'add' or 'remove'");
    }

    // Generate summary
    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;
    
    let summary = `Context management completed: ${action} operation processed ${totalFilesProcessed} files. `;
    summary += `${successCount} paths succeeded, ${failureCount} paths failed.`;
    
    if (action === 'add' && totalFilesProcessed > 0) {
      const currentCount = currentChatView.contextManager.getContextFiles().size;
      summary += ` Current context: ${currentCount} files total.`;
    }

    return {
      action,
      processed: totalFilesProcessed,
      results,
      summary
    };
  }

  /**
   * Get the current active chat view
   */
  private getCurrentChatView(): any {
    // Find the active chat view by looking for the chat view type
    const leaves = this.app.workspace.getLeavesOfType("systemsculpt-chat-view");
    
    // Return the active chat view if one exists
    for (const leaf of leaves) {
      if (leaf === this.app.workspace.activeLeaf) {
        return leaf.view;
      }
    }
    
    // If no active chat view, return the first one found
    if (leaves.length > 0) {
      return leaves[0].view;
    }
    
    return null;
  }
}
