import { requestUrl, RequestUrlParam, TFile, Notice, TFolder, Modal, App } from 'obsidian';
import { ChatModule } from './ChatModule';
import { base64ToArrayBuffer, arrayBufferToBase64 } from 'obsidian';

export class DocumentExtractor {
  private chatModule: ChatModule;
  private app: App;

  constructor(chatModule: ChatModule, app: App) {
    this.chatModule = chatModule;
    this.app = app;
  }

  async extractDocument(file: TFile): Promise<{ markdown: string; images: { [key: string]: string } }> {
    const fileExtension = file.extension.toLowerCase();
    
    if (['pdf', 'docx', 'pptx'].includes(fileExtension)) {
      return this.extractComplexDocument(file);
    } else if (['png', 'jpg', 'jpeg', 'gif'].includes(fileExtension)) {
      return this.processImage(file);
    } else if (['mp3', 'wav', 'm4a', 'ogg'].includes(fileExtension)) {
      return this.processAudio(file);
    } else if (['md', 'txt'].includes(fileExtension)) {
      return this.processMarkdown(file);
    } else {
      throw new Error(`Unsupported file type: ${fileExtension}`);
    }
  }

  private async extractComplexDocument(file: TFile): Promise<{ markdown: string; images: { [key: string]: string } }> {
    const fileContent = await this.app.vault.readBinary(file);
    return this.convertFileContent(fileContent, file);
  }

  private async convertFileContent(fileContent: ArrayBuffer, file: TFile): Promise<any> {
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    const parts = [];

    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
      `Content-Type: ${this.getContentType(file.extension)}\r\n\r\n`
    );
    parts.push(new Uint8Array(fileContent));
    parts.push('\r\n');

    parts.push(
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="extract_images"\r\n\r\n' +
      'true\r\n'
    );

    parts.push(
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="force_ocr"\r\n\r\n' +
      'true\r\n'
    );

    parts.push(
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="paginate"\r\n\r\n' +
      'true\r\n'
    );

    parts.push(
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="langs"\r\n\r\n' +
      `${this.chatModule.settings.langs}\r\n`
    );

    parts.push(`--${boundary}--\r\n`);

    const bodyParts = parts.map(part =>
      typeof part === 'string' ? new TextEncoder().encode(part) : part
    );
    const bodyLength = bodyParts.reduce((acc, part) => acc + part.byteLength, 0);
    const body = new Uint8Array(bodyLength);
    let offset = 0;
    for (const part of bodyParts) {
      body.set(part, offset);
      offset += part.byteLength;
    }

    const requestParams: RequestUrlParam = {
      url: this.chatModule.settings.apiEndpoint === 'datalab'
        ? 'https://www.datalab.to/api/v1/marker'
        : `http://${this.chatModule.settings.markerEndpoint}/convert`,
      method: 'POST',
      body: body.buffer,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        ...(this.chatModule.settings.apiEndpoint === 'datalab' && { 'X-Api-Key': this.chatModule.settings.markerApiKey }),
      },
    };

    try {
      const response = await requestUrl(requestParams);
      if (response.status >= 400) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return this.chatModule.settings.apiEndpoint === 'datalab'
        ? await this.pollForConversionResult(response.json.request_check_url)
        : response.json;
    } catch (error) {
      console.error('Error in convertFileContent:', error);
      throw error;
    }
  }

  private async pollForConversionResult(requestCheckUrl: string): Promise<any> {
    let response = await requestUrl({
      url: requestCheckUrl,
      method: 'GET',
      headers: {
        'X-Api-Key': this.chatModule.settings.markerApiKey,
      },
    });
    let data = await response.json;
    let maxRetries = 300;
    while (data.status !== 'complete' && maxRetries > 0) {
      maxRetries--;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      response = await requestUrl({
        url: requestCheckUrl,
        method: 'GET',
        headers: {
          'X-Api-Key': this.chatModule.settings.markerApiKey,
        },
      });
      data = await response.json;
    }
    return data;
  }

  private async processConversionResult(data: any, folderPath: string, originalFile: TFile) {
    if (Array.isArray(data) && data.length === 1) {
      data = data[0];
    } else if (Array.isArray(data) && data.length > 1) {
      new Notice('Error, multiple files returned');
      return;
    }

    await this.createOrOverwriteMarkdownFile(data.markdown, folderPath, originalFile);
    await this.createOrOverwriteImageFiles(data.images, folderPath, originalFile);
    
    try {
      const metadata = data.meta || data.metadata;
      await this.addMetadataToMarkdownFile(metadata, folderPath, originalFile);
    } catch (error) {
      console.error('Error adding metadata to markdown file:', error);
      new Notice('Failed to add metadata, but conversion process continued.');
    }
  }

  private async createOrOverwriteMarkdownFile(markdown: string, folderPath: string, originalFile: TFile) {
    const fileName = 'extracted_content.md';
    const filePath = `${folderPath}/${fileName}`;

    const existingFile = this.app.vault.getAbstractFileByPath(filePath);
    if (existingFile instanceof TFile) {
      await this.app.vault.modify(existingFile, markdown);
    } else {
      await this.app.vault.create(filePath, markdown);
    }
    new Notice(`Markdown file created/updated: ${fileName}`);
    this.app.workspace.openLinkText(filePath, '', true);
  }

  private async createOrOverwriteImageFiles(images: { [key: string]: string }, folderPath: string, originalFile: TFile) {
    for (const [imageName, imageBase64] of Object.entries(images)) {
      const imageArrayBuffer = base64ToArrayBuffer(imageBase64);
      const imagePath = `${folderPath}/${imageName}`;
      const existingFile = this.chatModule.plugin.app.vault.getAbstractFileByPath(imagePath);
      if (existingFile instanceof TFile) {
        await this.chatModule.plugin.app.vault.modifyBinary(existingFile, imageArrayBuffer);
      } else {
        await this.chatModule.plugin.app.vault.createBinary(imagePath, imageArrayBuffer);
      }
    }
    new Notice(`Image files created/updated successfully`);
  }

  private async addMetadataToMarkdownFile(metadata: { [key: string]: any } | null | undefined, folderPath: string, originalFile: TFile) {
    if (!metadata) {
      console.warn('No metadata available to add to the markdown file.');
      return;
    }

    const fileName = 'extracted_content.md';
    const filePath = `${folderPath}/${fileName}`;
    const file = this.chatModule.plugin.app.vault.getAbstractFileByPath(filePath);
    if (file instanceof TFile) {
      const frontmatter = this.generateFrontmatter(metadata);
      await this.chatModule.plugin.app.fileManager.processFrontMatter(file, (fm) => {
        return frontmatter + fm;
      });
    }
  }

  private generateFrontmatter(metadata: { [key: string]: any } | null | undefined): string {
    if (!metadata) {
      return '';
    }

    let frontmatter = '---\n';
    const frontmatterKeys = ['languages', 'filetype', 'ocr_stats', 'block_stats'];
    for (const [key, value] of Object.entries(metadata)) {
      if (frontmatterKeys.includes(key)) {
        if (key === 'ocr_stats' || key === 'block_stats') {
          if (typeof value === 'object' && value !== null) {
            for (const [k, v] of Object.entries(value)) {
              frontmatter += `${k}: ${k === 'equations' ? JSON.stringify(v).slice(1, -1).replace(/"/g, '') : v}\n`;
            }
          }
        } else {
          frontmatter += `${key}: ${value}\n`;
        }
      }
    }
    frontmatter += '---\n';
    return frontmatter;
  }

  private async deleteOriginalFile(file: TFile) {
    try {
      await this.chatModule.plugin.app.vault.trash(file, true);
      new Notice('Original file moved to trash');
    } catch (error) {
      console.error('Error deleting original file:', error);
      new Notice('Failed to move original file to trash');
    }
  }

  private getContentType(extension: string): string {
    switch (extension.toLowerCase()) {
      case 'pdf':
        return 'application/pdf';
      case 'docx':
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      case 'pptx':
        return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      default:
        return 'application/octet-stream';
    }
  }

  private async processImage(file: TFile): Promise<{ markdown: string; images: { [key: string]: string } }> {
    const content = await this.app.vault.readBinary(file);
    const base64Image = arrayBufferToBase64(content);
    return {
      markdown: `![${file.name}](data:image/${file.extension};base64,${base64Image})`,
      images: { [file.name]: base64Image }
    };
  }

  private async processAudio(file: TFile): Promise<{ markdown: string; images: { [key: string]: string } }> {
    const extractionFolderPath = `${file.parent?.path || ''}/${file.basename}`;
    const transcriptionFilePath = `${extractionFolderPath}/extracted_content.md`;
    const transcriptionFile = this.app.vault.getAbstractFileByPath(transcriptionFilePath) as TFile;

    if (transcriptionFile) {
      const transcriptionContent = await this.app.vault.read(transcriptionFile);
      return {
        markdown: transcriptionContent,
        images: {}
      };
    } else {
      return {
        markdown: `[Audio file: ${file.name}] (Transcription not available)`,
        images: {}
      };
    }
  }

  private async processMarkdown(file: TFile): Promise<{ markdown: string; images: { [key: string]: string } }> {
    const content = await this.app.vault.read(file);
    return {
      markdown: content,
      images: {}
    };
  }

}

class ConfirmationModal extends Modal {
  private result: boolean = false;
  private onSubmit: (result: boolean) => void;

  constructor(app: App, private title: string, private message: string, onSubmit: (result: boolean) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: this.title });
    contentEl.createEl('p', { text: this.message });

    const buttonContainer = contentEl.createEl('div', {
      cls: 'modal-button-container',
    });
    const okButton = buttonContainer.createEl('button', {
      text: 'OK',
      cls: 'mod-cta',
    });
    const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });

    okButton.addEventListener('click', () => {
      this.result = true;
      this.close();
    });

    cancelButton.addEventListener('click', () => {
      this.result = false;
      this.close();
    });
  }

  onClose() {
    this.onSubmit(this.result);
    this.contentEl.empty();
  }
}