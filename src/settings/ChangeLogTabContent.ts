import { Notice, setIcon, MarkdownRenderer } from "obsidian";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { ChangeLogService, ChangeLogEntry } from "../services/ChangeLogService";

const RELEASES_PER_BATCH = 10;

async function renderReleaseEntry(entry: ChangeLogEntry, parentEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
    const entryEl = parentEl.createEl("div", { cls: "systemsculpt-changelog-entry" });

    const headerEl = entryEl.createEl("div", { cls: "systemsculpt-changelog-entry-header" });
    headerEl.createEl("h4", { text: `Version ${entry.version}` });
    headerEl.createEl("span", { cls: "systemsculpt-changelog-entry-date", text: entry.date });

    const notesEl = entryEl.createEl("div", { cls: "systemsculpt-changelog-entry-notes-markdown" });
    await MarkdownRenderer.renderMarkdown(entry.notes, notesEl, '', tabInstance.plugin);

    const linkEl = entryEl.createEl("a", {
        cls: "systemsculpt-changelog-entry-link",
        href: entry.url,
        text: "View on GitHub",
        attr: { target: "_blank", rel: "noopener noreferrer" },
    });
    setIcon(linkEl, "external-link");
}

export async function displayChangeLogTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
    containerEl.empty();
    if (containerEl.classList.contains('systemsculpt-tab-content')) {
        containerEl.dataset.tab = "changelog";
    }

    containerEl.createEl("h3", { text: "Plugin Change Log" });
    const changelogListEl = containerEl.createEl("div", { cls: "systemsculpt-changelog-list" });
    const loadingEl = changelogListEl.createEl("p", { text: "Loading all releases..." });

    let allFetchedReleases: ChangeLogEntry[] = [];
    let displayedReleasesCount = 0;
    let loadMoreButtonEl: HTMLButtonElement | null = null;
    let loadMoreContainerEl: HTMLElement | null = null; 

    function updateLoadMoreButtonState() {
        if (!loadMoreButtonEl) return;

        const remaining = allFetchedReleases.length - displayedReleasesCount;
        if (remaining > 0) {
            loadMoreButtonEl.setText(`Load More Releases (${remaining} remaining)`);
            loadMoreButtonEl.style.display = "inline-block"; 
        } else {
            loadMoreButtonEl.style.display = "none"; 
        }
    }
    
    async function displayNextBatchAndManageButton() {
        const startIndex = displayedReleasesCount;
        const endIndex = Math.min(startIndex + RELEASES_PER_BATCH, allFetchedReleases.length);
        
        if (startIndex >= allFetchedReleases.length) { 
            updateLoadMoreButtonState();
            return;
        }

        const batchToDisplay = allFetchedReleases.slice(startIndex, endIndex);
        for (const entry of batchToDisplay) {
            await renderReleaseEntry(entry, changelogListEl, tabInstance);
        }

        displayedReleasesCount = endIndex;
        updateLoadMoreButtonState(); 
    }

    try {
        allFetchedReleases = await ChangeLogService.getReleases(tabInstance.plugin);
        loadingEl.remove();

        if (allFetchedReleases.length === 0) {
            changelogListEl.createEl("p", { text: "No changelog information available at the moment." });
        } else {
            await displayNextBatchAndManageButton();

            if (allFetchedReleases.length > displayedReleasesCount) {
                if (!loadMoreContainerEl) { 
                    loadMoreContainerEl = containerEl.createEl("div", { cls: "systemsculpt-load-more-container" });
                }
                loadMoreButtonEl = loadMoreContainerEl.createEl("button", {
                    text: "Load More Releases", 
                    cls: "systemsculpt-load-more-button mod-cta" 
                });
                loadMoreButtonEl.addEventListener("click", () => displayNextBatchAndManageButton());
                updateLoadMoreButtonState(); 
            }
        }
    } catch (error) {
        loadingEl.remove();
        
        // Check if this is a rate limit error (403)
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('403')) {
            // For rate limit errors, show a more gentle message without a Notice
            const rateLimitEl = changelogListEl.createEl("p", { cls: "systemsculpt-changelog-rate-limit" });
            rateLimitEl.setText("Changelog temporarily unavailable due to GitHub API rate limiting. Please try again in a few minutes.");
        } else {
            // For other errors, show the original error handling
            const errorEl = changelogListEl.createEl("p", { cls: "systemsculpt-changelog-error" });
            errorEl.setText("Failed to load changelog. Please check your internet connection or try again later.");
            new Notice("Failed to fetch changelog from GitHub.");
        }
    }

    const allReleasesLinkContainer = containerEl.createEl("div", { cls: "systemsculpt-all-releases-link-container" });
    const allReleasesLink = allReleasesLinkContainer.createEl("a", {
        href: ChangeLogService.getReleasesPageUrl(),
        text: "View All Releases on GitHub",
        cls: "systemsculpt-all-releases-link",
        attr: { target: "_blank", rel: "noopener noreferrer" },
    });
    setIcon(allReleasesLink, "github");
} 
