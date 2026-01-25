import moment from 'moment';
import type { TFile } from 'obsidian';
import { DailyNoteService, StreakData } from './DailyNoteService';
import { getFunctionProfiler } from '../FunctionProfiler';

export interface DailyAnalyticsSummary {
	totalDailyNotes: number;
	currentStreak: number;
	longestStreak: number;
	lastDailyNoteDate: string | null;
	notesThisWeek: number;
	notesThisMonth: number;
}

export class DailyAnalyticsService {
	private dailyNoteService: DailyNoteService;
	private summaryCache: { timestamp: number; data: DailyAnalyticsSummary } | null = null;
	private inFlightSummary: Promise<DailyAnalyticsSummary> | null = null;
	private readonly SUMMARY_TTL = 60 * 1000; // 1 minute cache
	private readonly PERSIST_TTL = 5 * 60 * 1000; // 5 minutes on-disk cache
	private readonly SUMMARY_STORAGE_KEY = "systemsculpt:daily-analytics-summary";
	private persistedSummary: DailyAnalyticsSummary | null = null;
	private persistedSummaryTimestamp = 0;
	private readonly profiledComputeSummary: () => Promise<DailyAnalyticsSummary>;
	private readonly profiledCountNotes: (allNotes: TFile[], dateFormat: string, weekStart: moment.Moment, monthStart: moment.Moment) => Promise<{ weeklyCount: number; monthlyCount: number }>;

	constructor(dailyNoteService: DailyNoteService) {
		this.dailyNoteService = dailyNoteService;
		const profiler = getFunctionProfiler();
		this.profiledComputeSummary = profiler.profileFunction(
			this.computeAnalyticsSummaryInternal.bind(this),
			'computeAnalyticsSummary',
			'DailyAnalyticsService'
		);
		this.profiledCountNotes = profiler.profileFunction(
			this.countNotesInRecentRangeInternal.bind(this),
			'countNotesInRecentRange',
			'DailyAnalyticsService'
		);
		this.loadPersistedSummary();
	}

	/**
	 * Build analytics summary combining streak data and note counts
	 */
	async getAnalyticsSummary(): Promise<DailyAnalyticsSummary> {
		const now = Date.now();
		if (this.summaryCache && now - this.summaryCache.timestamp < this.SUMMARY_TTL) {
			return this.summaryCache.data;
		}

		if (this.inFlightSummary) {
			return this.inFlightSummary;
		}

		const fallback = this.getPersistedSummary(now);
		if (fallback) {
			this.inFlightSummary = this.computeAndCacheSummary();
			void this.inFlightSummary.finally(() => {
				this.inFlightSummary = null;
			});
			return fallback;
		}

		this.inFlightSummary = this.computeAndCacheSummary();
		return this.inFlightSummary;
	}

	private computeAndCacheSummary(): Promise<DailyAnalyticsSummary> {
		const task = this.profiledComputeSummary()
			.then((summary) => {
				this.summaryCache = { timestamp: Date.now(), data: summary };
				this.persistSummary(summary);
				return summary;
			})
			.finally(() => {
				if (this.inFlightSummary === task) {
					this.inFlightSummary = null;
				}
			});
		return task;
	}

	private async computeAnalyticsSummaryInternal(): Promise<DailyAnalyticsSummary> {
		const settings = await this.dailyNoteService.getSettings();
		const dateFormat = settings.dailyNoteFormat || 'YYYY-MM-DD';
		const streakData: StreakData = await this.dailyNoteService.getStreakData();
		const allNotes = await this.dailyNoteService.getAllDailyNotes({ cacheResult: false });
		const now = moment();
		const weekStart = now.clone().startOf('week');
		const monthStart = now.clone().startOf('month');

		const { weeklyCount, monthlyCount } = await this.profiledCountNotes(
			allNotes,
			dateFormat,
			weekStart,
			monthStart
		);

		return {
			totalDailyNotes: streakData.totalDailyNotes || allNotes.length,
			currentStreak: streakData.currentStreak,
			longestStreak: streakData.longestStreak,
			lastDailyNoteDate: streakData.lastDailyNoteDate,
			notesThisWeek: weeklyCount,
			notesThisMonth: monthlyCount
		};
	}

	private async countNotesInRecentRangeInternal(
		allNotes: TFile[],
		dateFormat: string,
		weekStart: moment.Moment,
		monthStart: moment.Moment
	): Promise<{ weeklyCount: number; monthlyCount: number }> {
		let weeklyCount = 0;
		let monthlyCount = 0;
		for (let i = 0; i < allNotes.length; i++) {
			const note = allNotes[i];
			const noteDate = moment(note.basename, dateFormat, true);
			if (!noteDate.isValid()) {
				continue;
			}
			if (noteDate.isBefore(monthStart)) {
				break;
			}
			monthlyCount++;
			if (!noteDate.isBefore(weekStart)) {
				weeklyCount++;
			}
			if (i > 0 && i % 50 === 0) {
				await this.yieldToMainThread();
			}
		}
		return { weeklyCount, monthlyCount };
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

	public invalidateCache(): void {
		this.summaryCache = null;
	}

	private loadPersistedSummary(): void {
		if (typeof localStorage === 'undefined') {
			return;
		}
		try {
			const raw = localStorage.getItem(this.SUMMARY_STORAGE_KEY);
			if (!raw) {
				return;
			}
			const payload = JSON.parse(raw) as { timestamp: number; data: DailyAnalyticsSummary };
			this.persistedSummary = payload.data;
			this.persistedSummaryTimestamp = payload.timestamp ?? 0;
		} catch (error) {
			console.warn('Failed to load cached analytics summary', error);
		}
	}

	private persistSummary(summary: DailyAnalyticsSummary): void {
		if (typeof localStorage === 'undefined') {
			return;
		}
		try {
			const payload = { timestamp: Date.now(), data: summary };
			localStorage.setItem(this.SUMMARY_STORAGE_KEY, JSON.stringify(payload));
			this.persistedSummary = summary;
			this.persistedSummaryTimestamp = payload.timestamp;
		} catch (error) {
			console.warn('Failed to persist analytics summary', error);
		}
	}

	private getPersistedSummary(now: number): DailyAnalyticsSummary | null {
		if (!this.persistedSummary) {
			return null;
		}
		if (now - this.persistedSummaryTimestamp > this.PERSIST_TTL) {
			return null;
		}
		return this.persistedSummary;
	}
}
