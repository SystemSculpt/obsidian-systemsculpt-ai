import { App, Modal, Setting, Notice, TextAreaComponent, TextComponent, ButtonComponent } from "obsidian";
import SystemSculptPlugin from "../main";

export interface SystemPromptCreatorOptions {
  app: App;
  plugin: SystemSculptPlugin;
  onCreated?: (filePath: string) => void;
}

interface PresetPrompt {
  id: string;
  name: string;
  description: string;
  content: string;
}

export class SystemPromptCreatorModal extends Modal {
  private plugin: SystemSculptPlugin;
  private onCreated?: (filePath: string) => void;
  private fileNameInput: TextComponent | null = null;
  private contentTextArea: TextAreaComponent | null = null;
  private saveLocationEl: HTMLElement | null = null;
  private createButton: ButtonComponent | null = null;

  private presets: PresetPrompt[] = [
    {
      id: 'creative-writing',
      name: 'Creative Writing Assistant',
      description: 'For creative writing, storytelling, and content creation',
      content: `You are a creative writing assistant with expertise in storytelling, character development, and narrative structure. Your role is to help users craft compelling stories, develop interesting characters, and improve their writing style.

Key areas of assistance:
- Plot development and story structure
- Character creation and development
- Dialogue writing and improvement
- Setting and world-building
- Writing style and voice development
- Grammar and clarity suggestions

Always encourage creativity while providing constructive feedback. Ask clarifying questions to better understand the user's vision and goals.`
    },
    {
      id: 'code-assistant',
      name: 'Code Review Assistant',
      description: 'For code review, debugging, and programming guidance',
      content: `You are a senior software engineer specializing in code review and development best practices. Your role is to help users write better code, debug issues, and follow industry standards.

Key areas of assistance:
- Code review and quality assessment
- Bug identification and debugging strategies
- Performance optimization suggestions
- Security best practices
- Clean code principles and refactoring
- Documentation and commenting standards
- Testing strategies and implementation

Provide specific, actionable feedback with examples when possible. Consider readability, maintainability, and scalability in your recommendations.`
    },
    {
      id: 'research-helper',
      name: 'Research Assistant',
      description: 'For research, analysis, and information gathering',
      content: `You are a research assistant with expertise in information analysis, source evaluation, and academic writing. Your role is to help users conduct thorough research and present findings clearly.

Key areas of assistance:
- Research methodology and planning
- Source evaluation and credibility assessment
- Data analysis and interpretation
- Literature review and synthesis
- Citation and referencing guidance
- Academic writing structure and style
- Fact-checking and verification

Always emphasize the importance of multiple sources and critical thinking. Help users develop strong analytical skills and present well-supported arguments.`
    },
    {
      id: 'meeting-notes',
      name: 'Meeting Notes Assistant',
      description: 'For organizing meetings, taking notes, and action items',
      content: `You are a professional meeting assistant focused on organization, clarity, and actionable outcomes. Your role is to help users prepare for meetings, take effective notes, and follow up on commitments.

Key areas of assistance:
- Meeting agenda preparation and structure
- Note-taking strategies and templates
- Action item identification and tracking
- Decision documentation and clarity
- Follow-up task organization
- Meeting summary creation
- Stakeholder communication templates

Focus on clear, concise documentation that enables effective follow-through and accountability.`
    },
    {
      id: 'blank',
      name: 'Blank Template',
      description: 'Start with a clean slate',
      content: `You are a helpful assistant. Please provide clear, accurate, and helpful responses to user questions and requests.

Key guidelines:
- Be concise but thorough in your responses
- Ask clarifying questions when needed
- Provide examples when helpful
- Maintain a professional and friendly tone

Customize this prompt based on your specific needs and use case.`
    }
  ];

  constructor(options: SystemPromptCreatorOptions) {
    super(options.app);
    this.plugin = options.plugin;
    this.onCreated = options.onCreated;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('systemsculpt-prompt-creator-modal');

    // Modal header
    contentEl.createEl('h2', { text: 'Create New System Prompt' });
    contentEl.createEl('p', {
      text: 'Create a custom system prompt file that will be saved to your vault and available for use in chats.',
      cls: 'systemsculpt-prompt-creator-description'
    });

    // File name section
    const fileNameSection = contentEl.createDiv('systemsculpt-prompt-creator-section');
    fileNameSection.createEl('h3', { text: 'File Name' });

    new Setting(fileNameSection)
      .setName('Prompt Name')
      .setDesc('Enter a name for your system prompt file')
      .addText(text => {
        this.fileNameInput = text;
        text
          .setPlaceholder('My Custom Prompt')
          .setValue('')
          .onChange((value) => {
            this.updateSaveLocation();
            this.validateForm();
          });
        text.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.createPrompt();
          }
        });
      });

    // Save location display
    this.saveLocationEl = fileNameSection.createDiv('systemsculpt-save-location');
    this.updateSaveLocation();

    // Presets section
    const presetsSection = contentEl.createDiv('systemsculpt-prompt-creator-section');
    presetsSection.createEl('h3', { text: 'Quick Start Templates' });
    presetsSection.createEl('p', {
      text: 'Choose a template to get started, then customize as needed.',
      cls: 'systemsculpt-section-description'
    });

    const presetsGrid = presetsSection.createDiv('systemsculpt-presets-grid');
    
    this.presets.forEach(preset => {
      const presetCard = presetsGrid.createDiv('systemsculpt-preset-card systemsculpt-preset-card-clickable');
      
      presetCard.createEl('h4', { text: preset.name, cls: 'systemsculpt-preset-card-title' });
      presetCard.createEl('p', { text: preset.description, cls: 'systemsculpt-preset-card-description' });
      
      presetCard.addEventListener('click', () => {
        if (this.contentTextArea) {
          this.contentTextArea.setValue(preset.content);
        }
        if (this.fileNameInput && !this.fileNameInput.getValue().trim()) {
          this.fileNameInput.setValue(preset.name);
          this.updateSaveLocation();
          this.validateForm();
        }
        
        // Visual feedback
        this.highlightSelectedPreset(presetCard);
      });
    });

    // Content section
    const contentSection = contentEl.createDiv('systemsculpt-prompt-creator-section');
    contentSection.createEl('h3', { text: 'System Prompt Content' });
    contentSection.createEl('p', {
      text: 'Write your system prompt here. This text will guide the AI\'s behavior and responses.',
      cls: 'systemsculpt-section-description'
    });

    // Create full-width textarea container
    const textAreaContainer = contentSection.createDiv('systemsculpt-prompt-textarea-container');
    const textArea = textAreaContainer.createEl('textarea', {
      cls: 'systemsculpt-prompt-textarea',
      placeholder: 'Enter your system prompt here...'
    });

    // Create TextAreaComponent wrapper for consistency
    this.contentTextArea = {
      getValue: () => textArea.value,
      setValue: (value: string) => {
        textArea.value = value;
        this.validateForm();
      },
      onChange: (callback: (value: string) => void) => {
        textArea.addEventListener('input', () => {
          callback(textArea.value);
        });
      },
      inputEl: textArea
    } as TextAreaComponent;

    // Set up the textarea
    textArea.rows = 12;
    textArea.addEventListener('input', () => {
      this.validateForm();
    });

    // Actions section
    const actionsSection = contentEl.createDiv('systemsculpt-prompt-creator-actions');
    
    const cancelButton = new ButtonComponent(actionsSection);
    cancelButton
      .setButtonText('Cancel')
      .onClick(() => {
        this.close();
      });

    this.createButton = new ButtonComponent(actionsSection);
    this.createButton
      .setButtonText('Create System Prompt')
      .setCta()
      .setDisabled(true)
      .onClick(() => {
        this.createPrompt();
      });

    // Initial validation
    this.validateForm();
  }

  private highlightSelectedPreset(selectedCard: HTMLElement) {
    // Remove highlight from all preset cards
    const allCards = selectedCard.parentElement?.querySelectorAll('.systemsculpt-preset-card');
    allCards?.forEach(card => card.removeClass('systemsculpt-preset-card-selected'));
    
    // Add highlight to selected card
    selectedCard.addClass('systemsculpt-preset-card-selected');
    
    // Remove highlight after animation
    setTimeout(() => {
      selectedCard.removeClass('systemsculpt-preset-card-selected');
    }, 1000);
  }

  private updateSaveLocation() {
    if (!this.saveLocationEl || !this.fileNameInput) return;

    const fileName = this.fileNameInput.getValue().trim();
    const systemPromptsFolder = 'SystemSculpt/System Prompts';
    
    if (fileName) {
      const sanitizedFileName = this.sanitizeFileName(fileName);
      const fullPath = `${systemPromptsFolder}/${sanitizedFileName}.md`;
      this.saveLocationEl.innerHTML = `
        <div class="systemsculpt-save-location-label">Will be saved to:</div>
        <div class="systemsculpt-save-location-path">${fullPath}</div>
      `;
    } else {
      this.saveLocationEl.innerHTML = `
        <div class="systemsculpt-save-location-label">Will be saved to:</div>
        <div class="systemsculpt-save-location-path systemsculpt-save-location-placeholder">${systemPromptsFolder}/[enter name].md</div>
      `;
    }
  }

  private sanitizeFileName(fileName: string): string {
    // Remove or replace invalid characters for file names
    return fileName
      .replace(/[<>:"/\\|?*]/g, '') // Remove invalid characters
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
  }

  private validateForm() {
    if (!this.fileNameInput || !this.contentTextArea || !this.createButton) return;

    const fileName = this.fileNameInput.getValue().trim();
    const content = this.contentTextArea.getValue().trim();
    
    const isValid = fileName.length > 0 && content.length > 0;
    this.createButton.setDisabled(!isValid);
  }

  private async createPrompt() {
    if (!this.fileNameInput || !this.contentTextArea) {
      new Notice('Missing required fields', 5000);
      return;
    }

    const fileName = this.fileNameInput.getValue().trim();
    const content = this.contentTextArea.getValue().trim();

    if (!fileName || !content) {
      new Notice('Please fill in both the name and content fields', 5000);
      return;
    }

    try {
      // Create the system prompts folder if it doesn't exist
      const systemPromptsFolder = 'SystemSculpt/System Prompts';
      await this.ensureFolderExists(systemPromptsFolder);

      // Create the file
      const sanitizedFileName = this.sanitizeFileName(fileName);
      const filePath = `${systemPromptsFolder}/${sanitizedFileName}.md`;
      
      // Check if file already exists
      const existingFile = this.app.vault.getAbstractFileByPath(filePath);
      if (existingFile) {
        new Notice(`A system prompt with the name "${sanitizedFileName}" already exists. Please choose a different name.`, 8000);
        return;
      }

      // Create the file with frontmatter
      const fileContent = `---
type: system-prompt
created: ${new Date().toISOString()}
tags: [system-prompt, custom]
---

${content}`;

      await this.app.vault.create(filePath, fileContent);
      
      new Notice(`System prompt "${sanitizedFileName}" created successfully!`, 5000);
      
      // Call the onCreated callback if provided
      if (this.onCreated) {
        this.onCreated(filePath);
      }
      
      this.close();
    } catch (error) {
      new Notice('Failed to create system prompt. Please try again.', 8000);
    }
  }

  private async ensureFolderExists(folderPath: string) {
    const pathParts = folderPath.split('/');
    let currentPath = '';

    for (const part of pathParts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      
      const existingFolder = this.app.vault.getAbstractFileByPath(currentPath);
      if (!existingFolder) {
        await this.app.vault.createFolder(currentPath);
      }
    }
  }

  onClose() {
    // Cleanup if needed
  }
}