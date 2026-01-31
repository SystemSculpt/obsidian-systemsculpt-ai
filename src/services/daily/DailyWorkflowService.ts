import { Notice } from 'obsidian';
import moment from 'moment';
import { DailyNoteService } from './DailyNoteService';
import { DailySettingsService } from './DailySettingsService';

/**
 * Handles time-based automation for the Daily Vault (auto-create, reminders, weekly review prompts)
 */
export class DailyWorkflowService {
	private dailyNoteService: DailyNoteService;
	private settingsService: DailySettingsService;
	private reminderInterval: number | null = null;
	private lastReminderDate: string | null = null;
	private lastWeeklyReviewDate: string | null = null;
	private readonly idleScheduler: (callback: () => void) => void;
	private pendingTickWatchdog: number | null = null;

	constructor(dailyNoteService: DailyNoteService, settingsService: DailySettingsService) {
		this.dailyNoteService = dailyNoteService;
		this.settingsService = settingsService;

		this.idleScheduler = typeof window !== 'undefined' && typeof (window as any).requestIdleCallback === 'function'
			? (callback: () => void) => (window as any).requestIdleCallback(() => callback())
			: (callback: () => void) => setTimeout(callback, 0);
	}

	async initialize(): Promise<void> {
		await this.refreshScheduler();
		this.settingsService.onSettingsChange(() => {
			void this.refreshScheduler();
		});
	}

	private async refreshScheduler(): Promise<void> {
		this.stopScheduler();

		const settings = await this.settingsService.getSettings();
		const requiresScheduler = settings.autoCreateDailyNote || !!settings.dailyReminderTime || settings.weeklyReviewTemplate;

		if (!requiresScheduler) {
			return;
		}

		// Kick off scheduler loop
		this.reminderInterval = window.setInterval(() => {
			this.scheduleTickExecution();
		}, 60 * 1000); // every minute

		// Run immediately in case we missed the window
		this.scheduleTickExecution();
	}

	private stopScheduler(): void {
		if (this.reminderInterval !== null) {
			window.clearInterval(this.reminderInterval);
			this.reminderInterval = null;
		}
	}

	private async runTick(): Promise<void> {
		try {
			await this.handleDailyReminder();
			await this.handleWeeklyReviewReminder();
		} catch (error) {
			console.warn('Daily workflow tick failed', error);
		}
	}

	private scheduleTickExecution(): void {
		const execute = () => {
			if (this.pendingTickWatchdog !== null) {
				window.clearTimeout(this.pendingTickWatchdog);
				this.pendingTickWatchdog = null;
			}
			void this.runTick();
		};

		this.idleScheduler(execute);
		this.armTickWatchdog(execute);
	}

	private armTickWatchdog(callback: () => void): void {
		if (typeof window === 'undefined') {
			return;
		}
		if (this.pendingTickWatchdog !== null) {
			window.clearTimeout(this.pendingTickWatchdog);
		}
		this.pendingTickWatchdog = window.setTimeout(() => {
			this.pendingTickWatchdog = null;
			callback();
		}, 5000);
	}

	private async handleDailyReminder(): Promise<void> {
		const settings = await this.settingsService.getSettings();
		const todayKey = moment().format('YYYY-MM-DD');

		if (this.lastReminderDate === todayKey) {
			return;
		}

		const shouldTriggerReminder = this.settingsService.shouldTriggerDailyReminder();

		if (!shouldTriggerReminder) {
			return;
		}

		this.lastReminderDate = todayKey;

		if (settings.autoCreateDailyNote) {
			const existingNote = await this.dailyNoteService.getDailyNote();
			if (!existingNote) {
				await this.dailyNoteService.createDailyNote();
				new Notice("Daily note created automatically", 4000);
			}
		} else {
			new Notice("Reminder: It's time to create today's daily note.", 5000);
		}
	}

	private async handleWeeklyReviewReminder(): Promise<void> {
		const settings = await this.settingsService.getSettings();
		const todayKey = moment().format('YYYY-MM-DD');

		if (!settings.weeklyReviewTemplate) {
			return;
		}

		if (this.lastWeeklyReviewDate === todayKey) {
			return;
		}

		if (!this.settingsService.shouldTriggerWeeklyReview()) {
			return;
		}

		this.lastWeeklyReviewDate = todayKey;

		new Notice("Weekly review is scheduled for today. Use your weekly template to reflect and plan.", 6000);
	}

	cleanup(): void {
		this.stopScheduler();
	}
}
