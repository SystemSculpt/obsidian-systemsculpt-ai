import { App, Notice, MarkdownView, TFile, normalizePath } from "obsidian";
import moment from "moment";
import { DailyNoteService, StreakData } from "./DailyNoteService";
import { DailySettingsService, DEFAULT_DAILY_DIRECTORY_PATH } from "./DailySettingsService";

const DAILY_REVIEW_HEADINGS = [
	"## 🤔 Reflections",
	"## 📅 Looking Ahead",
	"## 🌟 Highlights",
	"## 🌟 Highlights & Wins"
];

const WEEKLY_REVIEW_HEADINGS = [
	"## 📅 Week in Review",
	"## ✅ Major Accomplishments",
	"## 💭 Learning & Growth",
	"## 🌟 Next Week's Planning",
	"## 🌟 Next Week’s Planning"
];

const DEFAULT_WEEKLY_REVIEW_TEMPLATE = `# Weekly Review - Week of {{date:format:YYYY-MM-DD}}

## 📅 Week in Review

### 🎯 This Week's Goals
**Primary Goal:**
- **Status:** ✅ Completed / 🔄 In Progress / ❌ Not Started

**Secondary Goals:**
- [ ] Goal 1 - Status:
- [ ] Goal 2 - Status:
- [ ] Goal 3 - Status:

## ✅ Major Accomplishments
- [ ]
- [ ]
- [ ]
- [ ]

## 🎉 Wins & Celebrations
**What went exceptionally well this week?**

**Surprises (positive):**

## 💪 Challenges & Obstacles
**What was most challenging this week?**

**How did I handle it:**

**What I would do differently:**

## 📊 Productivity & Energy Patterns
**Most productive days/times:**

**Energy levels throughout the week:**

**Time management insights:**

## 💭 Learning & Growth
**Biggest lessons learned:**

**New skills or knowledge gained:**

**Moments of insight:**

## 🧠 Mental & Emotional Well-being
**Overall mood this week:**

**Stress levels:**

**What supported my well-being:**

**What drained my energy:**

## 🙏 Gratitude & Appreciation
**Things I'm grateful for this week:**

**People who made a difference:**

**Experiences I'm thankful for:**

## 📈 Progress Towards Long-term Goals
**How this week moved me closer to my bigger goals:**

**Areas where I'm making progress:**

**Areas needing more attention:**

## 🔄 Process Review
**What routines served me well:**

**What habits need adjustment:**

**Systems to improve:**

## 🌟 Next Week's Planning
**My main priority for next week:**

**Key focus areas:**
- [ ]
- [ ]
- [ ]

**New things I want to try:**

**Things to let go of:**

## 🎯 Intentions & Commitments
**For next week, I commit to:**
- [ ] Being more...
- [ ] Focusing on...
- [ ] Letting go of...
- [ ] Celebrating...

## 📝 Final Thoughts

---

**Review Date:** {{date:format:MMMM D, YYYY}} at {{time}}

**Tags:** #weekly-review #planning #goals #{{date:format:YYYY-MM}}`;

export class DailyReviewService {
	private app: App;
	private dailyNoteService: DailyNoteService;
	private settingsService: DailySettingsService;

	constructor(app: App, dailyNoteService: DailyNoteService, settingsService: DailySettingsService) {
		this.app = app;
		this.dailyNoteService = dailyNoteService;
		this.settingsService = settingsService;
	}

	/**
	 * Start the daily review by opening today's note and focusing on reflection sections.
	 */
	async startDailyReview(): Promise<void> {
		const todayNote = await this.ensureTodayNote();
		await this.highlightSections(todayNote, DAILY_REVIEW_HEADINGS);

		new Notice("Daily review ready—focus on Highlights, Reflections, and Looking Ahead.", 6000);
	}

	/**
	 * Create or open the current weekly review note using configured template.
	 */
	async startWeeklyReview(): Promise<void> {
		const file = await this.ensureWeeklyReviewNote();
		await this.highlightSections(file, WEEKLY_REVIEW_HEADINGS);

		new Notice("Weekly review loaded. Capture wins, challenges, and next week's focus.", 6000);
	}

	/**
	 * Display current streak stats in a notice.
	 */
	async showDailyStreakSummary(): Promise<void> {
		const streakData: StreakData = await this.dailyNoteService.getStreakData();
		const current = streakData.currentStreak || 0;
		const longest = streakData.longestStreak || 0;
		const total = streakData.totalDailyNotes || 0;
		const last = streakData.lastDailyNoteDate ? moment(streakData.lastDailyNoteDate).format("MMMM D, YYYY") : "No entries yet";

		new Notice(
			`Daily streak: ${current} day${current === 1 ? "" : "s"} • Longest: ${longest} • Notes logged: ${total} • Last note: ${last}`,
			7000
		);
	}

	private async ensureTodayNote(): Promise<TFile> {
		let todayNote = await this.dailyNoteService.getDailyNote();
		if (!todayNote) {
			todayNote = await this.dailyNoteService.createDailyNote();
		}

		await this.dailyNoteService.openDailyNote(new Date(), false);

		return todayNote;
	}

	private async ensureWeeklyReviewNote(): Promise<TFile> {
		const settings = await this.settingsService.getSettings();
		const now = moment();
		const reviewDay = typeof settings.weeklyReviewDay === "number" ? settings.weeklyReviewDay : 0;

		const referenceDate = now.clone();
		const targetThisWeek = now.clone().day(reviewDay);

		if (targetThisWeek.isAfter(now)) {
			targetThisWeek.subtract(7, "days");
		}

		const weekStart = targetThisWeek.clone().startOf("week");

		const baseDirectory = normalizePath(settings.dailyDirectoryPath || DEFAULT_DAILY_DIRECTORY_PATH);
		const weeklyDirectory = normalizePath(`${baseDirectory}/Weekly Reviews`);
		await this.ensureDirectory(weeklyDirectory);

		const fileName = `${weekStart.format("YYYY-MM-DD")} Weekly Review.md`;
		const filePath = normalizePath(`${weeklyDirectory}/${fileName}`);

		const existingFile = this.app.vault.getAbstractFileByPath(filePath);
		if (existingFile instanceof TFile) {
			await this.openFile(existingFile);
			return existingFile;
		}

		const templateContent = await this.loadWeeklyReviewTemplate();
		const rendered = await this.dailyNoteService.renderTemplate(templateContent, weekStart.toDate());
		const createdFile = await this.app.vault.create(filePath, rendered);

		await this.openFile(createdFile);
		return createdFile;
	}

	private async loadWeeklyReviewTemplate(): Promise<string> {
		const settings = await this.settingsService.getSettings();
		const templatePath = settings.weeklyReviewTemplate?.trim();

		if (templatePath) {
			const normalized = normalizePath(templatePath);
			const templateFile = this.app.vault.getAbstractFileByPath(normalized);
			if (templateFile instanceof TFile) {
				try {
					return await this.app.vault.read(templateFile);
				} catch (error) {
					console.warn("Failed to read weekly review template, falling back to default.", error);
				}
			}
		}

		return DEFAULT_WEEKLY_REVIEW_TEMPLATE;
	}

	private async highlightSections(file: TFile, headings: string[]): Promise<void> {
		const view = await this.waitForMarkdownView(file);
		if (!view) {
			return;
		}

		const editor = view.editor;
		if (!editor) {
			return;
		}

		try {
			const content = await this.app.vault.read(file);
			const lines = content.split("\n");

			for (const heading of headings) {
				const targetIndex = lines.findIndex(line => line.trim().toLowerCase().startsWith(heading.toLowerCase()));
				if (targetIndex !== -1) {
					const line = targetIndex;
					editor.setCursor({ line, ch: 0 });
					editor.scrollIntoView(
						{ from: { line, ch: 0 }, to: { line: Math.min(line + 3, editor.lineCount()), ch: 0 } },
						true
					);
					break;
				}
			}
		} catch (error) {
			console.warn("Failed to highlight daily review sections:", error);
		}
	}

	private async ensureDirectory(path: string): Promise<void> {
		const normalized = normalizePath(path);
		const parts = normalized.split("/").filter(Boolean);
		let currentPath = "";

		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(currentPath)) {
				await this.app.vault.createFolder(currentPath);
			}
		}
	}

	private async openFile(file: TFile): Promise<void> {
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
	}

	private async waitForMarkdownView(file: TFile, attempts = 10): Promise<MarkdownView | null> {
		for (let i = 0; i < attempts; i++) {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view?.file?.path === file.path) {
				return view;
			}
			await this.delay(120);
		}

		return null;
	}

	private async delay(ms: number): Promise<void> {
		return new Promise(resolve => window.setTimeout(resolve, ms));
	}
}
