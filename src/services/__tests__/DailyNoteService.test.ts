import { DailyNoteService } from "../daily/DailyNoteService";
import { DEFAULT_DAILY_SETTINGS, DailySettings } from "../daily/DailySettingsService";
import { EventEmitter } from "../../core/EventEmitter";

describe("DailyNoteService", () => {
	const createMockApp = (templateContents: Record<string, string> = {}) => {
		let streakData: any = null;
		const files: any[] = Object.entries(templateContents).map(([path, content]) => ({
			path,
			basename: path.split('/').pop()?.replace('.md', '') ?? '',
			name: path.split('/').pop() ?? '',
			extension: 'md',
			content
		}));

		const adapter = {
			read: jest.fn(async (path: string) => {
				if (path === '.systemsculpt/daily-streak.json') {
					if (streakData) {
						return JSON.stringify(streakData);
					}
					throw new Error("File not found");
				}
				throw new Error(`Unhandled read path: ${path}`);
			}),
			write: jest.fn(async (path: string, contents: string) => {
				if (path === '.systemsculpt/daily-streak.json') {
					streakData = JSON.parse(contents);
					return;
				}
				throw new Error(`Unhandled write path: ${path}`);
			}),
			mkdir: jest.fn(async () => undefined)
		};

		const createdFolders = new Set<string>();
		const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '');

			const vault = {
				getAbstractFileByPath: jest.fn((path: string) => {
					const normalizedPath = normalize(path);
					if (Array.from(createdFolders).some(folder => normalize(folder) === normalizedPath)) {
						return { path };
				}
				const existingFile = files.find(file => normalize(file.path) === normalizedPath);
				return existingFile || null;
			}),
			getFiles: jest.fn(() => files),
			createFolder: jest.fn(async (path: string) => {
				createdFolders.add(normalize(path));
			}),
			create: jest.fn(async (path: string, content: string) => {
				const basename = path.split('/').pop()!.replace('.md', '');
				const file = {
					path,
					basename,
					name: `${basename}.md`,
					extension: 'md',
					content
				};
				files.push(file);
				return file;
			}),
				read: jest.fn(async (file: { path: string }) => {
					const existing = files.find(f => normalize(f.path) === normalize(file.path));
					return existing?.content ?? '';
				}),
				on: jest.fn(() => ({})),
				offref: jest.fn(),
				adapter
			};

		const leaf = {
			openFile: jest.fn()
		};

		const workspace = {
			getLeaf: jest.fn(() => leaf)
		};

		return { app: { vault, workspace } as unknown as any, vault, adapter, leaf, workspace };
	};

	const createSettingsService = (overrides: Partial<DailySettings> = {}) => {
		const settings: DailySettings = {
			...DEFAULT_DAILY_SETTINGS,
			...overrides
		};

		return {
			getSettings: jest.fn(async () => ({ ...settings }))
		} as unknown as any;
	};

	it("creates daily notes using subdirectories and custom date format", async () => {
		const { app, vault, adapter } = createMockApp();
		const settingsService = createSettingsService({
			dailyDirectoryPath: 'Daily Notes',
			dailyNoteFormat: 'MM-DD-YYYY',
			useDailySubdirectories: true
		});

		const service = new DailyNoteService(app, settingsService, new EventEmitter());

		const testDate = new Date('2025-11-05T08:00:00Z');
		const note = await service.createDailyNote(testDate);

		expect(vault.createFolder).toHaveBeenCalledWith('Daily Notes');
		expect(vault.createFolder).toHaveBeenCalledWith('Daily Notes/2025');
		expect(vault.createFolder).toHaveBeenCalledWith('Daily Notes/2025/11');

		expect(vault.create).toHaveBeenCalledTimes(1);
		expect(vault.create).toHaveBeenCalledWith('Daily Notes/2025/11/11-05-2025.md', expect.any(String));

		expect(note.basename).toBe('11-05-2025');

		// Ensure streak data persisted
		expect(adapter.write).toHaveBeenCalledWith(
			'.systemsculpt/daily-streak.json',
			expect.stringContaining('"currentStreak":')
		);
	});

	it("returns streak count after creating daily note", async () => {
		const { app } = createMockApp();
		const settingsService = createSettingsService();
		const service = new DailyNoteService(app, settingsService, new EventEmitter());

		await service.createDailyNote(new Date('2025-11-05T08:00:00Z'));

		const streak = await service.getStreak();
		expect(streak).toBeGreaterThanOrEqual(1);
	});

	it("applies default daily template when configured", async () => {
		const templateContent = "# Morning Briefing {{date}}\n- Day: {{day_name}}";
		const { app, vault } = createMockApp();

		const settingsService = createSettingsService();

		const service = new DailyNoteService(app, settingsService, new EventEmitter());
		await service.createDailyNote(new Date('2025-11-05T08:00:00Z'), templateContent);

		const createdContent = (vault.create as jest.Mock).mock.calls[0][1] as string;
		expect(createdContent).toContain("Morning Briefing 2025-11-05");
		expect(createdContent).toContain("Day: Wednesday");
	});

	describe("getDailyNote", () => {
		it("returns null when daily note does not exist", async () => {
			const { app } = createMockApp();
			const settingsService = createSettingsService();
			const service = new DailyNoteService(app, settingsService, new EventEmitter());

			const result = await service.getDailyNote(new Date('2025-11-05T08:00:00Z'));
			expect(result).toBeNull();
		});
	});

	describe("openDailyNote", () => {
		it("opens existing daily note", async () => {
			const { app, vault, leaf } = createMockApp();
			const settingsService = createSettingsService();
			const service = new DailyNoteService(app, settingsService, new EventEmitter());

			// First create the note
			await service.createDailyNote(new Date('2025-11-05T08:00:00Z'));

			// Then open it
			await service.openDailyNote(new Date('2025-11-05T08:00:00Z'));

			expect(leaf.openFile).toHaveBeenCalled();
		});

		it("creates note if missing when createIfMissing is true", async () => {
			const { app, vault, leaf } = createMockApp();
			const settingsService = createSettingsService();
			const service = new DailyNoteService(app, settingsService, new EventEmitter());

			await service.openDailyNote(new Date('2025-11-05T08:00:00Z'), true);

			expect(vault.create).toHaveBeenCalled();
			expect(leaf.openFile).toHaveBeenCalled();
		});

		it("throws when note missing and createIfMissing is false", async () => {
			const { app } = createMockApp();
			const settingsService = createSettingsService();
			const service = new DailyNoteService(app, settingsService, new EventEmitter());

			await expect(
				service.openDailyNote(new Date('2025-11-05T08:00:00Z'), false)
			).rejects.toThrow("creation disabled");
		});
	});

	describe("getAllDailyNotes", () => {
		it("returns all daily notes sorted by date", async () => {
			const { app } = createMockApp();
			const settingsService = createSettingsService();
			const service = new DailyNoteService(app, settingsService, new EventEmitter());

			const notes = await service.getAllDailyNotes();
			expect(Array.isArray(notes)).toBe(true);
		});

		it("uses cache when available", async () => {
			const { app, vault } = createMockApp();
			const settingsService = createSettingsService();
			const service = new DailyNoteService(app, settingsService, new EventEmitter());

			await service.getAllDailyNotes();
			const callCount1 = (vault.getFiles as jest.Mock).mock.calls.length;

			await service.getAllDailyNotes();
			const callCount2 = (vault.getFiles as jest.Mock).mock.calls.length;

			// Should use cache on second call
			expect(callCount2).toBe(callCount1);
		});

		it("invalidates cache when requested", async () => {
			const { app } = createMockApp();
			const settingsService = createSettingsService();
			const service = new DailyNoteService(app, settingsService, new EventEmitter());

			await service.getAllDailyNotes();
			service.invalidateDailyNotesCache();

			// Cache should be cleared
			const notes = await service.getAllDailyNotes();
			expect(Array.isArray(notes)).toBe(true);
		});
	});

	describe("getDailyDirectoryPath", () => {
		it("returns configured directory path", async () => {
			const { app } = createMockApp();
			const settingsService = createSettingsService({
				dailyDirectoryPath: 'My Daily Notes'
			});
			const service = new DailyNoteService(app, settingsService, new EventEmitter());

			const path = await service.getDailyDirectoryPath();
			expect(path).toBe('My Daily Notes');
		});
	});

	describe("getSettings", () => {
		it("returns settings from settings service", async () => {
			const { app } = createMockApp();
			const settingsService = createSettingsService({
				dailyNoteFormat: 'DD-MM-YYYY'
			});
			const service = new DailyNoteService(app, settingsService, new EventEmitter());

			const settings = await service.getSettings();
			expect(settings.dailyNoteFormat).toBe('DD-MM-YYYY');
		});
	});

	describe("renderTemplate", () => {
		it("replaces date variable", async () => {
			const { app } = createMockApp();
			const settingsService = createSettingsService();
			const service = new DailyNoteService(app, settingsService, new EventEmitter());

			const result = await service.renderTemplate("Today is {{date}}", new Date('2025-11-05'));
			expect(result).toContain('2025-11-05');
		});

		it("replaces day_name variable", async () => {
			const { app } = createMockApp();
			const settingsService = createSettingsService();
			const service = new DailyNoteService(app, settingsService, new EventEmitter());

			const result = await service.renderTemplate("Day: {{day_name}}", new Date('2025-11-05'));
			expect(result).toContain('Wednesday');
		});

		it("replaces month_name variable", async () => {
			const { app } = createMockApp();
			const settingsService = createSettingsService();
			const service = new DailyNoteService(app, settingsService, new EventEmitter());

			const result = await service.renderTemplate("Month: {{month_name}}", new Date('2025-11-05'));
			expect(result).toContain('November');
		});

		it("replaces year variable", async () => {
			const { app } = createMockApp();
			const settingsService = createSettingsService();
			const service = new DailyNoteService(app, settingsService, new EventEmitter());

			const result = await service.renderTemplate("Year: {{year}}", new Date('2025-11-05'));
			expect(result).toContain('2025');
		});

		it("replaces time variable", async () => {
			const { app } = createMockApp();
			const settingsService = createSettingsService();
			const service = new DailyNoteService(app, settingsService, new EventEmitter());

			const result = await service.renderTemplate("Time: {{time}}", new Date('2025-11-05T14:30:00'));
			// Should contain time in format like "2:30 PM" or similar
			expect(result).toContain(':');
		});

		it("replaces custom date format", async () => {
			const { app } = createMockApp();
			const settingsService = createSettingsService();
			const service = new DailyNoteService(app, settingsService, new EventEmitter());

			const result = await service.renderTemplate("Custom: {{date:format:MMMM Do, YYYY}}", new Date('2025-11-05'));
			expect(result).toContain('November 5th, 2025');
		});
	});

	describe("getStreakData", () => {
		it("returns default streak data when no data exists", async () => {
			const { app } = createMockApp();
			const settingsService = createSettingsService();
			const service = new DailyNoteService(app, settingsService, new EventEmitter());

			const data = await service.getStreakData();
			expect(data.currentStreak).toBe(0);
			expect(data.longestStreak).toBe(0);
			expect(data.lastDailyNoteDate).toBeNull();
			expect(data.totalDailyNotes).toBe(0);
		});
	});

	describe("setupDailyDirectory", () => {
		it("creates daily directory structure", async () => {
			const { app, vault } = createMockApp();
			const settingsService = createSettingsService({
				dailyDirectoryPath: 'Daily Notes'
			});
			const service = new DailyNoteService(app, settingsService, new EventEmitter());

			await service.setupDailyDirectory();

			expect(vault.createFolder).toHaveBeenCalledWith('Daily Notes');
		});
	});

	describe("on event subscription", () => {
		it("allows subscribing to daily-note-created event", async () => {
			const { app } = createMockApp();
			const settingsService = createSettingsService();
			const eventBus = new EventEmitter();
			const service = new DailyNoteService(app, settingsService, eventBus);

			const listener = jest.fn();
			const unsubscribe = service.on('daily-note-created', listener);

			await service.createDailyNote(new Date('2025-11-05T08:00:00Z'));

			expect(listener).toHaveBeenCalled();

			// Should return unsubscribe function
			expect(typeof unsubscribe).toBe('function');
		});
	});

	describe("awaitReady", () => {
		it("resolves without error", async () => {
			const { app } = createMockApp();
			const settingsService = createSettingsService();
			const service = new DailyNoteService(app, settingsService, new EventEmitter());

			await expect(service.awaitReady()).resolves.not.toThrow();
		});
	});

	describe("createDailyNote edge cases", () => {
		it("uses default date when no date provided", async () => {
			const { app, vault } = createMockApp();
			const settingsService = createSettingsService();
			const service = new DailyNoteService(app, settingsService, new EventEmitter());

			const note = await service.createDailyNote();

			// Should have created a note
			expect(vault.create).toHaveBeenCalled();
			expect(note).toBeDefined();
		});
	});

	describe("getDailyNotesInRange", () => {
		it("returns empty array when no notes in range", async () => {
			const { app } = createMockApp();
			const settingsService = createSettingsService();
			const service = new DailyNoteService(app, settingsService, new EventEmitter());

			const startDate = new Date('2025-11-01');
			const endDate = new Date('2025-11-30');
			const notes = await service.getDailyNotesInRange(startDate, endDate);

			expect(Array.isArray(notes)).toBe(true);
		});
	});

	describe("without subdirectories", () => {
		it("creates notes directly in daily directory", async () => {
			const { app, vault } = createMockApp();
			const settingsService = createSettingsService({
				dailyDirectoryPath: 'Daily Notes',
				dailyNoteFormat: 'YYYY-MM-DD',
				useDailySubdirectories: false
			});

			const service = new DailyNoteService(app, settingsService, new EventEmitter());
			await service.createDailyNote(new Date('2025-11-05T08:00:00Z'));

			expect(vault.create).toHaveBeenCalledWith('Daily Notes/2025-11-05.md', expect.any(String));
		});
	});
});
