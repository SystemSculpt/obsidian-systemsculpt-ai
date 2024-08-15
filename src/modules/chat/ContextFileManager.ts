import { App, TFile, MarkdownView, Modal } from 'obsidian';
import { PDFExtractor } from './PDFExtractor';
import { base64ToArrayBuffer } from 'obsidian';

export class ContextFileManager {
  constructor(private app: App, private chatView: any) {}

  async addFileToContextFiles(file: TFile) {
    const supportedExtensions = ['md', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'mp3', 'wav', 'm4a', 'ogg'];
    const fileExtension = file.extension.toLowerCase();
    
    if (supportedExtensions.includes(fileExtension)) {
      const existingFile = this.chatView.contextFiles.find(
        (contextFile: TFile) => contextFile.path === file.path
      );

      if (existingFile) {
        const existingHash = await this.chatView.chatModule.calculateMD5(existingFile);
        const newHash = await this.chatView.chatModule.calculateMD5(file);

        if (existingHash === newHash) {
          this.chatView.updateLoadingText(`File ${file.name} is already in the context files.`);
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
      await this.updateChatFileWithContext(file, 'add');
      
      if (fileExtension === 'pdf') {
        await this.processPDF(file);
      } else {
        const isImage = ['png', 'jpg', 'jpeg', 'gif'].includes(fileExtension);
        if (isImage) {
          this.appendImageLinkToInput(file.name);
        }
      }
    } else {
      const supportedExtensionsString = supportedExtensions.join(', ');
      this.chatView.updateLoadingText(`We don't handle ${fileExtension} files yet. We only support ${supportedExtensionsString} files.`);
    }
  }

  public async processPDF(file: TFile) {
    const pdfExtractor = new PDFExtractor(this.chatView.chatModule);
    const extractedContent = await pdfExtractor.extractPDF(file);
    await this.savePDFExtractedContent(file, extractedContent);
    this.chatView.updateTokenCount();
  }

  public async savePDFExtractedContent(file: TFile, extractedContent: { markdown: string; images: { [key: string]: string } }) {
    const extractionFolderPath = `${file.parent?.path || ''}/${file.basename}`;
    await this.createOrOverwriteMarkdownFile(extractedContent.markdown, extractionFolderPath, file);
    await this.createOrOverwriteImageFiles(extractedContent.images, extractionFolderPath, file);
  }

  private async createOrOverwriteMarkdownFile(markdown: string, folderPath: string, originalFile: TFile) {
    const fileName = 'extracted_content.md';
    const filePath = `${folderPath}/${fileName}`;

    const existingFile = this.chatView.chatModule.plugin.app.vault.getAbstractFileByPath(filePath);
    if (existingFile instanceof TFile) {
      await this.chatView.chatModule.plugin.app.vault.modify(existingFile, markdown);
    } else {
      await this.chatView.chatModule.plugin.app.vault.create(filePath, markdown);
    }
  }

  private async createOrOverwriteImageFiles(images: { [key: string]: string }, folderPath: string, originalFile: TFile) {
    for (const [imageName, imageBase64] of Object.entries(images)) {
      const imageArrayBuffer = base64ToArrayBuffer(imageBase64);
      const imagePath = `${folderPath}/${imageName}`;
      const existingFile = this.chatView.chatModule.plugin.app.vault.getAbstractFileByPath(imagePath);
      if (existingFile instanceof TFile) {
        await this.chatView.chatModule.plugin.app.vault.modifyBinary(existingFile, imageArrayBuffer);
      } else {
        await this.chatView.chatModule.plugin.app.vault.createBinary(imagePath, imageArrayBuffer);
      }
    }
  }

  private appendImageLinkToInput(fileName: string) {
    const inputEl = this.chatView.containerEl.querySelector('.chat-input') as HTMLTextAreaElement;
    if (inputEl) {
      this.chatView.updateTokenCountAndCost();
    }
  }

  async updateChatFileWithContext(file: TFile, action: 'add' | 'remove') {
    if (!this.chatView.chatFile) return;

    const content = await this.app.vault.read(this.chatView.chatFile);
    const contextTag = `[[${file.path}]]`; // Always use the full path with extension

    let updatedContent;
    if (action === 'add') {
      if (content.includes('# Context Files')) {
        updatedContent = content.replace(
          '# Context Files',
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
          .split('\n')
          .filter(
            line =>
              line.trim() !== contextTag 
          )
          .join('\n');
        updatedContent = content.replace(
          contextFilesSection[0],
          `# Context Files\n${updatedContextFilesContent}\n# AI Chat History`
        );
      } else {
        updatedContent = content
          .replace(contextTag, '')
      }
    }

    if (!updatedContent.startsWith('# Context Files')) {
      updatedContent = `# Context Files\n\n${updatedContent}`;
    }
    await this.app.vault.modify(this.chatView.chatFile, updatedContent);
    await this.chatView.loadChatFile(this.chatView.chatFile);
  }

  renderContextFiles() {
    const contextFilesContainer =
      this.chatView.containerEl.querySelector('.context-files');
    if (!contextFilesContainer) return;
    contextFilesContainer.innerHTML = '';

    if (this.chatView.contextFiles.length === 0) {
      contextFilesContainer.classList.remove('has-files');
      return;
    }

    contextFilesContainer.classList.add('has-files');
    this.chatView.contextFiles.forEach((file: TFile, index: number) => {
      const fileEl = document.createElement('div');
      fileEl.className = 'context-file';
      
      const isImage = ['png', 'jpg', 'jpeg', 'gif'].includes(file.extension.toLowerCase());
      const isAudio = ['mp3', 'wav', 'm4a', 'ogg'].includes(file.extension.toLowerCase());
      const isPDF = file.extension.toLowerCase() === 'pdf';
  
      if (isImage) {
        const imgPreview = document.createElement('img');
        imgPreview.className = 'context-file-preview';
        imgPreview.src = this.app.vault.getResourcePath(file);
        imgPreview.alt = file.name;
        fileEl.appendChild(imgPreview);
      } else if (isAudio) {
        const audioIcon = document.createElement('span');
        audioIcon.className = 'context-file-preview audio-icon';
        audioIcon.innerHTML = `<svg viewBox="0 0 100 100" class="audio-icon" width="40" height="40"><path fill="currentColor" stroke="currentColor" d="M50 10 L25 30 L25 70 L50 90 L50 10 M55 30 A20 20 0 0 1 55 70 M65 20 A40 40 0 0 1 65 80"></path></svg>`;
        fileEl.appendChild(audioIcon);
      } else if (isPDF || file.extension === 'md') {
        const icon = document.createElement('span');
        icon.className = `context-file-preview ${isPDF ? 'pdf-icon' : 'md-icon'}`;
        icon.innerHTML = `<svg viewBox="0 0 100 100" class="${isPDF ? 'pdf-icon' : 'md-icon'}" width="40" height="40">
          <path fill="currentColor" d="M20 10 v80 h60 v-60 l-20 -20 h-40 z" />
          <path fill="currentColor" d="M60 10 v20 h20" opacity="0.5" />
          <text x="50" y="65" font-size="30" text-anchor="middle" fill="white">${isPDF ? 'PDF' : 'MD'}</text>
        </svg>`;
        fileEl.appendChild(icon);
      }

      const filePathEl = document.createElement('div');
      filePathEl.className = 'context-file-path';
      filePathEl.title = file.path;
      filePathEl.innerHTML = `<span>${file.path}</span>`;
      fileEl.appendChild(filePathEl);

      const removeButton = document.createElement('button');
      removeButton.className = 'remove-context-file';
      removeButton.innerHTML = '🗑️';
      removeButton.title = 'Remove Context File';
      fileEl.appendChild(removeButton);

      removeButton.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeContextFile(index, file);
      });

      contextFilesContainer.appendChild(fileEl);

      filePathEl.addEventListener('click', () => {
        this.openOrSwitchToFile(file);
      });
      filePathEl.style.cursor = 'pointer';
    });
    this.chatView.focusInput();
  }

  private removeContextFile(index: number, file: TFile) {
    this.chatView.contextFiles.splice(index, 1);
    this.renderContextFiles();
    this.updateChatFileWithContext(file, 'remove');
  }

  private openOrSwitchToFile(file: TFile) {
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      if (leaf.view instanceof MarkdownView && leaf.view.file === file) {
        this.app.workspace.setActiveLeaf(leaf, true, true);
        return;
      }
    }
    // If the file is not already open, open it in a new leaf
    this.app.workspace.openLinkText(file.path, '', true);
  }

  private async showFileExistsDialog(fileName: string): Promise<'replace' | 'keep-both' | 'cancel'> {
    return new Promise((resolve) => {
      const modal = new FileExistsModal(this.app, fileName, (result) => {
        resolve(result);
      });
      modal.open();
    });
  }

  private getUniqueFileName(fileName: string): string {
    const name = fileName.substring(0, fileName.lastIndexOf('.'));
    const extension = fileName.substring(fileName.lastIndexOf('.'));
    let counter = 1;
    let newFileName = `${name} ${counter}${extension}`;

    while (this.chatView.contextFiles.some((file: TFile) => file.name === newFileName)) {
      counter++;
      newFileName = `${name} ${counter}${extension}`;
    }

    return newFileName;
  }

  private async copyFileWithNewName(file: TFile, newFileName: string): Promise<TFile> {
    const newPath = file.parent ? `${file.parent.path}/${newFileName}` : newFileName;
    await this.app.vault.copy(file, newPath);
    return this.app.vault.getAbstractFileByPath(newPath) as TFile;
  }
}

class FileExistsModal extends Modal {
  private result: 'replace' | 'keep-both' | 'cancel' = 'cancel';
  private onSubmit: (result: 'replace' | 'keep-both' | 'cancel') => void;

  constructor(app: App, private fileName: string, onSubmit: (result: 'replace' | 'keep-both' | 'cancel') => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'File Already Exists' });
    contentEl.createEl('p', { text: `A file named "${this.fileName}" already exists in the context files. What would you like to do?` });

    const buttonContainer = contentEl.createEl('div', { cls: 'modal-button-container' });
    
    const replaceButton = buttonContainer.createEl('button', { text: 'Replace', cls: 'mod-warning' });
    replaceButton.addEventListener('click', () => {
      this.result = 'replace';
      this.close();
    });

    const keepBothButton = buttonContainer.createEl('button', { text: 'Keep Both' });
    keepBothButton.addEventListener('click', () => {
      this.result = 'keep-both';
      this.close();
    });

    const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
    cancelButton.addEventListener('click', () => {
      this.result = 'cancel';
      this.close();
    });
  }

  onClose() {
    this.onSubmit(this.result);
    this.contentEl.empty();
  }
}