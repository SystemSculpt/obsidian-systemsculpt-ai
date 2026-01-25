/**
 * @jest-environment jsdom
 */
import { FavoritesService } from "../FavoritesService";
import { SystemSculptModel } from "../../types/llm";

// Mock modelUtils
jest.mock("../../utils/modelUtils", () => ({
  ensureCanonicalId: jest.fn((id: string, _provider?: string) => id),
}));

describe("FavoritesService", () => {
  let service: FavoritesService;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();
    FavoritesService.clearInstance();

    mockPlugin = {
      settings: {
        favoriteModels: [],
        favoritesFilterSettings: {
          showFavoritesOnly: false,
          favoritesFirst: false,
          modelSortOrder: "default",
        },
      },
      getSettingsManager: jest.fn().mockReturnValue({
        updateSettings: jest.fn().mockResolvedValue(undefined),
        saveSettings: jest.fn().mockResolvedValue(undefined),
      }),
    };

    service = FavoritesService.getInstance(mockPlugin);
  });

  afterEach(() => {
    FavoritesService.clearInstance();
  });

  describe("getInstance", () => {
    it("returns singleton instance", () => {
      const instance1 = FavoritesService.getInstance(mockPlugin);
      const instance2 = FavoritesService.getInstance(mockPlugin);

      expect(instance1).toBe(instance2);
    });
  });

  describe("clearInstance", () => {
    it("clears the singleton instance", () => {
      const instance1 = FavoritesService.getInstance(mockPlugin);
      FavoritesService.clearInstance();
      const instance2 = FavoritesService.getInstance(mockPlugin);

      expect(instance1).not.toBe(instance2);
    });
  });

  describe("addFavorite", () => {
    it("adds model to favorites", async () => {
      const model: SystemSculptModel = {
        id: "gpt-4",
        name: "GPT-4",
        provider: "openai",
        isFavorite: false,
      } as SystemSculptModel;

      await service.addFavorite(model);

      expect(model.isFavorite).toBe(true);
      expect(mockPlugin.getSettingsManager().updateSettings).toHaveBeenCalled();
    });

    it("skips if model is already favorite", async () => {
      const model: SystemSculptModel = {
        id: "gpt-4",
        name: "GPT-4",
        provider: "openai",
        isFavorite: true,
      } as SystemSculptModel;

      await service.addFavorite(model);

      expect(mockPlugin.getSettingsManager().updateSettings).not.toHaveBeenCalled();
    });

    it("deduplicates favorites", async () => {
      mockPlugin.settings.favoriteModels = [
        { provider: "openai", modelId: "gpt-4", addedAt: 1000 },
      ];

      const model: SystemSculptModel = {
        id: "gpt-4",
        name: "GPT-4",
        provider: "openai",
        isFavorite: false,
      } as SystemSculptModel;

      await service.addFavorite(model);

      const updateCall = mockPlugin.getSettingsManager().updateSettings.mock.calls[0][0];
      expect(updateCall.favoriteModels.length).toBe(1);
    });
  });

  describe("removeFavorite", () => {
    it("removes model from favorites", async () => {
      mockPlugin.settings.favoriteModels = [
        { provider: "openai", modelId: "gpt-4", addedAt: 1000 },
      ];

      const model: SystemSculptModel = {
        id: "gpt-4",
        name: "GPT-4",
        provider: "openai",
        isFavorite: true,
      } as SystemSculptModel;

      await service.removeFavorite(model);

      expect(model.isFavorite).toBe(false);
      expect(mockPlugin.getSettingsManager().updateSettings).toHaveBeenCalled();
    });

    it("skips if model is not favorite", async () => {
      const model: SystemSculptModel = {
        id: "gpt-4",
        name: "GPT-4",
        provider: "openai",
        isFavorite: false,
      } as SystemSculptModel;

      await service.removeFavorite(model);

      expect(mockPlugin.getSettingsManager().updateSettings).not.toHaveBeenCalled();
    });
  });

  describe("toggleFavorite", () => {
    it("adds favorite if not currently favorite", async () => {
      const model: SystemSculptModel = {
        id: "gpt-4",
        name: "GPT-4",
        provider: "openai",
        isFavorite: false,
      } as SystemSculptModel;

      await service.toggleFavorite(model);

      expect(model.isFavorite).toBe(true);
    });

    it("removes favorite if currently favorite", async () => {
      mockPlugin.settings.favoriteModels = [
        { provider: "openai", modelId: "gpt-4", addedAt: 1000 },
      ];

      const model: SystemSculptModel = {
        id: "gpt-4",
        name: "GPT-4",
        provider: "openai",
        isFavorite: true,
      } as SystemSculptModel;

      await service.toggleFavorite(model);

      expect(model.isFavorite).toBe(false);
    });
  });

  describe("isFavorite", () => {
    it("returns true for favorite model", () => {
      const model: SystemSculptModel = {
        id: "gpt-4",
        name: "GPT-4",
        provider: "openai",
        isFavorite: true,
      } as SystemSculptModel;

      expect(service.isFavorite(model)).toBe(true);
    });

    it("returns false for non-favorite model", () => {
      const model: SystemSculptModel = {
        id: "gpt-4",
        name: "GPT-4",
        provider: "openai",
        isFavorite: false,
      } as SystemSculptModel;

      expect(service.isFavorite(model)).toBe(false);
    });
  });

  describe("getFavorites", () => {
    it("returns only favorite models", () => {
      const models: SystemSculptModel[] = [
        { id: "gpt-4", name: "GPT-4", provider: "openai", isFavorite: true } as SystemSculptModel,
        { id: "gpt-3.5", name: "GPT-3.5", provider: "openai", isFavorite: false } as SystemSculptModel,
        { id: "claude-3", name: "Claude 3", provider: "anthropic", isFavorite: true } as SystemSculptModel,
      ];

      const favorites = service.getFavorites(models);

      expect(favorites.length).toBe(2);
      expect(favorites[0].id).toBe("gpt-4");
      expect(favorites[1].id).toBe("claude-3");
    });

    it("returns empty array if no favorites", () => {
      const models: SystemSculptModel[] = [
        { id: "gpt-4", name: "GPT-4", provider: "openai", isFavorite: false } as SystemSculptModel,
      ];

      const favorites = service.getFavorites(models);

      expect(favorites.length).toBe(0);
    });
  });

  describe("clearAllFavorites", () => {
    it("clears all favorites", async () => {
      const models: SystemSculptModel[] = [
        { id: "gpt-4", name: "GPT-4", provider: "openai", isFavorite: true } as SystemSculptModel,
        { id: "claude-3", name: "Claude 3", provider: "anthropic", isFavorite: true } as SystemSculptModel,
      ];

      await service.clearAllFavorites(models);

      expect(models[0].isFavorite).toBe(false);
      expect(models[1].isFavorite).toBe(false);
      expect(mockPlugin.getSettingsManager().updateSettings).toHaveBeenCalledWith({ favoriteModels: [] });
    });
  });

  describe("processFavorites", () => {
    it("marks models as favorites from settings", () => {
      mockPlugin.settings.favoriteModels = [
        { provider: "openai", modelId: "gpt-4", addedAt: 1000 },
      ];

      const models: SystemSculptModel[] = [
        { id: "gpt-4", name: "GPT-4", provider: "openai", isFavorite: false } as SystemSculptModel,
        { id: "gpt-3.5", name: "GPT-3.5", provider: "openai", isFavorite: false } as SystemSculptModel,
      ];

      service.processFavorites(models);

      expect(models[0].isFavorite).toBe(true);
      expect(models[1].isFavorite).toBe(false);
    });

    it("resets all isFavorite flags first", () => {
      mockPlugin.settings.favoriteModels = [];

      const models: SystemSculptModel[] = [
        { id: "gpt-4", name: "GPT-4", provider: "openai", isFavorite: true } as SystemSculptModel,
      ];

      service.processFavorites(models);

      expect(models[0].isFavorite).toBe(false);
    });

    it("preserves favorites for models not in list", () => {
      mockPlugin.settings.favoriteModels = [
        { provider: "openai", modelId: "unknown-model", addedAt: 1000 },
        { provider: "openai", modelId: "gpt-4", addedAt: 2000 },
      ];

      const models: SystemSculptModel[] = [
        { id: "gpt-4", name: "GPT-4", provider: "openai", isFavorite: false } as SystemSculptModel,
      ];

      service.processFavorites(models);

      // The found model should be marked as favorite
      expect(models[0].isFavorite).toBe(true);
      // The unknown model should still be in the favorites list (canonical version)
      const favIds = service.getFavoriteIds();
      expect(favIds.has("unknown-model")).toBe(true);
    });
  });

  describe("sortModelsByFavorites", () => {
    const models: SystemSculptModel[] = [
      { id: "gpt-3.5", name: "GPT-3.5", provider: "openai", isFavorite: false } as SystemSculptModel,
      { id: "gpt-4", name: "GPT-4", provider: "openai", isFavorite: true } as SystemSculptModel,
      { id: "claude-3", name: "Claude 3", provider: "anthropic", isFavorite: false } as SystemSculptModel,
    ];

    it("returns original order when no sorting enabled", () => {
      mockPlugin.settings.favoritesFilterSettings.favoritesFirst = false;
      mockPlugin.settings.favoritesFilterSettings.modelSortOrder = "default";

      const sorted = service.sortModelsByFavorites(models);

      expect(sorted[0].id).toBe("gpt-3.5");
    });

    it("sorts favorites first when enabled", () => {
      mockPlugin.settings.favoritesFilterSettings.favoritesFirst = true;
      mockPlugin.settings.favoritesFilterSettings.modelSortOrder = "default";

      const sorted = service.sortModelsByFavorites(models);

      expect(sorted[0].id).toBe("gpt-4");
      expect(sorted[0].isFavorite).toBe(true);
    });

    it("sorts alphabetically when enabled", () => {
      mockPlugin.settings.favoritesFilterSettings.favoritesFirst = false;
      mockPlugin.settings.favoritesFilterSettings.modelSortOrder = "alphabetical";

      const sorted = service.sortModelsByFavorites(models);

      // Sorted by provider first (anthropic < openai), then by name
      expect(sorted[0].provider).toBe("anthropic");
    });

    it("sorts favorites first then alphabetically", () => {
      mockPlugin.settings.favoritesFilterSettings.favoritesFirst = true;
      mockPlugin.settings.favoritesFilterSettings.modelSortOrder = "alphabetical";

      const sorted = service.sortModelsByFavorites(models);

      // Favorite first, then alphabetical for non-favorites
      expect(sorted[0].id).toBe("gpt-4");
      expect(sorted[1].provider).toBe("anthropic");
    });
  });

  describe("filterModelsByFavorites", () => {
    const models: SystemSculptModel[] = [
      { id: "gpt-4", name: "GPT-4", provider: "openai", isFavorite: true } as SystemSculptModel,
      { id: "gpt-3.5", name: "GPT-3.5", provider: "openai", isFavorite: false } as SystemSculptModel,
    ];

    it("returns all models when filter disabled", () => {
      mockPlugin.settings.favoritesFilterSettings.showFavoritesOnly = false;

      const filtered = service.filterModelsByFavorites(models);

      expect(filtered.length).toBe(2);
    });

    it("returns only favorites when filter enabled", () => {
      mockPlugin.settings.favoritesFilterSettings.showFavoritesOnly = true;

      const filtered = service.filterModelsByFavorites(models);

      expect(filtered.length).toBe(1);
      expect(filtered[0].id).toBe("gpt-4");
    });
  });

  describe("toggleShowFavoritesOnly", () => {
    it("toggles showFavoritesOnly setting", async () => {
      mockPlugin.settings.favoritesFilterSettings.showFavoritesOnly = false;

      const result = await service.toggleShowFavoritesOnly();

      expect(result).toBe(true);
      expect(mockPlugin.getSettingsManager().updateSettings).toHaveBeenCalled();
    });
  });

  describe("getShowFavoritesOnly", () => {
    it("returns current filter state", () => {
      mockPlugin.settings.favoritesFilterSettings.showFavoritesOnly = true;

      expect(service.getShowFavoritesOnly()).toBe(true);
    });
  });

  describe("setFavoritesFirst", () => {
    it("sets favoritesFirst setting", async () => {
      await service.setFavoritesFirst(true);

      expect(mockPlugin.getSettingsManager().updateSettings).toHaveBeenCalled();
    });
  });

  describe("getFavoritesFirst", () => {
    it("returns favoritesFirst setting", () => {
      mockPlugin.settings.favoritesFilterSettings.favoritesFirst = true;

      expect(service.getFavoritesFirst()).toBe(true);
    });
  });

  describe("getFavoriteIds", () => {
    it("returns set of favorite IDs", () => {
      mockPlugin.settings.favoriteModels = [
        { provider: "openai", modelId: "gpt-4", addedAt: 1000 },
        { provider: "anthropic", modelId: "claude-3", addedAt: 2000 },
      ];

      const ids = service.getFavoriteIds();

      expect(ids.has("gpt-4")).toBe(true);
      expect(ids.has("claude-3")).toBe(true);
      expect(ids.size).toBe(2);
    });

    it("returns empty set when no favorites", () => {
      mockPlugin.settings.favoriteModels = [];

      const ids = service.getFavoriteIds();

      expect(ids.size).toBe(0);
    });
  });

  describe("event emission", () => {
    it("emits favorites-changed event on addFavorite", async () => {
      const listener = jest.fn();
      document.addEventListener("systemsculpt:favorites-changed", listener);

      const model: SystemSculptModel = {
        id: "gpt-4",
        name: "GPT-4",
        provider: "openai",
        isFavorite: false,
      } as SystemSculptModel;

      await service.addFavorite(model);

      expect(listener).toHaveBeenCalled();

      document.removeEventListener("systemsculpt:favorites-changed", listener);
    });

    it("emits favorites-filter-changed event on toggleShowFavoritesOnly", async () => {
      const listener = jest.fn();
      document.addEventListener("systemsculpt:favorites-filter-changed", listener);

      await service.toggleShowFavoritesOnly();

      expect(listener).toHaveBeenCalled();

      document.removeEventListener("systemsculpt:favorites-filter-changed", listener);
    });
  });
});
