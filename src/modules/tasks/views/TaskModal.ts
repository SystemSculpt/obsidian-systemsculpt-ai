import { App, Modal, Setting } from 'obsidian';
import { TasksModule } from '../TasksModule';
import { LoadingModal } from '../../../modals';
import { showCustomNotice } from '../../../modals';

export class TaskModal extends Modal {
  plugin: TasksModule;
  private taskDescriptionInput!: HTMLTextAreaElement;

  constructor(app: App, plugin: TasksModule) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen(): Promise<void> {
    let { contentEl } = this;

    contentEl.createEl('h2', { text: 'Add Task' });

    this.taskDescriptionInput = this.renderTaskDescriptionInput(contentEl);
    this.renderButtons(contentEl);

    this.registerKeyboardShortcuts();
  }

  private renderTaskDescriptionInput(
    contentEl: HTMLElement
  ): HTMLTextAreaElement {
    const taskDescriptionSetting = new Setting(contentEl)
      .setName('Task Description')
      .setDesc('What you want to accomplish?')
      .addTextArea(textarea => textarea);
    taskDescriptionSetting.controlEl.classList.add('task-description-textarea');

    const textarea = taskDescriptionSetting.controlEl.querySelector('textarea');
    if (!textarea) {
      throw new Error('Textarea element not found');
    }
    return textarea;
  }

  private renderButtons(contentEl: HTMLElement): void {
    const buttonContainer = contentEl.createDiv();
    buttonContainer.addClass('task-modal-button');

    const addTaskButton = buttonContainer.createEl('button', {
      text: 'Add Task',
    });
    addTaskButton.addEventListener('click', this.addTask.bind(this));
  }

  private registerKeyboardShortcuts(): void {
    this.scope.register(['Mod'], 'Enter', this.addTask.bind(this));
    this.scope.register(
      ['Shift', 'Mod'],
      'Enter',
      this.addTaskAndReopen.bind(this)
    );
  }

  async addTask(): Promise<void> {
    const taskDescription = this.taskDescriptionInput.value.trim();
    if (taskDescription) {
      await this.generateAndInsertTask(taskDescription);
      this.close();
    }
  }

  async addTaskAndReopen(): Promise<void> {
    const taskDescription = this.taskDescriptionInput.value.trim();
    if (taskDescription) {
      await this.generateAndInsertTask(taskDescription);
      this.taskDescriptionInput.value = '';
      this.taskDescriptionInput.focus();
    }
  }

  private async generateAndInsertTask(taskDescription: string): Promise<void> {
    let loadingModal;
    try {
      loadingModal = new LoadingModal(this.app);
      loadingModal.open();

      const generatedTask = await this.plugin.generateTask(taskDescription);
      await this.plugin.insertGeneratedTask(generatedTask);
    } catch (error) {
      // @ts-ignore
      if (error.response && error.response.status === 401) {
        showCustomNotice(
          'Invalid API key. Please update your API key in the settings.'
        );
      } else {
        showCustomNotice(
          'Failed to generate task. Please check your API key and try again.'
        );
      }
    } finally {
      if (loadingModal) {
        loadingModal.close();
      }
    }
  }

  onClose(): void {
    let { contentEl } = this;
    contentEl.empty();
  }
}
