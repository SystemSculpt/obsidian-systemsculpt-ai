import { App, TFile, MarkdownView } from 'obsidian';

export class ContextFileManager {
  constructor(private app: App, private chatView: any) {}

  addFileToContextFiles(file: TFile) {
    if (
      !this.chatView.contextFiles.some(
        contextFile => contextFile.path === file.path
      )
    ) {
      this.chatView.contextFiles.push(file);
      this.renderContextFiles();
      this.updateChatFileWithContext(file, 'add');
    }
  }

  async updateChatFileWithContext(file: TFile, action: 'add' | 'remove') {
    if (!this.chatView.chatFile) return;

    const content = await this.app.vault.read(this.chatView.chatFile);
    const contextTagShort = `[[${file.basename}]]`;
    const contextTagFull = `[[${file.path}]]`;

    let updatedContent;
    if (action === 'add') {
      if (content.includes('# Context Files')) {
        updatedContent = content.replace(
          '# Context Files',
          `# Context Files\n${contextTagShort}`
        );
      } else {
        updatedContent = `# Context Files\n${contextTagShort}\n${content}`;
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
              line.trim() !== contextTagShort && line.trim() !== contextTagFull
          )
          .join('\n');
        updatedContent = content.replace(
          contextFilesSection[0],
          `# Context Files\n${updatedContextFilesContent}\n# AI Chat History`
        );
      } else {
        updatedContent = content
          .replace(contextTagShort, '')
          .replace(contextTagFull, '');
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
    this.chatView.contextFiles.forEach((file, index) => {
      const fileEl = document.createElement('div');
      fileEl.className = 'context-file';
      fileEl.innerHTML = `
      <span class="context-file-path">${file.path}</span>
      <button class="remove-context-file" title="Remove Context File">🗑️</button>
    `;
      contextFilesContainer.appendChild(fileEl);

      const filePathEl = fileEl.querySelector('.context-file-path');
      if (filePathEl) {
        filePathEl.addEventListener('click', () => {
          this.openOrSwitchToFile(file);
        });
        (filePathEl as HTMLElement).style.cursor = 'pointer';
      }

      const removeButton = fileEl.querySelector('.remove-context-file');
      if (removeButton) {
        removeButton.addEventListener('click', () => {
          this.chatView.contextFiles.splice(index, 1);
          this.renderContextFiles();
          this.updateChatFileWithContext(file, 'remove');
        });
      }
    });
    this.chatView.focusInput();
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
}
