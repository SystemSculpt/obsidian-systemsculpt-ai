import { App, TFile, MarkdownView, Modal, TFolder } from "obsidian";
import { DocumentExtractor } from "./DocumentExtractor";
import { base64ToArrayBuffer } from "obsidian";

export class ContextFileManager {
  constructor(
    private app: App,
    private chatView: any
  ) {}

  private processingQueue: TFile[] = [];
  private isProcessing: boolean = false;

  async addFileToContextFiles(file: TFile) {
    this.processingQueue.push(file);
    if (!this.isProcessing) {
      await this.processQueue();
    }
  }

  private async processQueue() {
    this.isProcessing = true;
    while (this.processingQueue.length > 0) {
      const file = this.processingQueue.shift();
      if (file) {
        await this.processFile(file);
      }
    }
    this.isProcessing = false;
  }

  private async processFile(file: TFile) {
    const supportedExtensions = [
      "md",
      "pdf",
      "docx",
      "pptx",
      "png",
      "jpg",
      "jpeg",
      "gif",
      "mp3",
      "wav",
      "m4a",
      "ogg",
    ];
    const fileExtension = file.extension.toLowerCase();

    if (supportedExtensions.includes(fileExtension)) {
      const existingFile = this.chatView.contextFiles.find(
        (contextFile: TFile) => contextFile.path === file.path
      );

      if (existingFile) {
        const existingHash =
          await this.chatView.chatModule.calculateMD5(existingFile);
        const newHash = await this.chatView.chatModule.calculateMD5(file);

        if (existingHash === newHash) {
          this.chatView.updateLoadingText(
            `File ${file.name} is already in the context files.`
          );
          return;
        } else {
          // Automatically replace the existing file
          const index = this.chatView.contextFiles.indexOf(existingFile);
          this.chatView.contextFiles[index] = file;
        }
      } else {
        this.chatView.contextFiles.push(file);
      }

      this.renderContextFiles();
      await this.updateChatFileWithContext(file, "add");

      if (["mp3", "wav", "m4a", "ogg"].includes(fileExtension)) {
        await this.processAudioFile(file);
      } else if (["pdf", "docx", "pptx"].includes(fileExtension)) {
        await this.processDocument(file);
      }
    } else {
      const supportedExtensionsString = supportedExtensions.join(", ");
      this.chatView.updateLoadingText(
        `We don't handle ${fileExtension} files yet. We only support ${supportedExtensionsString} files.`
      );
    }

    this.chatView.updateTokenCount();
  }

  private async processAudioFile(file: TFile) {
    this.chatView.updateLoadingText(`Processing audio file: ${file.name}`);
    try {
      const extractionFolderPath = `${file.parent?.path || ""}/${file.basename}`;
      const transcriptionFileName = "extracted_content.md";
      const transcriptionFilePath = `${extractionFolderPath}/${transcriptionFileName}`;

      const transcriptionFileExists = await this.app.vault.adapter.exists(
        transcriptionFilePath
      );

      if (transcriptionFileExists) {
        const userChoice = await this.showTranscriptionExistsDialog(file.name);

        if (userChoice === "use-existing") {
          const existingTranscriptionFile =
            this.app.vault.getAbstractFileByPath(
              transcriptionFilePath
            ) as TFile;
          if (existingTranscriptionFile) {
            this.chatView.contextFiles.push(existingTranscriptionFile);
            this.renderContextFiles();
            await this.updateChatFileWithContext(
              existingTranscriptionFile,
              "add"
            );
            this.chatView.updateLoadingText(
              `Using existing transcription for: ${file.name}`
            );
            return;
          }
        } else if (userChoice === "cancel") {
          this.chatView.updateLoadingText(
            `Cancelled processing of: ${file.name}`
          );
          return;
        }
        // If 'transcribe-again' is chosen, we'll continue with the transcription process
      }

      const arrayBuffer = await this.app.vault.readBinary(file);
      const transcription =
        await this.chatView.chatModule.recorderModule.handleTranscription(
          arrayBuffer,
          file,
          true
        );

      await this.app.vault.createFolder(extractionFolderPath).catch(() => {}); // Create folder if it doesn't exist

      const transcriptionContent = `# Transcription of ${file.name}\n\n${transcription}\n\n[Original Audio File](${file.path})`;
      await this.app.vault.create(transcriptionFilePath, transcriptionContent);

      this.chatView.updateLoadingText(`Audio file transcribed: ${file.name}`);

      // Add the transcription file to the context files
      const transcriptionFile = this.app.vault.getAbstractFileByPath(
        transcriptionFilePath
      ) as TFile;
      if (transcriptionFile) {
        this.chatView.contextFiles.push(transcriptionFile);
        this.renderContextFiles();
        await this.updateChatFileWithContext(transcriptionFile, "add");
      }
    } catch (error) {
      this.chatView.updateLoadingText(
        `Error processing audio file: ${error instanceof Error ? error.message : "Unknown error"}`
      );
      console.error("Error processing audio file:", error);
    }
  }

  private async showTranscriptionExistsDialog(
    fileName: string
  ): Promise<"use-existing" | "transcribe-again" | "cancel"> {
    return new Promise((resolve) => {
      const modal = new TranscriptionExistsModal(
        this.app,
        fileName,
        (result) => {
          resolve(result);
        }
      );
      modal.open();
    });
  }

  public async processDocument(file: TFile) {
    console.log(`Starting document processing for file: ${file.path}`);
    try {
      const documentExtractor = new DocumentExtractor(
        this.chatView.chatModule,
        this.app
      );
      console.log(`Document extractor created`);
      const extractedContent = await documentExtractor.extractDocument(file);
      console.log(`Document extracted successfully`);
      await this.saveExtractedContent(file, extractedContent);
      console.log(`Extracted content saved`);
      this.chatView.updateTokenCount();
      console.log(`Token count updated`);
    } catch (error) {
      console.error(`Error processing document:`, error);
      this.chatView.updateLoadingText(
        `Error processing document: ${(error as Error).message}`
      );
    }
  }

  public async saveExtractedContent(
    file: TFile,
    extractedContent: { markdown: string; images: { [key: string]: string } }
  ) {
    const extractionFolderPath = `${file.parent?.path || ""}/${file.basename}`;
    await this.app.vault.createFolder(extractionFolderPath).catch(() => {}); // Create folder if it doesn't exist
    await this.createOrOverwriteMarkdownFile(
      extractedContent.markdown,
      extractionFolderPath,
      file
    );
    await this.createOrOverwriteImageFiles(
      extractedContent.images,
      extractionFolderPath,
      file
    );
  }

  private async createOrOverwriteMarkdownFile(
    markdown: string,
    folderPath: string,
    originalFile: TFile
  ) {
    const fileName = "extracted_content.md";
    const filePath = `${folderPath}/${fileName}`;

    await this.app.vault.createFolder(folderPath).catch(() => {}); // Ensure folder exists

    const existingFile = this.app.vault.getAbstractFileByPath(filePath);
    if (existingFile instanceof TFile) {
      await this.app.vault.modify(existingFile, markdown);
    } else {
      await this.app.vault.create(filePath, markdown);
    }
  }

  private async createOrOverwriteImageFiles(
    images: { [key: string]: string },
    folderPath: string,
    originalFile: TFile
  ) {
    for (const [imageName, imageBase64] of Object.entries(images)) {
      const imageArrayBuffer = base64ToArrayBuffer(imageBase64);
      const imagePath = `${folderPath}/${imageName}`;
      const existingFile = this.app.vault.getAbstractFileByPath(imagePath);
      if (existingFile instanceof TFile) {
        await this.app.vault.modifyBinary(existingFile, imageArrayBuffer);
      } else {
        await this.app.vault.createBinary(imagePath, imageArrayBuffer);
      }
    }
  }

  async updateChatFileWithContext(file: TFile, action: "add" | "remove") {
    if (!this.chatView.chatFile) return;

    const content = await this.app.vault.read(this.chatView.chatFile);
    const contextTag = `[[${file.path}]]`; // Always use the full path with extension

    let updatedContent;
    if (action === "add") {
      if (content.includes("# Context Files")) {
        updatedContent = content.replace(
          "# Context Files",
          `# Context Files\n${contextTag}`
        );
      } else {
        updatedContent = `# Context Files\n${contextTag}\n${content}`;
      }
    } else {
      const contextFilesSection = content.match(
        /# Context Files\n([\s\S]*?)\n# AI Chat History/
      );
      if (contextFilesSection) {
        const contextFilesContent = contextFilesSection[1];
        const updatedContextFilesContent = contextFilesContent
          .split("\n")
          .filter((line) => line.trim() !== contextTag)
          .join("\n");
        updatedContent = content.replace(
          contextFilesSection[0],
          `# Context Files\n${updatedContextFilesContent}\n# AI Chat History`
        );
      } else {
        updatedContent = content.replace(contextTag, "");
      }
    }

    if (!updatedContent.startsWith("# Context Files")) {
      updatedContent = `# Context Files\n\n${updatedContent}`;
    }
    await this.app.vault.modify(this.chatView.chatFile, updatedContent);
    await this.chatView.loadChatFile(this.chatView.chatFile);
  }

  renderContextFiles() {
    const contextFilesContainer = this.chatView.containerEl.querySelector(
      ".systemsculpt-context-files"
    );
    if (!contextFilesContainer) return;
    contextFilesContainer.innerHTML = "";

    if (this.chatView.contextFiles.length === 0) {
      contextFilesContainer.classList.remove("systemsculpt-has-files");
      return;
    }

    contextFilesContainer.classList.add("systemsculpt-has-files");
    this.chatView.contextFiles.forEach((file: TFile, index: number) => {
      const fileEl = document.createElement("div");
      fileEl.className = "systemsculpt-context-file";

      const isImage = ["png", "jpg", "jpeg", "gif"].includes(
        file.extension.toLowerCase()
      );
      const isAudio = ["mp3", "wav", "m4a", "ogg"].includes(
        file.extension.toLowerCase()
      );
      const isPDF = file.extension.toLowerCase() === "pdf";
      const isDocx = file.extension.toLowerCase() === "docx";
      const isPptx = file.extension.toLowerCase() === "pptx";

      if (isImage) {
        const imgPreview = document.createElement("img");
        imgPreview.className = "systemsculpt-context-file-preview";
        imgPreview.src = this.app.vault.getResourcePath(file);
        imgPreview.alt = file.name;
        fileEl.appendChild(imgPreview);
      } else if (isAudio) {
        const audioIcon = document.createElement("span");
        audioIcon.className =
          "systemsculpt-context-file-preview systemsculpt-audio-icon";
        audioIcon.innerHTML = `<svg viewBox="0 0 100 100" class="systemsculpt-audio-icon" width="40" height="40"><path fill="currentColor" stroke="currentColor" d="M50 10 L25 30 L25 70 L50 90 L50 10 M55 30 A20 20 0 0 1 55 70 M65 20 A40 40 0 0 1 65 80"></path></svg>`;
        fileEl.appendChild(audioIcon);
      } else if (isPDF || isDocx || isPptx || file.extension === "md") {
        const icon = document.createElement("span");
        icon.className = `systemsculpt-context-file-preview ${isPDF ? "systemsculpt-pdf-icon" : isDocx ? "systemsculpt-docx-icon" : isPptx ? "systemsculpt-pptx-icon" : "systemsculpt-md-icon"}`;
        icon.innerHTML = `<svg viewBox="0 0 100 100" class="${isPDF ? "systemsculpt-pdf-icon" : isDocx ? "systemsculpt-docx-icon" : isPptx ? "systemsculpt-pptx-icon" : "systemsculpt-md-icon"}" width="40" height="40">
          <path fill="currentColor" d="M20 10 v80 h60 v-60 l-20 -20 h-40 z" />
          <path fill="currentColor" d="M60 10 v20 h20" opacity="0.5" />
          <text x="50" y="65" font-size="30" text-anchor="middle" fill="white">${isPDF ? "PDF" : isDocx ? "DOCX" : isPptx ? "PPTX" : "MD"}</text>
        </svg>`;
        fileEl.appendChild(icon);
      }

      const filePathEl = document.createElement("div");
      filePathEl.className = "systemsculpt-context-file-path";
      filePathEl.title = file.path;
      filePathEl.innerHTML = `<span>${file.path}</span>`;
      fileEl.appendChild(filePathEl);

      const removeButton = document.createElement("systemsculpt-button");
      removeButton.className = "systemsculpt-remove-context-file";
      removeButton.innerHTML = "🗑️";
      removeButton.title = "Remove Context File";
      fileEl.appendChild(removeButton);

      removeButton.addEventListener("click", (e) => {
        e.stopPropagation();
        this.removeContextFile(index, file);
      });

      contextFilesContainer.appendChild(fileEl);

      filePathEl.addEventListener("click", () => {
        this.openOrSwitchToFile(file);
      });
      filePathEl.style.cursor = "pointer";
    });
    this.chatView.focusInput();
  }

  private removeContextFile(index: number, file: TFile) {
    this.chatView.contextFiles.splice(index, 1);
    this.renderContextFiles();
    this.updateChatFileWithContext(file, "remove");
    this.chatView.updateTokenCount();
  }

  private openOrSwitchToFile(file: TFile) {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      if (leaf.view instanceof MarkdownView && leaf.view.file === file) {
        this.app.workspace.setActiveLeaf(leaf, true, true);
        return;
      }
    }
    // If the file is not already open, open it in a new leaf
    this.app.workspace.openLinkText(file.path, "", true);
  }

  async addDirectoryToContextFiles(folder: TFolder) {
    const files = folder.children.filter(
      (child) => child instanceof TFile
    ) as TFile[];
    for (const file of files) {
      await this.addFileToContextFiles(file);
    }
  }
}

class TranscriptionExistsModal extends Modal {
  private result: "use-existing" | "transcribe-again" | "cancel" = "cancel";
  private onSubmit: (
    result: "use-existing" | "transcribe-again" | "cancel"
  ) => void;

  constructor(
    app: App,
    private fileName: string,
    onSubmit: (result: "use-existing" | "transcribe-again" | "cancel") => void
  ) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Existing Transcription Found" });
    contentEl.createEl("p", {
      text: `It seems like a transcription already exists for "${this.fileName}". What would you like to do?`,
    });

    const buttonContainer = contentEl.createEl("div", {
      cls: "systemsculpt-modal-button-container",
    });

    const useExistingButton = buttonContainer.createEl("button", {
      text: "Use Existing",
      cls: "systemsculpt-mod-cta",
    });
    useExistingButton.addEventListener("click", () => {
      this.result = "use-existing";
      this.close();
    });

    const transcribeAgainButton = buttonContainer.createEl("button", {
      text: "Transcribe Again",
    });
    transcribeAgainButton.addEventListener("click", () => {
      this.result = "transcribe-again";
      this.close();
    });

    const cancelButton = buttonContainer.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => {
      this.result = "cancel";
      this.close();
    });
  }

  onClose() {
    this.onSubmit(this.result);
    this.contentEl.empty();
  }
}
