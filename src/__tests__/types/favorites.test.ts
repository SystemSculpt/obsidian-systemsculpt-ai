/**
 * @jest-environment node
 */
import {
  DEFAULT_FAVORITES_FILTER_SETTINGS,
  type FavoriteModel,
  type FavoritesFilterSettings,
} from "../../types/favorites";

describe("DEFAULT_FAVORITES_FILTER_SETTINGS", () => {
  it("has showFavoritesOnly set to false", () => {
    expect(DEFAULT_FAVORITES_FILTER_SETTINGS.showFavoritesOnly).toBe(false);
  });

  it("has favoritesFirst set to true", () => {
    expect(DEFAULT_FAVORITES_FILTER_SETTINGS.favoritesFirst).toBe(true);
  });

  it("has modelSortOrder set to default", () => {
    expect(DEFAULT_FAVORITES_FILTER_SETTINGS.modelSortOrder).toBe("default");
  });

  it("is a valid FavoritesFilterSettings object", () => {
    const settings: FavoritesFilterSettings = DEFAULT_FAVORITES_FILTER_SETTINGS;
    expect(settings).toBeDefined();
    expect(typeof settings.showFavoritesOnly).toBe("boolean");
    expect(typeof settings.favoritesFirst).toBe("boolean");
    expect(["default", "alphabetical"]).toContain(settings.modelSortOrder);
  });
});

describe("FavoriteModel type", () => {
  it("can create a basic favorite model", () => {
    const favorite: FavoriteModel = {
      provider: "openai",
      modelId: "openai@@gpt-4",
    };

    expect(favorite.provider).toBe("openai");
    expect(favorite.modelId).toBe("openai@@gpt-4");
    expect(favorite.addedAt).toBeUndefined();
  });

  it("can create a favorite model with timestamp", () => {
    const timestamp = Date.now();
    const favorite: FavoriteModel = {
      provider: "anthropic",
      modelId: "anthropic@@claude-3-opus",
      addedAt: timestamp,
    };

    expect(favorite.provider).toBe("anthropic");
    expect(favorite.modelId).toBe("anthropic@@claude-3-opus");
    expect(favorite.addedAt).toBe(timestamp);
  });

  it("can have systemsculpt as provider", () => {
    const favorite: FavoriteModel = {
      provider: "systemsculpt",
      modelId: "systemsculpt@@custom-model",
    };

    expect(favorite.provider).toBe("systemsculpt");
    expect(favorite.modelId).toContain("systemsculpt");
  });
});

describe("FavoritesFilterSettings type", () => {
  it("can create settings with alphabetical sort", () => {
    const settings: FavoritesFilterSettings = {
      showFavoritesOnly: true,
      favoritesFirst: false,
      modelSortOrder: "alphabetical",
    };

    expect(settings.showFavoritesOnly).toBe(true);
    expect(settings.favoritesFirst).toBe(false);
    expect(settings.modelSortOrder).toBe("alphabetical");
  });

  it("can create settings with default sort", () => {
    const settings: FavoritesFilterSettings = {
      showFavoritesOnly: false,
      favoritesFirst: true,
      modelSortOrder: "default",
    };

    expect(settings.modelSortOrder).toBe("default");
  });
});
