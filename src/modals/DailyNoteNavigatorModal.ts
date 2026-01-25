import { App, Modal, Notice, Setting } from "obsidian";
import moment from "moment";
import { DailyNoteService } from "../services/daily/DailyNoteService";

interface RecentDateEntry {
	label: string;
	date: moment.Moment;
	hasNote: boolean;
}

export class DailyNoteNavigatorModal extends Modal {
	private dailyNoteService: DailyNoteService;
	private initialDate: Date | null;

	constructor(app: App, dailyNoteService: DailyNoteService, initialDate: Date | null = null) {
		super(app);
		this.dailyNoteService = dailyNoteService;
		this.initialDate = initialDate;
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("systemsculpt-daily-navigator");
		this.contentEl.empty();

		const settings = await this.dailyNoteService.getSettings();
		const dateFormat = settings.dailyNoteFormat || "YYYY-MM-DD";
		const today = moment();

		let selectedDateIso = moment(this.initialDate || today).format("YYYY-MM-DD");
		let createIfMissing = true;

		const header = this.contentEl.createDiv("daily-navigator-header");
		header.createEl("h2", { text: "Daily Note Navigator" });
		header.createEl("p", {
			text: "Jump to any date, open yesterday’s note, or create a fresh page in seconds.",
			cls: "daily-navigator-subtitle"
		});

		const quickActions = this.contentEl.createDiv("daily-navigator-quick-actions");

		const openToday = quickActions.createEl("button", { text: `Open Today (${today.format(dateFormat)})`, cls: "mod-cta" });
		openToday.onclick = async () => {
			try {
				await this.dailyNoteService.openDailyNote(today.toDate(), true);
				this.close();
			} catch (error) {
				new Notice(`Couldn't open today's note: ${error instanceof Error ? error.message : String(error)}`, 5000);
			}
		};

		const yesterday = today.clone().subtract(1, "day");
		const openYesterday = quickActions.createEl("button", { text: `Open Yesterday (${yesterday.format(dateFormat)})` });
		openYesterday.onclick = async () => {
			try {
				await this.dailyNoteService.openDailyNote(yesterday.toDate(), false);
				this.close();
			} catch (error) {
				new Notice("Yesterday's note isn't created yet—try another date or enable creation.", 5000);
			}
		};

		new Setting(this.contentEl)
			.setName("Pick a specific date")
			.setDesc("We’ll open the note and create it if missing (optional).")
			.addText((text) => {
				text.inputEl.type = "date";
				text.setValue(selectedDateIso);
				text.onChange((value) => {
					selectedDateIso = value;
				});
			});

		new Setting(this.contentEl)
			.setName("Create note if it does not exist")
			.addToggle((toggle) => {
				toggle.setValue(createIfMissing);
				toggle.onChange((value) => {
					createIfMissing = value;
				});
			});

		const goButton = this.contentEl.createEl("button", { text: "Open Selected Date", cls: "mod-cta daily-navigator-submit" });
		goButton.onclick = async () => {
			if (!selectedDateIso) {
				new Notice("Choose a date first.");
				return;
			}

			const parsed = moment(selectedDateIso, "YYYY-MM-DD", true);
			if (!parsed.isValid()) {
				new Notice("That date doesn’t look valid—try again.");
				return;
			}

			try {
				await this.dailyNoteService.openDailyNote(parsed.toDate(), createIfMissing);
				this.close();
			} catch (error) {
				new Notice(`Unable to open that daily note: ${error instanceof Error ? error.message : String(error)}`, 6000);
			}
		};

		const recentContainer = this.contentEl.createDiv("daily-navigator-recent");
		recentContainer.createEl("h3", { text: "Recent dates" });
		const recentList = recentContainer.createDiv("daily-navigator-recent-list");

		const recentEntries = await this.buildRecentEntries(dateFormat);
		recentEntries.forEach((entry) => {
			const button = recentList.createEl("button", { cls: "daily-navigator-recent-item" });
			button.createSpan({ text: entry.label, cls: "daily-navigator-recent-label" });
			button.createSpan({
				text: entry.hasNote ? "Saved" : "Missing",
				cls: entry.hasNote ? "is-available" : "is-missing"
			});

			button.onclick = async () => {
				try {
					selectedDateIso = entry.date.format("YYYY-MM-DD");
					await this.dailyNoteService.openDailyNote(entry.date.toDate(), createIfMissing);
					this.close();
				} catch (error) {
					new Notice(`Could not open ${entry.label}: ${error instanceof Error ? error.message : String(error)}`, 5000);
				}
			};
		});

		if (recentEntries.length === 0) {
			recentList.createSpan({ text: "No recent notes yet—your first entry will appear here.", cls: "daily-navigator-empty" });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async buildRecentEntries(dateFormat: string): Promise<RecentDateEntry[]> {
		const today = moment();
		const allNotes = await this.dailyNoteService.getAllDailyNotes();
		const recent: RecentDateEntry[] = [];

		for (let offset = 0; offset < 7; offset++) {
			const date = today.clone().subtract(offset, "day");
			const formatted = date.format(dateFormat);
			const hasNote = allNotes.some((note) => note.basename === formatted);

			recent.push({
				label: date.format("ddd, MMM D"),
				date,
				hasNote
			});
		}

		return recent;
	}
}
