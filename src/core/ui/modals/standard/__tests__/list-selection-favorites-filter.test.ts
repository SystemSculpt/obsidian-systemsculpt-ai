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

  it("clicking the button calls toggleShowFavoritesOnly", () => {
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

    expect(favoritesService.toggleShowFavoritesOnly).toHaveBeenCalledTimes(1);
  });

  it("clicking the button toggles the is-active class", () => {
    const favoritesService = makeFavoritesService(false) as any;
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
    expect(btn.classList.contains("is-active")).toBe(true);

    btn.click();
    expect(btn.classList.contains("is-active")).toBe(false);
  });
});
