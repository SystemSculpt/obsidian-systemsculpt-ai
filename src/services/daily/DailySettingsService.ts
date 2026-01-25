import { App } from 'obsidian';
import momentLib from 'moment';
import { EventEmitter } from '../../core/EventEmitter';

export interface DailySettings {
	// Daily note structure
	dailyNoteFormat: 'YYYY-MM-DD' | 'DD-MM-YYYY' | 'MM-DD-YYYY';
	dailyDirectoryPath: string;
	useDailySubdirectories: boolean;

	// Template selection
	defaultDailyTemplate: string;
	morningTemplate: string;
	eveningTemplate: string;
	weeklyReviewTemplate: string;

	// Time-based features
	timezone: string;
	dailyReminderTime: string;
	autoCreateDailyNote: boolean;

	// Habit tracking
	enableStreakTracking: boolean;
	dailyGoalPrompts: boolean;
	weeklyReviewDay: number;

	// UI preferences
	showDailyStatusBar: boolean;

	// Advanced features
	enableDailyAnalytics: boolean;
	enableCrossDayLinking: boolean;
	enableSmartPrompts: boolean;
}

export const DEFAULT_DAILY_DIRECTORY_PATH = 'SystemSculpt/Daily';
const LEGACY_DEFAULT_DAILY_DIRECTORY_PATH = 'Daily';

export const DEFAULT_DAILY_SETTINGS: DailySettings = {
	// Daily note structure
	dailyNoteFormat: 'YYYY-MM-DD',
	dailyDirectoryPath: DEFAULT_DAILY_DIRECTORY_PATH,
	useDailySubdirectories: false,

	// Template selection
	defaultDailyTemplate: '',
	morningTemplate: '',
	eveningTemplate: '',
	weeklyReviewTemplate: '',

	// Time-based features
	timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	dailyReminderTime: '09:00',
	autoCreateDailyNote: false,

	// Habit tracking
	enableStreakTracking: true,
	dailyGoalPrompts: true,
	weeklyReviewDay: 0, // Sunday

	// UI preferences
	showDailyStatusBar: true,

	// Advanced features
	enableDailyAnalytics: false,
	enableCrossDayLinking: true,
	enableSmartPrompts: true
};

export class DailySettingsService {
	private app: App;
	private settings: DailySettings;
	private saveTimeout?: NodeJS.Timeout;
	private eventBus: EventEmitter;

	constructor(app: App) {
		this.app = app;
		this.settings = { ...DEFAULT_DAILY_SETTINGS };
		this.eventBus = new EventEmitter();
	}

	/**
	 * Initialize settings service and load existing settings
	 */
	async initialize(): Promise<void> {
		try {
			await this.loadSettings();
			this.eventBus.emit('settings-updated', { ...this.settings });
		} catch (error) {
			console.warn('Failed to load daily settings, using defaults:', error);
			this.settings = { ...DEFAULT_DAILY_SETTINGS };
			this.eventBus.emit('settings-updated', { ...this.settings });
		}
	}

	/**
	 * Get current daily settings
	 */
	async getSettings(): Promise<DailySettings> {
		return { ...this.settings };
	}

	/**
	 * Update specific daily settings
	 */
	async updateSettings(updates: Partial<DailySettings>): Promise<void> {
		try {
			this.settings = { ...this.settings, ...updates };
			this.eventBus.emit('settings-updated', { ...this.settings });
			await this.saveSettings();
		} catch (error) {
			console.error('Failed to update daily settings:', error);
			throw error;
		}
	}

	/**
	 * Reset settings to defaults
	 */
	async resetSettings(): Promise<void> {
		this.settings = { ...DEFAULT_DAILY_SETTINGS };
		await this.saveSettings();
	}

	/**
	 * Get formatted date for daily note based on current settings
	 */
	getFormattedDate(date: Date = new Date()): string {
		return momentLib(date).format(this.settings.dailyNoteFormat);
	}

	/**
	 * Get daily reminder time as moment object
	 */
	getDailyReminderTime(): momentLib.Moment {
		const today = momentLib();
		const [hours, minutes] = this.settings.dailyReminderTime.split(':').map(Number);
		return today.hour(hours).minute(minutes).second(0).millisecond(0);
	}

	/**
	 * Check if daily reminder should trigger now
	 */
	shouldTriggerDailyReminder(): boolean {
		if (!this.settings.dailyReminderTime) return false;

		const now = momentLib();
		const reminderTime = this.getDailyReminderTime();

		// Check if current time is within 1 minute of reminder time
		return Math.abs(now.diff(reminderTime, 'minutes')) <= 1;
	}

	/**
	 * Check if weekly review should trigger today
	 */
	shouldTriggerWeeklyReview(): boolean {
		return momentLib().day() === this.settings.weeklyReviewDay;
	}

	/**
	 * Validate settings values
	 */
	private validateSettings(settings: Partial<DailySettings>): string[] {
		const errors: string[] = [];

		// Validate directory path
		if (settings.dailyDirectoryPath && !this.isValidPath(settings.dailyDirectoryPath)) {
			errors.push('Daily directory path contains invalid characters');
		}

		// Validate reminder time format
		if (settings.dailyReminderTime && !this.isValidTimeFormat(settings.dailyReminderTime)) {
			errors.push('Daily reminder time must be in HH:MM format');
		}

		// Validate weekly review day
		if (settings.weeklyReviewDay !== undefined && (settings.weeklyReviewDay < 0 || settings.weeklyReviewDay > 6)) {
			errors.push('Weekly review day must be between 0 (Sunday) and 6 (Saturday)');
		}

		return errors;
	}

	/**
	 * Check if path string is valid
	 */
	private isValidPath(path: string): boolean {
		// Check for invalid characters in file paths
		const invalidChars = /[<>:"|?*]/;
		return !invalidChars.test(path) && !path.includes('..');
	}

	/**
	 * Check if time format is valid (HH:MM)
	 */
	private isValidTimeFormat(time: string): boolean {
		const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
		return timeRegex.test(time);
	}

	/**
	 * Load settings from storage
	 */
	private async loadSettings(): Promise<void> {
		try {
			const settingsData = await this.app.vault.adapter.read('.systemsculpt/daily-settings.json');
			const loadedSettings = JSON.parse(settingsData);

			// Validate loaded settings
			const validationErrors = this.validateSettings(loadedSettings);
			if (validationErrors.length > 0) {
				console.warn('Daily settings validation errors:', validationErrors);
			}

			// Merge with defaults to ensure all properties exist
			const mergedSettings: DailySettings = {
				...DEFAULT_DAILY_SETTINGS,
				...loadedSettings
			};

			const { migratedSettings, changed } = this.applyMigrations(mergedSettings, loadedSettings);
			this.settings = migratedSettings;

			if (changed) {
				try {
					await this.performSave();
				} catch (migrationError) {
					console.warn('Failed to persist migrated daily settings:', migrationError);
				}
			}
		} catch (error) {
			// File doesn't exist or is corrupted, use defaults
			this.settings = { ...DEFAULT_DAILY_SETTINGS };
		}
	}

	/**
	 * Save settings to storage with debouncing
	 */
	private async saveSettings(): Promise<void> {
		// Clear any existing timeout
		if (this.saveTimeout) {
			clearTimeout(this.saveTimeout);
		}

		// Debounce save operation
		this.saveTimeout = setTimeout(async () => {
			try {
				await this.performSave();
			} catch (error) {
				console.error('Failed to save daily settings:', error);
			}
		}, 500); // 500ms debounce
	}

	/**
	 * Perform the actual save operation
	 */
	private async performSave(): Promise<void> {
		try {
			// Ensure .systemsculpt directory exists
			await this.app.vault.adapter.mkdir('.systemsculpt');

			// Save settings to file
			const settingsData = JSON.stringify(this.settings, null, 2);
			await this.app.vault.adapter.write('.systemsculpt/daily-settings.json', settingsData);
		} catch (error) {
			console.error('Failed to perform daily settings save:', error);
			throw error;
		}
	}

	/**
	 * Export settings for backup
	 */
	async exportSettings(): Promise<string> {
		return JSON.stringify(this.settings, null, 2);
	}

	/**
	 * Import settings from backup
	 */
	async importSettings(settingsData: string): Promise<void> {
		try {
			const importedSettings = JSON.parse(settingsData);

			// Validate imported settings
			const validationErrors = this.validateSettings(importedSettings);
			if (validationErrors.length > 0) {
				throw new Error(`Invalid settings: ${validationErrors.join(', ')}`);
			}

			// Update settings
			await this.updateSettings(importedSettings);
		} catch (error) {
			console.error('Failed to import daily settings:', error);
			throw new Error(`Failed to import settings: ${error.message}`);
		}
	}

	/**
	 * Get specific setting value
	 */
	async getSetting<K extends keyof DailySettings>(key: K): Promise<DailySettings[K]> {
		return this.settings[key];
	}

	/**
	 * Update specific setting value
	 */
	async setSetting<K extends keyof DailySettings>(key: K, value: DailySettings[K]): Promise<void> {
		await this.updateSettings({ [key]: value });
	}

	/**
	 * Subscribe to settings changes
	 */
	onSettingsChange(listener: (settings: DailySettings) => void): () => void {
		return this.eventBus.on('settings-updated', listener);
	}

	/**
	 * Check if a feature is enabled
	 */
	isFeatureEnabled(feature: keyof DailySettings): boolean {
		const value = this.settings[feature];
		return typeof value === 'boolean' ? value : false;
	}

	/**
	 * Cleanup method for service disposal
	 */
	cleanup(): void {
		if (this.saveTimeout) {
			clearTimeout(this.saveTimeout);
		}
	}

	private applyMigrations(settings: DailySettings, loadedSettings?: Partial<DailySettings>): {
		migratedSettings: DailySettings;
		changed: boolean;
	} {
		const migratedSettings = { ...settings };
		let changed = false;

		const rawLoadedDirectory = loadedSettings?.dailyDirectoryPath;
		const normalizedLoadedDirectory = rawLoadedDirectory?.trim()?.replace(/\/+$/, '');

		if (normalizedLoadedDirectory === LEGACY_DEFAULT_DAILY_DIRECTORY_PATH) {
			migratedSettings.dailyDirectoryPath = DEFAULT_DAILY_DIRECTORY_PATH;
			changed = true;
		}

		return { migratedSettings, changed };
	}
}
