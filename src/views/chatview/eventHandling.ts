import { ChatView } from "./ChatView";
import { TFile, TFolder, Notice } from "obsidian";
import { showPopup, showAlert } from "../../core/ui/";
import { LICENSE_URL } from "../../types";
import { DocumentContextManager } from "../../services/DocumentContextManager";

interface SearchResultData {
  type: 'search-results';
  results: Array<{
    path: string;
    score?: number;
    title?: string;
  }>;
  query?: string;
}

interface FolderData {
  type: 'folder';
  path: string;
  name: string;
}

interface SimilarNoteData {
  type: 'similar-note';
  path: string;
  title: string;
  score: number;
  source: string;
}

interface DragHandlers {
  dragenter: (e: DragEvent) => void;
  dragleave: (e: DragEvent) => void;
  dragover: (e: DragEvent) => void;
  drop: (e: DragEvent) => void;
}

export const eventHandling = {
  setupDragAndDrop: function(chatView: ChatView, container: HTMLElement): () => void {
    const overlay = container.createEl("div", { cls: "systemsculpt-drag-overlay" });
    const message = overlay.createEl("div", { cls: "systemsculpt-drag-message", text: "Drop files, folders, or search results to add to context" });
    const detailMessage = overlay.createEl("div", { cls: "systemsculpt-drag-detail", text: "" });
    const MAX_FILES = 100;
    const isFolder = (file: any): file is TFolder => !!file && Array.isArray((file as any).children);
    const isFile = (file: any): file is TFile => !!file && typeof (file as any).extension === "string";

    const parseObsidianUri = (uri: string): string | null => {
      try {
        if (!uri.startsWith("obsidian://open")) return null;
        const url = new URL(uri);
        const filePath = url.searchParams.get("file");
        if (!filePath) return null;
        
        // Handle URL encoding properly
        const decodedPath = decodeURIComponent(filePath);
        return decodedPath;
      } catch (e) {
        return null;
      }
    };

    const getFilesFromFolder = (folder: TFolder): TFile[] => {
      const files: TFile[] = [];
      const processFolder = (currentFolder: TFolder) => {
        for (const child of currentFolder.children) {
          if (isFile(child)) files.push(child);
          else if (isFolder(child)) processFolder(child);
        }
      };
      processFolder(folder);
      return files.slice(0, MAX_FILES);
    };

    const parseSearchResults = (text: string): SearchResultData | null => {
      try {
        // Try to parse as JSON first (for programmatic search results)
        const data = JSON.parse(text);
        if (data.type === 'search-results' && Array.isArray(data.results)) {
          return data as SearchResultData;
        }
      } catch {
        // Not JSON, check for structured search results
      }

      // Check for search result patterns - must have multiple lines or specific formats
      const lines = text.split('\n').filter(line => line.trim());
      
      // Only consider as search results if we have multiple lines OR specific search result patterns
      if (lines.length < 2) {
        // Single line - check if it looks like a search result (has score or title-path format)
        const line = lines[0];
        const scoreMatch = line?.match(/^(.+?)\s+\((\d+(?:\.\d+)?)%?\)$/);
        const titlePathMatch = line?.match(/^(.+?)\s+-\s+(.+)$/);
        
        if (!scoreMatch && !titlePathMatch) {
          // Single line without search result patterns - not search results
          return null;
        }
      }
      
      const searchResults: Array<{path: string; score?: number; title?: string}> = [];
      
      for (const line of lines) {
        // Pattern: "path (score%)" or "title - path" or just "path"
        const scoreMatch = line.match(/^(.+?)\s+\((\d+(?:\.\d+)?)%?\)$/);
        const titlePathMatch = line.match(/^(.+?)\s+-\s+(.+)$/);
        
        if (scoreMatch) {
          const [, path, scoreStr] = scoreMatch;
          const score = parseFloat(scoreStr) / 100;
          searchResults.push({ path: path.trim(), score });
        } else if (titlePathMatch) {
          const [, title, path] = titlePathMatch;
          searchResults.push({ path: path.trim(), title: title.trim() });
        } else if (line.trim()) {
          // Simple path - only if we have multiple lines
          if (lines.length > 1) {
            searchResults.push({ path: line.trim() });
          }
        }
      }

      if (searchResults.length > 0) {
        return {
          type: 'search-results',
          results: searchResults
        };
      }

      return null;
    };

    const parseFolderData = (text: string): FolderData | null => {
      try {
        const data = JSON.parse(text);
        if (data.type === 'folder' && data.path) {
          return data as FolderData;
        }
      } catch {
        // Not JSON
      }
      return null;
    };

    const parseSimilarNoteData = (dt: DataTransfer): SimilarNoteData | null => {
      try {
        const similarNoteData = dt.getData('application/x-systemsculpt-similar-note');
        if (similarNoteData) {
          const data = JSON.parse(similarNoteData);
          if (data.source === 'similar-notes' && data.path) {
            return {
              type: 'similar-note',
              path: data.path,
              title: data.title || data.path.split('/').pop() || data.path,
              score: data.score || 0,
              source: data.source
            } as SimilarNoteData;
          }
        }
      } catch {
        // Not valid similar note data
      }
      return null;
    };

    const getFileCount = async (dt: DataTransfer): Promise<{count: number; type: string; details?: string}> => {
      const currentContextSize = chatView.contextManager.getContextFiles().size;
      if (currentContextSize >= MAX_FILES) return {count: 0, type: 'limit-reached'};
      const remainingSlots = MAX_FILES - currentContextSize;

      // Check for similar note first
      const similarNote = parseSimilarNoteData(dt);
      if (similarNote) {
        const file = chatView.app.vault.getAbstractFileByPath(similarNote.path);
        if (isFile(file)) {
          const scorePercent = Math.round(similarNote.score * 100);
          return {
            count: 1,
            type: 'similar-note',
            details: `Similar note: "${similarNote.title}" (${scorePercent}% match)`
          };
        }
        return {count: 0, type: 'similar-note-not-found'};
      }

      let newFileCount = 0;
      let filesToProcess: (TFile | TFolder)[] = [];
      let contentType = 'files';
      let details = '';

      if (dt.items && dt.items.length > 0) {
        for (const item of Array.from(dt.items)) {
          if (item.type === "text/plain") {
            const text = await new Promise<string>((resolve) => item.getAsString(resolve));
            
            // First, check if it's a direct folder path by trying to resolve it
            const lines = text.split("\n").filter((line) => line.trim());
            if (lines.length === 1) {
              const singlePath = lines[0].trim();
              let abstractFile = null;
              
              if (singlePath.startsWith("obsidian://")) {
                const filePath = parseObsidianUri(singlePath);
                if (filePath) {
                  abstractFile = chatView.app.vault.getAbstractFileByPath(filePath);
                  
                  // If not found, try with .md extension
                  if (!abstractFile && !filePath.endsWith('.md')) {
                    const mdPath = `${filePath}.md`;
                    abstractFile = chatView.app.vault.getAbstractFileByPath(mdPath);
                  }
                }
              } else {
                // Try direct path first
                abstractFile = chatView.app.vault.getAbstractFileByPath(singlePath);
                
                // If not found and it's just a name (no path separators), search for folder by name
                if (!abstractFile && !singlePath.includes("/") && !singlePath.includes("\\")) {
                  // Search all folders in the vault
                  const allFolders = chatView.app.vault.getAllLoadedFiles().filter(isFolder);
                  abstractFile = allFolders.find(f => f.name === singlePath);
                }
              }
              
              if (isFolder(abstractFile)) {
                contentType = 'folder';
                details = `Folder: "${abstractFile.name}"`;
                filesToProcess.push(abstractFile);
                break; // Process folder exclusively
              } else if (isFile(abstractFile)) {
                contentType = 'files';
                filesToProcess.push(abstractFile);
                break; // Process file exclusively
              }
            }
            
            // Check for search results (after folder check)
            const searchData = parseSearchResults(text);
            if (searchData) {
              contentType = 'search-results';
              details = searchData.query ? `Query: "${searchData.query}"` : '';
              for (const result of searchData.results) {
                const abstractFile = chatView.app.vault.getAbstractFileByPath(result.path);
                if (isFile(abstractFile)) {
                  filesToProcess.push(abstractFile);
                } else if (!result.path.includes(".")) {
                  const mdPath = `${result.path}.md`;
                  const mdFile = chatView.app.vault.getAbstractFileByPath(mdPath);
                  if (isFile(mdFile)) filesToProcess.push(mdFile);
                }
              }
              break; // Process search results exclusively
            }

            // Check for folder data (JSON format)
            const folderData = parseFolderData(text);
            if (folderData) {
              const folder = chatView.app.vault.getAbstractFileByPath(folderData.path);
              if (isFolder(folder)) {
                contentType = 'folder';
                details = `Folder: "${folderData.name || folder.name}"`;
                filesToProcess.push(folder);
                break;
              }
            }

            // Standard processing for individual files/paths
            for (const line of lines) {
              let filePath = line;
              let abstractFile = null;
              if (line.startsWith("obsidian://")) filePath = parseObsidianUri(line) || line;
              abstractFile = chatView.app.vault.getAbstractFileByPath(filePath);
              if (isFolder(abstractFile)) {
                filesToProcess.push(abstractFile);
                contentType = 'folder';
                details = `Folder: "${abstractFile.name}"`;
              } else if (isFile(abstractFile)) {
                filesToProcess.push(abstractFile);
              } else if (!filePath.includes(".")) {
                const mdPath = `${filePath}.md`;
                const mdFile = chatView.app.vault.getAbstractFileByPath(mdPath);
                if (isFile(mdFile)) filesToProcess.push(mdFile);
              }
            }
          }
        }
      }

      for (const item of filesToProcess) {
        if (isFolder(item)) newFileCount += getFilesFromFolder(item).length;
        else if (isFile(item)) newFileCount++;
      }

      if (newFileCount === 0 && dt.types.includes("text/uri-list")) {
        const uriData = await new Promise<string>((resolve) => dt.items[1].getAsString(resolve));
        const uris = uriData.split("obsidian://open").filter((uri) => uri.trim()).map((uri) => "obsidian://open" + uri.trim());
        for (const uri of uris) {
          const filePath = parseObsidianUri(uri);
          if (!filePath) continue;
          const abstractFile = chatView.app.vault.getAbstractFileByPath(filePath);
          if (isFolder(abstractFile)) newFileCount += getFilesFromFolder(abstractFile).length;
          else if (isFile(abstractFile)) newFileCount++;
        }
      }
      
      return {
        count: Math.min(newFileCount, remainingSlots),
        type: contentType,
        details
      };
    };

    const updateMessage = async (dt: DataTransfer) => {
      const currentContextSize = chatView.contextManager.getContextFiles().size;
      if (currentContextSize >= MAX_FILES) {
        message.textContent = `Cannot add more files (max ${MAX_FILES} reached)`;
        detailMessage.textContent = '';
        container.removeAttribute('data-drag-type');
        return;
      }
      
      const fileInfo = await getFileCount(dt);
      if (fileInfo.count > 0) {
        const typeLabel = fileInfo.type === 'search-results' ? 'search results' : 
                         fileInfo.type === 'folders' ? 'multiple folders' :
                         fileInfo.type === 'folder' ? 'folder contents' :
                         fileInfo.type === 'similar-note' ? 'similar notes' : 'files';
        
        if (fileInfo.type === 'similar-note') {
          message.textContent = `Add similar note to context (${currentContextSize + fileInfo.count}/${MAX_FILES} total)`;
        } else {
          message.textContent = `Add ${fileInfo.count} file${fileInfo.count > 1 ? "s" : ""} from ${typeLabel} (${currentContextSize + fileInfo.count}/${MAX_FILES} total)`;
        }
        
        detailMessage.textContent = fileInfo.details || '';
        container.setAttribute('data-drag-type', fileInfo.type);
      } else {
        message.textContent = `Drop files, folders, or search results to add to context (${currentContextSize}/${MAX_FILES})`;
        detailMessage.textContent = '';
        container.removeAttribute('data-drag-type');
      }
    };

    let dragCounter = 0;
    let dragOverTimeout: NodeJS.Timeout | null = null;
    const handlers: DragHandlers = {
      dragenter: (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter++;
        if (dragCounter === 1) {
          container.addClass("systemsculpt-drag-active");
          if (e.dataTransfer) updateMessage(e.dataTransfer);
        }
      },

      dragleave: (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter--;
        if (dragCounter === 0) {
          container.removeClass("systemsculpt-drag-active");
          container.removeAttribute('data-drag-type');
        }
      },

      dragover: async (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Debounce the message updates to improve performance
        if (dragOverTimeout) clearTimeout(dragOverTimeout);
        dragOverTimeout = setTimeout(async () => {
          if (e.dataTransfer) await updateMessage(e.dataTransfer);
        }, 100);
      },

      drop: async (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter = 0;
        container.removeClass("systemsculpt-drag-active");
        container.removeAttribute('data-drag-type');

        const dt = e.dataTransfer;
        if (!dt) return;

        const startingContextSize = chatView.contextManager.getContextFiles().size;
        if (startingContextSize >= MAX_FILES) {
          await showAlert(chatView.app, `Cannot add more files (max ${MAX_FILES} reached)`, { type: "info", icon: "alert-triangle" });
          return;
        }

        try {
          // Check for similar note first
          const similarNote = parseSimilarNoteData(dt);
          if (similarNote) {
            const file = chatView.app.vault.getAbstractFileByPath(similarNote.path);
            if (isFile(file)) {
              // Get the DocumentContextManager instance
              const documentContextManager = DocumentContextManager.getInstance(chatView.app, chatView.plugin);
              
              // Add file to context without showing the default notice
              await documentContextManager.addFileToContext(file, chatView.contextManager, {
                showNotices: false, // Disable default notice to avoid duplication
                saveChanges: true
              });
              
              // Show custom notice with similarity score
              const scorePercent = Math.round(similarNote.score * 100);
              new Notice(`Added "${similarNote.title}" (${scorePercent}% match) to context`, 3000);
              return;
            } else {
              new Notice(`Similar note not found: ${similarNote.path}`, 4000);
              return;
            }
          }

          let filesToProcess: (TFile | TFolder)[] = [];
          let dropType = 'files';
          let dropDetails = '';

          if (dt.items && dt.items.length > 0) {
            for (const item of Array.from(dt.items)) {
              if (item.type === "text/plain") {
                const text = await new Promise<string>((resolve) => item.getAsString(resolve));
                
                // First, check if it's a direct folder path by trying to resolve it
                const lines = text.split("\n").filter((line) => line.trim());
                if (lines.length === 1) {
                  const singlePath = lines[0].trim();
                  let abstractFile = null;
                  
                  
                  if (singlePath.startsWith("obsidian://")) {
                    const filePath = parseObsidianUri(singlePath);
                    if (filePath) {
                      abstractFile = chatView.app.vault.getAbstractFileByPath(filePath);
                      
                      // If not found, try with .md extension
                      if (!abstractFile && !filePath.endsWith('.md')) {
                        const mdPath = `${filePath}.md`;
                        abstractFile = chatView.app.vault.getAbstractFileByPath(mdPath);
                      }
                    }
                  } else {
                    // Try direct path first
                    abstractFile = chatView.app.vault.getAbstractFileByPath(singlePath);
                    
                    // If not found and it's just a name (no path separators), search for folder by name
                    if (!abstractFile && !singlePath.includes("/") && !singlePath.includes("\\")) {
                      // Search all folders in the vault
                      const allFolders = chatView.app.vault.getAllLoadedFiles().filter(isFolder);
                      abstractFile = allFolders.find(f => f.name === singlePath);
                    }
                  }
                  
                  if (isFolder(abstractFile)) {
                    dropType = 'folder';
                    dropDetails = `Folder: "${abstractFile.name}"`;
                    filesToProcess.push(abstractFile);
                    break; // Process folder exclusively
                  } else if (isFile(abstractFile)) {
                    dropType = 'files';
                    filesToProcess.push(abstractFile);
                    break; // Process file exclusively
                  }
                }
                
                // Check for search results (after folder check to avoid false positives)
                const searchData = parseSearchResults(text);
                if (searchData) {
                  dropType = 'search-results';
                  dropDetails = searchData.query ? `Search: "${searchData.query}"` : 'Search results';
                  
                  for (const result of searchData.results) {
                    const abstractFile = chatView.app.vault.getAbstractFileByPath(result.path);
                    if (isFile(abstractFile)) {
                      filesToProcess.push(abstractFile);
                    } else if (!result.path.includes(".")) {
                      const mdPath = `${result.path}.md`;
                      const mdFile = chatView.app.vault.getAbstractFileByPath(mdPath);
                      if (isFile(mdFile)) filesToProcess.push(mdFile);
                    }
                  }
                  break; // Process search results exclusively
                }

                // Check for folder data (JSON format)
                const folderData = parseFolderData(text);
                if (folderData) {
                  const folder = chatView.app.vault.getAbstractFileByPath(folderData.path);
                  if (isFolder(folder)) {
                    dropType = 'folder';
                    dropDetails = `Folder: "${folderData.name || folder.name}"`;
                    filesToProcess.push(folder);
                    break;
                  }
                }

                // Standard processing for individual files/paths
                let folderCount = 0;
                for (const line of lines) {
                  let filePath = line;
                  let abstractFile = null;
                  if (line.startsWith("obsidian://")) filePath = parseObsidianUri(line) || line;
                  abstractFile = chatView.app.vault.getAbstractFileByPath(filePath);
                  if (isFolder(abstractFile)) {
                    filesToProcess.push(abstractFile);
                    folderCount++;
                    dropType = folderCount > 1 ? 'folders' : 'folder';
                    dropDetails = folderCount > 1 ? `${folderCount} folders` : `Folder: "${abstractFile.name}"`;
                  } else if (isFile(abstractFile)) {
                    const extension = abstractFile.extension.toLowerCase();
                    const requiresPro = ["pdf", "doc", "docx", "mp3", "wav", "m4a", "ogg", "webm"].includes(extension);
                    if (
                      requiresPro &&
                      (!chatView.plugin.settings.licenseKey?.trim() || !chatView.plugin.settings.licenseValid)
                    ) {
                      await showPopup(chatView.app, "Document processing is a Pro feature...", { title: "Pro Feature", primaryButton: "Get License", secondaryButton: "Maybe Later" })
                        .then((result) => { if (result?.confirmed) window.open(LICENSE_URL, "_blank"); });
                      return;
                    }
                    filesToProcess.push(abstractFile);
                  } else if (!filePath.includes(".")) {
                    const mdPath = `${filePath}.md`;
                    const mdFile = chatView.app.vault.getAbstractFileByPath(mdPath);
                    if (isFile(mdFile)) filesToProcess.push(mdFile);
                  }
                }
              }
            }
          }

          if (filesToProcess.length === 0 && dt.types.includes("text/uri-list")) {
            const uriData = await new Promise<string>((resolve) => dt.items[1].getAsString(resolve));
            const uris = uriData.split("obsidian://open").filter((uri) => uri.trim()).map((uri) => "obsidian://open" + uri.trim());
            for (const uri of uris) {
              const filePath = parseObsidianUri(uri);
              if (!filePath) continue;
              let abstractFile = chatView.app.vault.getAbstractFileByPath(filePath);
              if (isFile(abstractFile)) {
                const extension = abstractFile.extension.toLowerCase();
                const requiresPro = ["pdf", "doc", "docx", "mp3", "wav", "m4a", "ogg", "webm"].includes(extension);
                if (
                  requiresPro &&
                  (!chatView.plugin.settings.licenseKey?.trim() || !chatView.plugin.settings.licenseValid)
                ) {
                  await showPopup(chatView.app, "Document processing is a Pro feature...", { title: "Pro Feature", primaryButton: "Get License", secondaryButton: "Maybe Later" })
                    .then((result) => { if (result?.confirmed) window.open(LICENSE_URL, "_blank"); });
                  return;
                }
              }
              if (isFile(abstractFile) || isFolder(abstractFile)) filesToProcess.push(abstractFile);
            }
          }

          let totalFilesAdded = 0;
          const remainingSlots = MAX_FILES - startingContextSize;

          // Get the DocumentContextManager instance
          const documentContextManager = DocumentContextManager.getInstance(chatView.app, chatView.plugin);

          // Process all files

          // Separate files and folders
          const folders = filesToProcess.filter(isFolder) as TFolder[];
          const files = filesToProcess.filter(isFile) as TFile[];

          // Process folders first
          for (const folder of folders) {
            const folderFiles = getFilesFromFolder(folder);

            // Check license for pro features
            const proFiles = folderFiles.filter(file => {
              const extension = file.extension.toLowerCase();
              return ["pdf", "doc", "docx", "mp3", "wav", "m4a", "ogg", "webm"].includes(extension);
            });

            if (proFiles.length > 0 && (!chatView.plugin.settings.licenseKey?.trim() || !chatView.plugin.settings.licenseValid)) {
              await showPopup(chatView.app, "Document processing is a Pro feature...", {
                title: "Pro Feature",
                primaryButton: "Get License",
                secondaryButton: "Maybe Later"
              }).then((result) => {
                if (result?.confirmed) window.open(LICENSE_URL, "_blank");
              });
              continue;
            }

            // Add files to context
            const addedCount = await documentContextManager.addFilesToContext(folderFiles, chatView.contextManager, {
              showNotices: true,
              saveChanges: true,
              maxFiles: MAX_FILES
            });

            totalFilesAdded += addedCount;
          }

          // Process individual files
          if (files.length > 0) {

            // Check license for pro features
            const proFiles = files.filter(file => {
              const extension = file.extension.toLowerCase();
              return ["pdf", "doc", "docx", "mp3", "wav", "m4a", "ogg", "webm"].includes(extension);
            });

            if (proFiles.length > 0 && (!chatView.plugin.settings.licenseKey?.trim() || !chatView.plugin.settings.licenseValid)) {
              await showPopup(chatView.app, "Document processing is a Pro feature...", {
                title: "Pro Feature",
                primaryButton: "Get License",
                secondaryButton: "Maybe Later"
              }).then((result) => {
                if (result?.confirmed) window.open(LICENSE_URL, "_blank");
              });
              return;
            }

            // Add files to context
            const addedCount = await documentContextManager.addFilesToContext(files, chatView.contextManager, {
              showNotices: true,
              saveChanges: true,
              maxFiles: MAX_FILES
            });

            totalFilesAdded += addedCount;
          }

          // Show success message with specific context
          if (totalFilesAdded > 0) {
            const contextMessage = dropType === 'search-results' ? 'from search results' :
                                  dropType === 'folders' ? 'from multiple folders' :
                                  dropType === 'folder' ? 'from folder' : '';
            new Notice(`Added ${totalFilesAdded} file${totalFilesAdded > 1 ? 's' : ''} to context ${contextMessage}`, 3000);
          } else if ((dropType === 'folder' || dropType === 'folders') && filesToProcess.length > 0) {
            // Empty folder case
            const folderNames = filesToProcess
              .filter(isFolder)
              .map(folder => (folder as TFolder).name);
            
            if (folderNames.length === 1) {
              new Notice(`The "${folderNames[0]}" folder is empty - no files to add to context`, 4000);
            } else if (folderNames.length > 1) {
              new Notice(`The selected folders are empty - no files to add to context`, 4000);
            }
          }

        } catch (error) {
          await showAlert(chatView.app, "Failed to process dropped files", { type: "error" });
        }
      }
    };

    // Add event listeners
    container.addEventListener("dragenter", handlers.dragenter);
    container.addEventListener("dragleave", handlers.dragleave);
    container.addEventListener("dragover", handlers.dragover);
    container.addEventListener("drop", handlers.drop);

    // Return a cleanup function
    return () => {
      container.removeEventListener("dragenter", handlers.dragenter);
      container.removeEventListener("dragleave", handlers.dragleave);
      container.removeEventListener("dragover", handlers.dragover);
      container.removeEventListener("drop", handlers.drop);
      
      // Clean up timeout
      if (dragOverTimeout) {
        clearTimeout(dragOverTimeout);
        dragOverTimeout = null;
      }
    };
  }
};
