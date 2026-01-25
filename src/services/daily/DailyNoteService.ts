import { App, TFile, normalizePath, moment, TFolder, EventRef, TAbstractFile } from 'obsidian';
import momentLib from 'moment';
import { DailySettings, DailySettingsService, DEFAULT_DAILY_DIRECTORY_PATH } from './DailySettingsService';
import { EventEmitter } from '../../core/EventEmitter';
import { getFunctionProfiler } from '../FunctionProfiler';

export interface DailyNotesQueryOptions {
	cacheResult?: boolean;
}

export interface DailyNoteEvents {
	'daily-note-created': TFile;
	'daily-note-updated': TFile;
	'streak-updated': number;
	'daily-directory-setup': string;
}

export interface StreakData {
	currentStreak: number;
	longestStreak: number;
	lastDailyNoteDate: string | null;
	totalDailyNotes: number;
}

export class DailyNoteService {
	private app: App;
	private settingsService: DailySettingsService;
	private eventBus: EventEmitter;
	private dailyNotesCache: { timestamp: number; notes: TFile[] } | null = null;
	private readonly NOTES_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
	private readonly CACHE_INVALIDATION_DEBOUNCE = 1500;
	private vaultEventRefs: EventRef[] = [];
	private cacheInvalidationTimer: ReturnType<typeof setTimeout> | null = null;
	private lastKnownDailyDirectory: string | null = null;
	private readonly profiledLoadStreakData: () => Promise<StreakData>;
	private readonly profiledEnsureDirectory: (path: string) => Promise<void>;
	private directoryVerificationCache: Map<string, Promise<void>> = new Map();
	private verifiedDailyDirectories: Set<string> = new Set();
	private initialReadyPromise: Promise<void> | null = null;

	constructor(app: App, settingsService: DailySettingsService, eventBus: EventEmitter) {
		this.app = app;
		this.settingsService = settingsService;
		this.eventBus = eventBus;
		const profiler = getFunctionProfiler();
		this.profiledLoadStreakData = profiler.profileFunction(
			this.loadStreakDataInternal.bind(this),
			'loadStreakData',
			'DailyNoteService'
		);
		this.profiledEnsureDirectory = profiler.profileFunction(
			this.ensureDirectoryExistsInternal.bind(this),
			'ensureDirectoryExists',
			'DailyNoteService'
		);
		this.registerVaultListeners();
		this.initialReadyPromise = this.refreshDailyDirectoryPath();
	}

	public async awaitReady(): Promise<void> {
		try {
			await this.initialReadyPromise;
		} catch {
			// ignore, readiness isn't critical but prevents cascading failures
		}
	}

	/**
	 * Subscribe to daily note events
	 */
	public on<EventKey extends keyof DailyNoteEvents>(event: EventKey, listener: (payload: DailyNoteEvents[EventKey]) => void): () => void {
		return this.eventBus.on(event, listener);
	}

	/**
	 * Create a new daily note for the specified date
	 */
	async createDailyNote(date: Date = new Date(), template?: string): Promise<TFile> {
		try {
			const settings = await this.settingsService.getSettings();
			const dailyNotePath = this.buildDailyNotePath(date, settings);

			// Check if daily note already exists
			const existingNote = this.app.vault.getAbstractFileByPath(dailyNotePath);
			if (existingNote instanceof TFile) {
				return existingNote;
			}

			// Ensure daily directory exists
			await this.ensureDailyDirectories(date, settings);

			// Get content from template or create default content
			let content = '';
			if (template) {
				content = await this.processTemplate(template, date);
			} else {
				const templateContent = await this.getDefaultTemplateContent(settings);
				if (templateContent) {
					content = await this.processTemplate(templateContent, date);
				} else {
					content = await this.generateDefaultDailyContent(date, settings);
				}
			}

			// Create the daily note
			const dailyNote = await this.app.vault.create(dailyNotePath, content);

			// Emit events
			this.eventBus.emit('daily-note-created', dailyNote);
			this.invalidateDailyNotesCache();

			// Update streak data
			await this.updateStreakData(date);

			return dailyNote;
		} catch (error) {
			console.error('Failed to create daily note:', error);
			throw new Error(`Failed to create daily note: ${error.message}`);
		}
	}

	/**
	 * Get existing daily note for the specified date
	 */
	async getDailyNote(date: Date = new Date()): Promise<TFile | null> {
		try {
			const settings = await this.settingsService.getSettings();
			const dailyNotePath = this.buildDailyNotePath(date, settings);
			const dailyNote = this.app.vault.getAbstractFileByPath(dailyNotePath);

			return dailyNote instanceof TFile ? dailyNote : null;
		} catch (error) {
			console.error('Failed to get daily note:', error);
			throw new Error(`Failed to get daily note: ${error.message}`);
		}
	}

	/**
	 * Open daily note in active leaf, creating if it doesn't exist
	 */
	async openDailyNote(date: Date = new Date(), createIfMissing: boolean = true): Promise<void> {
		try {
			let dailyNote = await this.getDailyNote(date);

			if (!dailyNote && createIfMissing) {
				dailyNote = await this.createDailyNote(date);
			}

			if (!dailyNote) {
				throw new Error('Daily note not found and creation disabled');
			}

			// Open in active leaf
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(dailyNote);
		} catch (error) {
			console.error('Failed to open daily note:', error);
			throw new Error(`Failed to open daily note: ${error.message}`);
		}
	}

	/**
	 * Get all daily notes in the vault
	 */
	async getAllDailyNotes(options?: DailyNotesQueryOptions): Promise<TFile[]> {
		const useCache = options?.cacheResult !== false;
		const cache = this.dailyNotesCache;
		const now = Date.now();
		if (useCache && cache && now - cache.timestamp < this.NOTES_CACHE_TTL) {
			return cache.notes;
		}

		try {
			const settings = await this.settingsService.getSettings();
			const dailyPath = normalizePath(settings.dailyDirectoryPath);
			this.lastKnownDailyDirectory = dailyPath;
			const dailyFiles = await this.collectDailyNotes(dailyPath, settings);

			const sorted = dailyFiles.sort((a, b) =>
				momentLib(b.basename, settings.dailyNoteFormat).valueOf() -
				momentLib(a.basename, settings.dailyNoteFormat).valueOf()
			);
			if (useCache) {
				this.dailyNotesCache = { timestamp: now, notes: sorted };
			}
			return sorted;
		} catch (error) {
			console.error('Failed to get all daily notes:', error);
			throw new Error(`Failed to get all daily notes: ${error.message}`);
		}
	}

	private async collectDailyNotes(dailyPath: string, settings: DailySettings): Promise<TFile[]> {
		const folder = this.app.vault.getAbstractFileByPath(dailyPath);
		if (folder instanceof TFolder) {
			return this.collectDailyNotesFromFolder(folder, settings);
		}

		const files = this.app.vault.getFiles();
		const dailyFiles: TFile[] = [];
		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			if (file.path.startsWith(dailyPath) && this.isDailyNoteFile(file, settings)) {
				dailyFiles.push(file);
			}
			if (i > 0 && i % 200 === 0) {
				await this.yieldToMainThread();
			}
		}
		return dailyFiles;
	}

	private async collectDailyNotesFromFolder(folder: TFolder, settings: DailySettings): Promise<TFile[]> {
		const pending: TFolder[] = [folder];
		const dailyFiles: TFile[] = [];
		let processed = 0;

		while (pending.length > 0) {
			const current = pending.pop();
			if (!current) {
				continue;
			}
			for (const child of current.children) {
				if (child instanceof TFolder) {
					pending.push(child);
					continue;
				}
				if (child instanceof TFile && this.isDailyNoteFile(child, settings)) {
					dailyFiles.push(child);
					processed++;
					if (processed % 200 === 0) {
						await this.yieldToMainThread();
					}
				}
			}
		}

		return dailyFiles;
	}

	private async yieldToMainThread(): Promise<void> {
		await new Promise<void>((resolve) => {
			if (typeof window !== 'undefined' && typeof (window as any).requestIdleCallback === 'function') {
				(window as any).requestIdleCallback(() => resolve(), { timeout: 16 });
			} else {
				setTimeout(resolve, 0);
			}
		});
	}

	public invalidateDailyNotesCache(): void {
		this.dailyNotesCache = null;
		this.clearCacheInvalidationTimer();
	}

	private registerVaultListeners(): void {
		const pushRef = (ref: EventRef) => {
			this.vaultEventRefs.push(ref);
		};

		pushRef(this.app.vault.on('create', (file) => this.handleVaultMutation(file)));
		pushRef(this.app.vault.on('delete', (file) => this.handleVaultMutation(file)));
		pushRef(this.app.vault.on('rename', (file, oldPath) => this.handleVaultMutation(file, oldPath)));
	}

	private handleVaultMutation(file: TAbstractFile | null, oldPath?: string): void {
		if (this.isPathInsideDailyDirectory(file?.path) || (oldPath && this.isPathInsideDailyDirectory(oldPath))) {
			this.requestCacheInvalidation();
		}
	}

	private requestCacheInvalidation(): void {
			if (this.cacheInvalidationTimer) {
				return;
			}
			const run = () => {
				this.cacheInvalidationTimer = null;
				this.invalidateDailyNotesCache();
			};
			if (typeof window !== 'undefined' && typeof (window as any).requestIdleCallback === 'function') {
				this.cacheInvalidationTimer = setTimeout(() => (window as any).requestIdleCallback(run), this.CACHE_INVALIDATION_DEBOUNCE);
			} else {
				this.cacheInvalidationTimer = setTimeout(run, this.CACHE_INVALIDATION_DEBOUNCE);
			}
		}

		private clearCacheInvalidationTimer(): void {
			if (!this.cacheInvalidationTimer) {
				return;
			}
			clearTimeout(this.cacheInvalidationTimer);
			this.cacheInvalidationTimer = null;
		}

	private isPathInsideDailyDirectory(path?: string | null): boolean {
		if (!path) {
			return false;
		}
		const dailyPath = this.lastKnownDailyDirectory;
		if (!dailyPath) {
			return false;
		}
		const normalizedPath = normalizePath(path);
		return normalizedPath === dailyPath || normalizedPath.startsWith(`${dailyPath}/`);
	}

	private async refreshDailyDirectoryPath(): Promise<void> {
		try {
			const settings = await this.settingsService.getSettings();
			this.lastKnownDailyDirectory = normalizePath(settings.dailyDirectoryPath);
		} catch {
			this.lastKnownDailyDirectory = null;
		}
	}

	/**
	 * Get daily notes within a date range
	 */
	async getDailyNotesInRange(startDate: Date, endDate: Date): Promise<TFile[]> {
		try {
			const allDailyNotes = await this.getAllDailyNotes();
			const settings = await this.settingsService.getSettings();

			return allDailyNotes.filter(note => {
				const noteDate = momentLib(note.basename, settings.dailyNoteFormat);
				return noteDate.isBetween(startDate, endDate, 'day', '[]');
			});
		} catch (error) {
			console.error('Failed to get daily notes in range:', error);
			throw new Error(`Failed to get daily notes in range: ${error.message}`);
		}
	}

	/**
	 * Get current daily note streak
	 */
	async getStreak(): Promise<number> {
		try {
			const streakData = await this.profiledLoadStreakData();
			return streakData.currentStreak;
		} catch (error) {
			console.error('Failed to get streak:', error);
			throw new Error(`Failed to get streak: ${error.message}`);
		}
	}

	/**
	 * Setup daily directory structure
	 */
	async setupDailyDirectory(): Promise<void> {
		try {
			const settings = await this.settingsService.getSettings();
			const dailyPath = normalizePath(settings.dailyDirectoryPath);

			// Create main daily directory
			await this.ensureDailyDirectories(new Date(), settings);

			this.eventBus.emit('daily-directory-setup', dailyPath);
		} catch (error) {
			console.error('Failed to setup daily directory:', error);
			throw new Error(`Failed to setup daily directory: ${error.message}`);
		}
	}

	/**
	 * Build daily note file path for a specific date using settings
	 */
	private buildDailyNotePath(date: Date, settings: DailySettings): string {
		const dateStr = momentLib(date).format(settings.dailyNoteFormat || 'YYYY-MM-DD');
		const fileName = `${dateStr}.md`;
		const basePath = normalizePath(settings.dailyDirectoryPath || DEFAULT_DAILY_DIRECTORY_PATH);

		if (settings.useDailySubdirectories) {
			const year = momentLib(date).format('YYYY');
			const month = momentLib(date).format('MM');
			return normalizePath(`${basePath}/${year}/${month}/${fileName}`);
		}

		return normalizePath(`${basePath}/${fileName}`);
	}

	/**
	 * Get daily directory path
	 */
	async getDailyDirectoryPath(): Promise<string> {
		const settings = await this.settingsService.getSettings();
		return normalizePath(settings.dailyDirectoryPath);
	}

	/**
	 * Check if file is a daily note based on settings
	 */
	private isDailyNoteFile(file: TFile, settings: DailySettings): boolean {
		if (file.extension !== 'md') return false;

		// Check if filename matches daily note format
		const fileName = file.basename;
		return momentLib(fileName, settings.dailyNoteFormat, true).isValid();
	}

	/**
	 * Process template content with date variables
	 */
	private async processTemplate(template: string, date: Date): Promise<string> {
		const momentDate = momentLib(date);

		// Replace template variables
		let content = template
			.replace(/\{\{date\}\}/g, momentDate.format('YYYY-MM-DD'))
			.replace(/\{\{date:format:([^}]+)\}\}/g, (_, format) => momentDate.format(format))
			.replace(/\{\{day_name\}\}/g, momentDate.format('dddd'))
			.replace(/\{\{month_name\}\}/g, momentDate.format('MMMM'))
			.replace(/\{\{year\}\}/g, momentDate.format('YYYY'))
			.replace(/\{\{time\}\}/g, momentDate.format('h:mm A'));

		return content;
	}

	/**
	 * Generate default daily note content
	 */
	private async generateDefaultDailyContent(date: Date, settings: DailySettings): Promise<string> {
		const momentDate = momentLib(date);
		const dateStr = momentDate.format(settings.dailyNoteFormat || 'YYYY-MM-DD');
		const dayName = momentDate.format('dddd');

		return `# ${dayName}, ${dateStr}

## 🎯 Today's Priorities
-

## 📋 Tasks
- [ ]

## 💭 Notes & Thoughts

## 📚 Reading & Learning

## 🙏 Gratitude
-

## 🌟 Highlights

---

**Tags:** #daily-note #${momentDate.format('YYYY-MM')}`;
	}

	/**
	 * Update streak data after creating daily note
	 */
	private async updateStreakData(noteDate: Date): Promise<void> {
		try {
			const allDailyNotes = await this.getAllDailyNotes();
			const currentStreak = await this.calculateCurrentStreak();
			const streakData = await this.getStreakData();
			const noteDateStr = momentLib(noteDate).format('YYYY-MM-DD');

			// Update streak data
			const newStreakData: StreakData = {
				...streakData,
				currentStreak,
				lastDailyNoteDate: noteDateStr,
				longestStreak: Math.max(currentStreak, streakData.longestStreak),
				totalDailyNotes: allDailyNotes.length
			};

			// Save updated streak data
			await this.saveStreakData(newStreakData);

			// Emit streak update event
			this.eventBus.emit('streak-updated', currentStreak);
		} catch (error) {
			console.warn('Failed to update streak data:', error);
		}
	}

	/**
	 * Calculate current streak based on daily notes
	 */
	private async calculateCurrentStreak(): Promise<number> {
		try {
			const allDailyNotes = await this.getAllDailyNotes();
			const settings = await this.settingsService.getSettings();

			if (allDailyNotes.length === 0) return 0;

			let streak = 0;
			const today = momentLib().startOf('day');
			let currentDate = today.clone();

			// Check if there's a daily note for today or yesterday (allowing for missed current day)
			let foundStart = false;
			for (let offset = 0; offset < 365; offset++) {
				const checkDate = currentDate.clone().subtract(offset, 'days');
				const dateStr = checkDate.format(settings.dailyNoteFormat);

				const hasNote = allDailyNotes.some(note => note.basename === dateStr);

				if (offset === 0 && !hasNote) {
					// No note for today, check if there's one for yesterday
					continue;
				}

				if (hasNote) {
					streak++;
					foundStart = true;
				} else if (foundStart) {
					// Break when streak is broken
					break;
				}
			}

			return streak;
		} catch (error) {
			console.warn('Failed to calculate streak:', error);
			return 0;
		}
	}

	/**
	 * Get streak data from storage
	 */
	private async loadStreakDataInternal(): Promise<StreakData> {
		try {
			const stored = await this.app.vault.adapter.read('.systemsculpt/daily-streak.json');
			return JSON.parse(stored);
		} catch (error) {
			// Return default streak data if file doesn't exist
			return {
				currentStreak: 0,
				longestStreak: 0,
				lastDailyNoteDate: null,
				totalDailyNotes: 0
			};
		}
	}

	/**
	 * Save streak data to storage
	 */
	private async saveStreakData(streakData: StreakData): Promise<void> {
		try {
			await this.app.vault.adapter.mkdir('.systemsculpt');
			await this.app.vault.adapter.write(
				'.systemsculpt/daily-streak.json',
				JSON.stringify(streakData, null, 2)
			);
		} catch (error) {
			console.warn('Failed to save streak data:', error);
		}
	}

	/**
	 * Ensure year/month directories exist when subdirectories enabled
	 */
	private async ensureDailyDirectories(date: Date, settings: DailySettings): Promise<void> {
		const basePath = normalizePath(settings.dailyDirectoryPath);
		await this.ensureDirectoryExists(basePath);

		if (settings.useDailySubdirectories) {
			const yearPath = normalizePath(`${basePath}/${momentLib(date).format('YYYY')}`);
			await this.ensureDirectoryExists(yearPath);

			const monthPath = normalizePath(`${yearPath}/${momentLib(date).format('MM')}`);
			await this.ensureDirectoryExists(monthPath);
		}
	}

	/**
	 * Ensure directory exists in vault
	 */
	private async ensureDirectoryExists(path: string): Promise<void> {
		await this.profiledEnsureDirectory(path);
	}

	private async ensureDirectoryExistsInternal(path: string): Promise<void> {
		if (!path || !path.trim()) {
			return;
		}
		const normalized = normalizePath(path);
		if (this.verifiedDailyDirectories.has(normalized)) {
			return;
		}

		const existing = this.directoryVerificationCache.get(normalized);
		if (existing) {
			await existing;
			return;
		}

		const verification = this.runDirectoryTask(async () => {
			const folder = this.app.vault.getAbstractFileByPath(normalized);
			if (!folder) {
				await this.app.vault.createFolder(normalized);
			}
			this.verifiedDailyDirectories.add(normalized);
		});

		this.directoryVerificationCache.set(normalized, verification);
		try {
			await verification;
		} finally {
			this.directoryVerificationCache.delete(normalized);
		}
	}

	/**
	 * Load template content defined in settings if available
	 */
	private async getDefaultTemplateContent(settings: DailySettings): Promise<string | null> {
		const templatePath = settings.defaultDailyTemplate?.trim();
		if (!templatePath) {
			return null;
		}

		const normalizedPath = normalizePath(templatePath);
		const templateFile = this.app.vault.getAbstractFileByPath(normalizedPath);

		if (templateFile instanceof TFile) {
			try {
				return await this.app.vault.read(templateFile);
			} catch (error) {
				console.warn(`Failed to read default daily template: ${error.message}`);
				return null;
			}
		}

		console.warn(`Default daily template not found at path: ${normalizedPath}`);
		return null;
	}

	/**
	 * Get settings (for compatibility with commands)
	 */
	async getSettings(): Promise<DailySettings> {
		return await this.settingsService.getSettings();
	}

	/**
	 * Render template content with daily note variables.
	 */
	public async renderTemplate(template: string, date: Date = new Date()): Promise<string> {
		return await this.processTemplate(template, date);
	}

	/**
	 * Expose current streak data for analytics consumers
	 */
	public async getStreakData(): Promise<StreakData> {
		return await this.profiledLoadStreakData();
	}

	private runDirectoryTask<T>(task: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const idle =
				typeof window !== 'undefined' && typeof (window as any).requestIdleCallback === 'function'
					? (window as any).requestIdleCallback
					: null;

			const runner = () => {
				task().then(resolve).catch(reject);
			};

			if (idle) {
				idle(() => runner(), { timeout: 250 });
			} else {
				setTimeout(runner, 0);
			}
		});
	}
}
