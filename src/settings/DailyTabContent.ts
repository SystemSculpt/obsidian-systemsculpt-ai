import { App, Setting, Notice, moment } from 'obsidian';
import { DailySettings, DailySettingsService, DEFAULT_DAILY_DIRECTORY_PATH } from '../services/daily/DailySettingsService';
import { DailyNoteService } from '../services/daily/DailyNoteService';

export class DailyTabContent {
	private app: App;
	private settingsService: DailySettingsService;
	private dailyNoteService: DailyNoteService;
	private container: HTMLElement;
	private settings: DailySettings;

	constructor(
		app: App,
		settingsService: DailySettingsService,
		dailyNoteService: DailyNoteService,
		container: HTMLElement
	) {
		this.app = app;
		this.settingsService = settingsService;
		this.dailyNoteService = dailyNoteService;
		this.container = container;
	}

	async display(): Promise<void> {
		try {
			this.settings = await this.settingsService.getSettings();
			this.container.empty();
			this.renderSettings();
		} catch (error) {
			console.error('Failed to display daily settings:', error);
			this.container.createEl('div', { text: 'Failed to load daily settings.' });
		}
	}

	private renderSettings(): void {
		this.container.createEl('h2', { text: 'Daily Vault Configuration' });
		this.container.createEl('p', {
			text: 'Configure your daily note system to build consistent journaling habits.',
			cls: 'setting-item-description'
		});

		// Daily Note Structure Section
		this.createSection('Daily Note Structure');
		this.renderDailyNoteStructure();

		// Templates Section
		this.createSection('Daily Templates');
		this.renderTemplatesSection();

		// Time-Based Features Section
		this.createSection('Time-Based Features');
		this.renderTimeBasedFeatures();

		// Habit Tracking Section
		this.createSection('Habit Tracking');
		this.renderHabitTracking();

		// UI Preferences Section
		this.createSection('Interface Preferences');
		this.renderUIPreferences();

		// Advanced Features Section
		this.createSection('Advanced Features');
		this.renderAdvancedFeatures();

		// Actions Section
		this.createSection('Actions');
		this.renderActions();
	}

	private createSection(title: string): void {
		const heading = this.container.createEl('h3', { text: title });
		heading.style.marginTop = '2em';
		heading.style.marginBottom = '1em';
	}

	private renderDailyNoteStructure(): void {
		// Daily Note Format
		new Setting(this.container)
			.setName('Daily note format')
			.setDesc('Choose how your daily notes are named')
			.addDropdown(dropdown => {
				dropdown
					.addOption('YYYY-MM-DD', 'YYYY-MM-DD (International)')
					.addOption('DD-MM-YYYY', 'DD-MM-YYYY (European)')
					.addOption('MM-DD-YYYY', 'MM-DD-YYYY (US)')
					.setValue(this.settings.dailyNoteFormat)
					.onChange(async (value: 'YYYY-MM-DD' | 'DD-MM-YYYY' | 'MM-DD-YYYY') => {
						await this.settingsService.setSetting('dailyNoteFormat', value);
					});
			});

		// Daily Directory Path
		new Setting(this.container)
			.setName('Daily notes directory')
			.setDesc(`Folder where your daily notes will be stored (default: ${DEFAULT_DAILY_DIRECTORY_PATH})`)
			.addText(text => {
				text
					.setPlaceholder(DEFAULT_DAILY_DIRECTORY_PATH)
					.setValue(this.settings.dailyDirectoryPath)
					.onChange(async (value) => {
						if (this.isValidPath(value)) {
							await this.settingsService.setSetting('dailyDirectoryPath', value || DEFAULT_DAILY_DIRECTORY_PATH);
						} else {
							new Notice('Invalid directory path. Please avoid special characters.');
						}
					});
			});

		// Use Subdirectories
		new Setting(this.container)
			.setName('Use subdirectories')
			.setDesc(`Organize daily notes in year/month subdirectories (e.g., ${DEFAULT_DAILY_DIRECTORY_PATH}/2024/01/)`)
			.addToggle(toggle => {
				toggle
					.setValue(this.settings.useDailySubdirectories)
					.onChange(async (value) => {
						await this.settingsService.setSetting('useDailySubdirectories', value);
					});
			});
	}

	private renderTemplatesSection(): void {
		// Default Daily Template
		new Setting(this.container)
			.setName('Default daily template')
			.setDesc('Template to use when creating daily notes')
			.addText(text => {
				text
					.setPlaceholder('default-daily-template')
					.setValue(this.settings.defaultDailyTemplate)
					.onChange(async (value) => {
						await this.settingsService.setSetting('defaultDailyTemplate', value);
					});
			});

		// Morning Template
		new Setting(this.container)
			.setName('Morning planning template')
			.setDesc('Template for daily planning and goal setting')
			.addText(text => {
				text
					.setPlaceholder('morning-planning')
					.setValue(this.settings.morningTemplate)
					.onChange(async (value) => {
						await this.settingsService.setSetting('morningTemplate', value);
					});
			});

		// Evening Template
		new Setting(this.container)
			.setName('Evening reflection template')
			.setDesc('Template for daily review and reflection')
			.addText(text => {
				text
					.setPlaceholder('evening-reflection')
					.setValue(this.settings.eveningTemplate)
					.onChange(async (value) => {
						await this.settingsService.setSetting('eveningTemplate', value);
					});
			});

		// Weekly Review Template
		new Setting(this.container)
			.setName('Weekly review template')
			.setDesc('Template for weekly reviews and planning')
			.addText(text => {
				text
					.setPlaceholder('weekly-review')
					.setValue(this.settings.weeklyReviewTemplate)
					.onChange(async (value) => {
						await this.settingsService.setSetting('weeklyReviewTemplate', value);
					});
			});
	}

	private renderTimeBasedFeatures(): void {
		// Timezone
		new Setting(this.container)
			.setName('Timezone')
			.setDesc('Your local timezone for scheduling daily features')
			.addText(text => {
				text
					.setPlaceholder(Intl.DateTimeFormat().resolvedOptions().timeZone)
					.setValue(this.settings.timezone)
					.onChange(async (value) => {
						await this.settingsService.setSetting('timezone', value || Intl.DateTimeFormat().resolvedOptions().timeZone);
					});
			});

		// Daily Reminder Time
		new Setting(this.container)
			.setName('Daily reminder time')
			.setDesc('Time to remind you to create your daily note (24-hour format)')
			.addText(text => {
				text
					.setPlaceholder('09:00')
					.setValue(this.settings.dailyReminderTime)
					.onChange(async (value) => {
						if (this.isValidTimeFormat(value)) {
							await this.settingsService.setSetting('dailyReminderTime', value || '09:00');
						} else {
							new Notice('Invalid time format. Please use HH:MM format.');
						}
					});
			});

		// Auto Create Daily Note
		new Setting(this.container)
			.setName('Auto-create daily note')
			.setDesc('Automatically create a daily note at the reminder time')
			.addToggle(toggle => {
				toggle
					.setValue(this.settings.autoCreateDailyNote)
					.onChange(async (value) => {
						await this.settingsService.setSetting('autoCreateDailyNote', value);
					});
			});

		// Weekly Review Day
		new Setting(this.container)
			.setName('Weekly review day')
			.setDesc('Day of the week for weekly reviews (0=Sunday, 6=Saturday)')
			.addDropdown(dropdown => {
				const days = [
					{ value: 0, label: 'Sunday' },
					{ value: 1, label: 'Monday' },
					{ value: 2, label: 'Tuesday' },
					{ value: 3, label: 'Wednesday' },
					{ value: 4, label: 'Thursday' },
					{ value: 5, label: 'Friday' },
					{ value: 6, label: 'Saturday' }
				];

				days.forEach(day => {
					dropdown.addOption(day.value.toString(), day.label);
				});

				dropdown
					.setValue(this.settings.weeklyReviewDay.toString())
					.onChange(async (value) => {
						await this.settingsService.setSetting('weeklyReviewDay', parseInt(value));
					});
			});
	}

	private renderHabitTracking(): void {
		// Enable Streak Tracking
		new Setting(this.container)
			.setName('Enable streak tracking')
			.setDesc('Track consecutive daily notes to help build consistent habits')
			.addToggle(toggle => {
				toggle
					.setValue(this.settings.enableStreakTracking)
					.onChange(async (value) => {
						await this.settingsService.setSetting('enableStreakTracking', value);
					});
			});

		// Daily Goal Prompts
		new Setting(this.container)
			.setName('Daily goal prompts')
			.setDesc('Show intelligent prompts to help you reflect on your goals')
			.addToggle(toggle => {
				toggle
					.setValue(this.settings.dailyGoalPrompts)
					.onChange(async (value) => {
						await this.settingsService.setSetting('dailyGoalPrompts', value);
					});
			});
	}

	private renderUIPreferences(): void {
		// Show Daily Status Bar
		new Setting(this.container)
			.setName('Show daily status bar')
			.setDesc('Display current streak and daily note status in the status bar')
			.addToggle(toggle => {
				toggle
					.setValue(this.settings.showDailyStatusBar)
					.onChange(async (value) => {
						await this.settingsService.setSetting('showDailyStatusBar', value);
					});
			});
	}

	private renderAdvancedFeatures(): void {
		// Enable Daily Analytics
		new Setting(this.container)
			.setName('Enable daily analytics')
			.setDesc('Track daily note patterns and provide insights')
			.addToggle(toggle => {
				toggle
					.setValue(this.settings.enableDailyAnalytics)
					.onChange(async (value) => {
						await this.settingsService.setSetting('enableDailyAnalytics', value);
					});
			});

		// Enable Cross-Day Linking
		new Setting(this.container)
			.setName('Enable cross-day linking')
			.setDesc('Automatically link between consecutive daily notes')
			.addToggle(toggle => {
				toggle
					.setValue(this.settings.enableCrossDayLinking)
					.onChange(async (value) => {
						await this.settingsService.setSetting('enableCrossDayLinking', value);
					});
			});

		// Enable Smart Prompts
		new Setting(this.container)
			.setName('Enable smart prompts')
			.setDesc('Use AI to generate personalized daily prompts based on your patterns')
			.addToggle(toggle => {
				toggle
					.setValue(this.settings.enableSmartPrompts)
					.onChange(async (value) => {
						await this.settingsService.setSetting('enableSmartPrompts', value);
					});
			});
	}

	private renderActions(): void {
		new Setting(this.container)
			.setName('Create a test daily note')
			.setDesc('Verifies your current folder, format, and templates without touching existing notes.')
			.addButton((button) => {
				button
					.setButtonText('Run test')
					.setClass('mod-cta')
					.onClick(async () => {
						try {
							const testNote = await this.dailyNoteService.createDailyNote();
							new Notice(`Test daily note created: ${testNote.name}`);
						} catch (error) {
							new Notice(`Failed to create test daily note: ${error.message}`);
						}
					});
			});

		new Setting(this.container)
			.setName('Setup folders now')
			.setDesc('Creates the Daily directory (and optional year/month subfolders) immediately.')
			.addButton((button) => {
				button
					.setButtonText('Create folders')
					.setClass('mod-cta')
					.onClick(async () => {
						try {
							await this.dailyNoteService.setupDailyDirectory();
							new Notice('Daily directory setup complete');
						} catch (error) {
							new Notice(`Failed to setup daily directory: ${error.message}`);
						}
					});
			});

		new Setting(this.container)
			.setName('Reset daily settings')
			.setDesc('Restores every Daily Vault preference to its defaults.')
			.addButton((button) => {
				button
					.setButtonText('Reset')
					.setClass('mod-warning')
					.onClick(async () => {
						const confirmReset = confirm('Reset all daily settings to defaults? This cannot be undone.');
						if (!confirmReset) return;
						try {
							await this.settingsService.resetSettings();
							await this.display();
							new Notice('Daily settings reset to defaults');
						} catch (error) {
							new Notice(`Failed to reset settings: ${error.message}`);
						}
					});
			});
	}

	private isValidPath(path: string): boolean {
		// Check for invalid characters in file paths
		const invalidChars = /[<>:"|?*]/;
		return !invalidChars.test(path) && !path.includes('..');
	}

	private isValidTimeFormat(time: string): boolean {
		const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
		return timeRegex.test(time);
	}
}
