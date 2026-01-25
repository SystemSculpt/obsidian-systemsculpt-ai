import { Component, Notice, setIcon } from 'obsidian';
import type SystemSculptPlugin from '../../main';
import type { ChatView } from './ChatView';
import { SystemPromptService } from '../../services/SystemPromptService';
import { GENERAL_USE_PRESET, CONCISE_PRESET } from '../../constants/prompts';

interface AgentItem {
  id: string;
  name: string;
  description: string;
  type: "general-use" | "concise" | "agent" | "custom";
  path?: string;
  prompt?: string;
  score?: number;
}

/**
 * AgentSelectionMenu provides an inline agent/system prompt selection experience
 * triggered by the /agent slash command.
 */
export class AgentSelectionMenu extends Component {
  private plugin: SystemSculptPlugin;
  private chatView: ChatView;
  private inputElement: HTMLTextAreaElement;
  private container: HTMLElement;
  private searchInput: HTMLInputElement;
  private itemsContainer: HTMLElement;
  private systemPromptService: SystemPromptService;
  
  private isVisible: boolean = false;
  private selectedIndex: number = 0;
  private allAgents: AgentItem[] = [];
  private filteredAgents: AgentItem[] = [];
  private searchQuery: string = '';
  private triggerPosition: number = -1;

  constructor(plugin: SystemSculptPlugin, chatView: ChatView, inputElement: HTMLTextAreaElement) {
    super();
    this.plugin = plugin;
    this.chatView = chatView;
    this.inputElement = inputElement;
    this.systemPromptService = SystemPromptService.getInstance(this.plugin.app, () => this.plugin.settings);
    
    this.createMenu();
    this.loadAgents();
  }

  private createMenu(): void {
    this.container = document.createElement('div');
    this.container.addClass('agent-selection-menu');
    this.container.style.display = 'none';

    // Header
    const header = this.container.createDiv('agent-selection-header');
    const titleContainer = header.createDiv('agent-selection-title-container');
    const icon = titleContainer.createDiv('agent-selection-icon');
    setIcon(icon, 'user-check');
    titleContainer.createEl('span', { text: 'Switch Agent', cls: 'agent-selection-title' });

    // Items container (scrollable results)
    this.itemsContainer = this.container.createDiv('agent-selection-items');

    // Search input at bottom
    const searchContainer = this.container.createDiv('agent-selection-search');
    const searchIcon = searchContainer.createDiv('agent-selection-search-icon');
    setIcon(searchIcon, 'search');
    
    this.searchInput = searchContainer.createEl('input', {
      type: 'text',
      placeholder: 'Type to filter agents...',
      cls: 'agent-selection-search-input'
    });

    this.searchInput.addEventListener('input', () => {
      this.handleSearch();
    });

    this.searchInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        this.handleKeyDown(e);
      } else if (e.key === 'Backspace' && this.searchInput.value === '') {
        // If backspace pressed with empty search, close and remove /agent command
        e.preventDefault();
        this.removeCommandAndClose();
      }
    });

    document.body.appendChild(this.container);
  }

  private async loadAgents(): Promise<void> {
    const agents: AgentItem[] = [];

    // Add preset options
    agents.push({
      id: 'general-use',
      name: 'General Use',
      description: 'A comprehensive prompt for general conversations',
      type: 'general-use',
      prompt: GENERAL_USE_PRESET.systemPrompt
    });

    agents.push({
      id: 'concise',
      name: 'Concise',
      description: 'A focused prompt for brief, direct responses',
      type: 'concise',
      prompt: CONCISE_PRESET.systemPrompt
    });

    agents.push({
      id: 'agent',
      name: 'Agent Prompt',
      description: 'Advanced prompt with tool access capabilities',
      type: 'agent',
      prompt: '' // Will be loaded from service when needed
    });

    // Add custom prompt files
    try {
      const customFiles = await this.systemPromptService.getCustomPromptFiles();
      for (const file of customFiles) {
        agents.push({
          id: `custom-${file.path}`,
          name: file.name,
          description: `Custom prompt: ${file.path}`,
          type: 'custom',
          path: file.path
        });
      }
    } catch (error) {
      console.error('Failed to load custom prompts:', error);
    }

    this.allAgents = agents;
    this.filteredAgents = [...agents];
  }

  public async show(triggerPosition: number): Promise<void> {
    // Reload agents to get latest custom prompts
    await this.loadAgents();
    
    this.triggerPosition = triggerPosition;
    this.isVisible = true;
    this.selectedIndex = 0;
    this.searchQuery = '';
    this.searchInput.value = '';
    
    this.updateFilteredAgents();
    this.render();
    this.positionMenu();
    
    this.container.style.display = 'block';
    this.searchInput.focus();
  }

  public hide(): void {
    this.isVisible = false;
    this.container.style.display = 'none';
    this.inputElement.focus();
  }

  public isOpen(): boolean {
    return this.isVisible;
  }

  private handleSearch(): void {
    this.searchQuery = this.searchInput.value;
    this.updateFilteredAgents();
    this.selectedIndex = 0;
    this.render();
  }

  private updateFilteredAgents(): void {
    if (!this.searchQuery) {
      this.filteredAgents = [...this.allAgents];
      return;
    }

    const query = this.searchQuery.toLowerCase();
    const results: AgentItem[] = [];

    for (const agent of this.allAgents) {
      const score = this.fuzzyScore(query, agent.name.toLowerCase()) +
                    this.fuzzyScore(query, agent.description.toLowerCase()) * 0.5;
      if (score > 0) {
        results.push({ ...agent, score });
      }
    }

    results.sort((a, b) => (b.score || 0) - (a.score || 0));
    this.filteredAgents = results;
  }

  private fuzzyScore(query: string, text: string): number {
    let score = 0;
    let queryIndex = 0;
    
    for (let i = 0; i < text.length && queryIndex < query.length; i++) {
      if (text[i] === query[queryIndex]) {
        score += 1;
        queryIndex++;
      }
    }
    
    // Bonus for exact match
    if (text.includes(query)) {
      score += query.length * 2;
    }
    
    // Bonus for starting with query
    if (text.startsWith(query)) {
      score += query.length;
    }
    
    return queryIndex === query.length ? score : 0;
  }

  private render(): void {
    this.itemsContainer.empty();

    if (this.filteredAgents.length === 0) {
      const emptyState = this.itemsContainer.createDiv('agent-selection-empty');
      emptyState.textContent = 'No agents found';
      return;
    }

    this.filteredAgents.forEach((agent, index) => {
      const item = this.itemsContainer.createDiv({
        cls: `agent-selection-item ${index === this.selectedIndex ? 'is-selected' : ''}`
      });

      // Icon based on type
      const iconEl = item.createDiv('agent-selection-item-icon');
      const iconName = agent.type === 'agent' ? 'zap' : 
                      agent.type === 'custom' ? 'file-text' : 
                      agent.type === 'concise' ? 'minimize-2' : 
                      'message-square';
      setIcon(iconEl, iconName);

      const content = item.createDiv('agent-selection-item-content');
      content.createDiv({ cls: 'agent-selection-item-name', text: agent.name });
      content.createDiv({ cls: 'agent-selection-item-description', text: agent.description });

      // Mark current agent
      if (this.isCurrentAgent(agent)) {
        const badge = item.createDiv('agent-selection-item-badge');
        badge.textContent = 'Current';
      }

      this.registerDomEvent(item, 'click', () => {
        this.selectAgent(agent);
      });

      this.registerDomEvent(item, 'mouseover', () => {
        this.selectedIndex = index;
        this.updateSelection();
      });
    });
  }

  private isCurrentAgent(agent: AgentItem): boolean {
    if (agent.type === 'custom') {
      return this.chatView.systemPromptType === 'custom' && 
             this.chatView.systemPromptPath === agent.path;
    }
    return this.chatView.systemPromptType === agent.type;
  }

  private updateSelection(): void {
    const items = this.itemsContainer.querySelectorAll('.agent-selection-item');
    items.forEach((item, index) => {
      item.classList.toggle('is-selected', index === this.selectedIndex);
    });

    const selectedItem = items[this.selectedIndex] as HTMLElement;
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.selectedIndex = (this.selectedIndex + 1) % this.filteredAgents.length;
        this.updateSelection();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.selectedIndex = this.selectedIndex === 0 ? 
          this.filteredAgents.length - 1 : this.selectedIndex - 1;
        this.updateSelection();
        break;
      case 'Enter':
        e.preventDefault();
        if (this.filteredAgents.length > 0) {
          this.selectAgent(this.filteredAgents[this.selectedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        this.removeCommandAndClose();
        break;
    }
  }

  private async selectAgent(agent: AgentItem): Promise<void> {
    try {
      // Update chat view with selected agent
      this.chatView.systemPromptType = agent.type;
      
      if (agent.type === 'custom' && agent.path) {
        this.chatView.systemPromptPath = agent.path;
      } else {
        this.chatView.systemPromptPath = undefined;
      }

      // Update the UI to reflect the change
      await this.chatView.updateSystemPromptIndicator();
      
      // Save the chat to persist the change
      await this.chatView.saveChat();

      // Show confirmation
      new Notice(`Switched to: ${agent.name}`, 2000);

      // Remove the /agent command from input and close menu
      this.removeCommandAndClose();

    } catch (error) {
      new Notice(`Failed to switch agent: ${error instanceof Error ? error.message : String(error)}`);
      console.error('Agent switch error:', error);
    }
  }

  private removeCommandAndClose(): void {
    // Find and remove /agent command from input
    const currentValue = this.inputElement.value;
    const agentCommandPattern = /\/agent\s*/;
    
    if (agentCommandPattern.test(currentValue)) {
      this.inputElement.value = currentValue.replace(agentCommandPattern, '');
      // Set cursor position
      this.inputElement.selectionStart = this.inputElement.selectionEnd = 0;
    }

    this.hide();
  }

  private positionMenu(): void {
    const inputRect = this.inputElement.getBoundingClientRect();
    const menuHeight = 400;
    const menuWidth = 400;

    this.container.style.position = 'fixed';
    
    // Position above the input
    const bottom = window.innerHeight - inputRect.top + 10;
    this.container.style.bottom = `${bottom}px`;
    
    // Horizontal positioning
    let left = inputRect.left;
    if (left + menuWidth > window.innerWidth - 10) {
      left = window.innerWidth - menuWidth - 10;
    }
    this.container.style.left = `${left}px`;
    
    this.container.style.width = `${menuWidth}px`;
    this.container.style.maxHeight = `${menuHeight}px`;
    this.container.style.zIndex = '1000';
  }

  public unload(): void {
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    super.unload();
  }
}
