/**
 * @jest-environment jsdom
 */

import { App } from "obsidian";
import { ListSelectionModal, ListItem } from "../ListSelectionModal";

// Mock FavoriteToggle to avoid complex model dependency
jest.mock("../../../../../components/FavoriteToggle", () => ({
  FavoriteToggle: jest.fn().mockImplementation(() => ({})),
}));

// Mock PlatformContext
jest.mock("../../../../../services/PlatformContext", () => ({
  PlatformContext: {
    get: () => ({ isMobile: () => false }),
  },
}));

// Mock KeyboardNavigationService
jest.mock("../../../services/KeyboardNavigationService", () => ({
  KeyboardNavigationService: jest.fn().mockImplementation(() => ({
    setItemCount: jest.fn(),
    clearFocus: jest.fn(),
    unload: jest.fn(),
  })),
}));

// FavoritesService mock factory
const makeFavoritesService = (showFavoritesOnly = false) => ({
  toggleShowFavoritesOnly: jest.fn().mockResolvedValue(!showFavoritesOnly),
  getShowFavoritesOnly: jest.fn().mockReturnValue(showFavoritesOnly),
  filterModelsByFavorites: jest.fn((models: any[]) => models),
  sortModelsByFavorites: jest.fn((models: any[]) => models),
  processFavorites: jest.fn(),
  addFavorite: jest.fn(),
  removeFavorite: jest.fn(),
  toggleFavorite: jest.fn(),
  isFavorite: jest.fn().mockReturnValue(false),
  getFavorites: jest.fn().mockReturnValue([]),
  clearAllFavorites: jest.fn(),
  getFavoritesFirst: jest.fn().mockReturnValue(false),
  setFavoritesFirst: jest.fn(),
  getFavoriteIds: jest.fn().mockReturnValue(new Set()),
});

const makeItems = (): ListItem[] => [
  { id: "item-1", title: "Item One" },
  { id: "item-2", title: "Item Two" },
];

describe("ListSelectionModal favorites filter button", () => {
  let app: App;

  beforeEach(() => {
    app = new (App as any)();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("renders the favorites filter button when favoritesService is provided", () => {
    const favoritesService = makeFavoritesService() as any;
    const modal = new ListSelectionModal(app, makeItems(), {
      title: "Test",
      favoritesService,
    });
    modal.open();

    const btn = modal.contentEl.querySelector(".systemsculpt-favorites-filter");
    expect(btn).not.toBeNull();
  });

  it("does NOT render the favorites filter button when no favoritesService is provided", () => {
    const modal = new ListSelectionModal(app, makeItems(), {
      title: "Test",
    });
    modal.open();

    const btn = modal.contentEl.querySelector(".systemsculpt-favorites-filter");
    expect(btn).toBeNull();
  });

  it("button has is-active class when showFavoritesOnly is true", () => {
    const favoritesService = makeFavoritesService(true) as any;
    const modal = new ListSelectionModal(app, makeItems(), {
      title: "Test",
      favoritesService,
    });
    modal.open();

    const btn = modal.contentEl.querySelector(".systemsculpt-favorites-filter");
    expect(btn).not.toBeNull();
    expect(btn!.classList.contains("is-active")).toBe(true);
  });

  it("button does NOT have is-active class when showFavoritesOnly is false", () => {
    const favoritesService = makeFavoritesService(false) as any;
    const modal = new ListSelectionModal(app, makeItems(), {
      title: "Test",
      favoritesService,
    });
    modal.open();

    const btn = modal.contentEl.querySelector(".systemsculpt-favorites-filter");
    expect(btn).not.toBeNull();
    expect(btn!.classList.contains("is-active")).toBe(false);
  });

  it("clicking the button calls toggleShowFavoritesOnly", async () => {
    const favoritesService = makeFavoritesService(false) as any;
    const modal = new ListSelectionModal(app, makeItems(), {
      title: "Test",
      favoritesService,
    });
    modal.open();

    const btn = modal.contentEl.querySelector(
      ".systemsculpt-favorites-filter"
    ) as HTMLElement;
    expect(btn).not.toBeNull();

    btn.click();
    await Promise.resolve();

    expect(favoritesService.toggleShowFavoritesOnly).toHaveBeenCalledTimes(1);
  });

  it("clicking the button toggles the is-active class", async () => {
    const favoritesService = makeFavoritesService(false) as any;
    // Each click should flip getShowFavoritesOnly
    let showFavoritesOnly = false;
    favoritesService.toggleShowFavoritesOnly.mockImplementation(async () => {
      showFavoritesOnly = !showFavoritesOnly;
      favoritesService.getShowFavoritesOnly.mockReturnValue(showFavoritesOnly);
    });

    const modal = new ListSelectionModal(app, makeItems(), {
      title: "Test",
      favoritesService,
    });
    modal.open();

    const btn = modal.contentEl.querySelector(
      ".systemsculpt-favorites-filter"
    ) as HTMLElement;
    expect(btn.classList.contains("is-active")).toBe(false);

    btn.click();
    await Promise.resolve();
    expect(btn.classList.contains("is-active")).toBe(true);

    btn.click();
    await Promise.resolve();
    expect(btn.classList.contains("is-active")).toBe(false);
  });

  it("filters list to show only favorites when active", async () => {
    const favoritesService = makeFavoritesService(false) as any;
    // When toggle is called, flip getShowFavoritesOnly to true
    favoritesService.toggleShowFavoritesOnly.mockImplementation(async () => {
      favoritesService.getShowFavoritesOnly.mockReturnValue(true);
    });

    const items: ListItem[] = [
      { id: "m1", title: "Model A", metadata: { isFavorite: true } },
      { id: "m2", title: "Model B", metadata: { isFavorite: false } },
      { id: "m3", title: "Model C", metadata: { isFavorite: true } },
    ];

    const modal = new ListSelectionModal(app, items, {
      title: "Select",
      favoritesService,
    });
    modal.open();

    // All 3 items should be visible initially
    const allItems = modal.contentEl.querySelectorAll(".ss-modal__item");
    expect(allItems.length).toBe(3);

    // Click the filter button (async handler: toggle resolves, then handleSearch runs)
    const filterBtn = modal.contentEl.querySelector(
      ".systemsculpt-favorites-filter"
    ) as HTMLElement;
    filterBtn.click();

    // Wait for the async toggle to resolve
    await Promise.resolve();

    // After filtering, only the 2 favorites should be visible
    const visibleItems = modal.contentEl.querySelectorAll(".ss-modal__item");
    expect(visibleItems.length).toBe(2);
  });
});
