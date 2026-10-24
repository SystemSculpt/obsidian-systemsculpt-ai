import { readMediaModelFavorites, toggleMediaModelFavorite } from "../studioMediaModelFavorites";

function plugin(initial: Partial<Record<"favoriteImageModels" | "favoriteVideoModels", unknown>> = {}) {
  const settings: Record<string, unknown> = { favoriteImageModels: [], favoriteVideoModels: [], ...initial };
  const updateSettings = jest.fn(async (patch: Record<string, unknown>) => { Object.assign(settings, patch); });
  return { settings, getSettingsManager: () => ({ updateSettings }), updateSettings };
}

it("toggles video favorites without changing retired image preferences", async () => {
  const host = plugin({ favoriteVideoModels: ["maker/clip", 7], favoriteImageModels: ["saved/image"] });
  expect(readMediaModelFavorites(host as never)).toEqual(["maker/clip"]);
  await expect(toggleMediaModelFavorite(host as never, "maker/alpha")).resolves.toBe(true);
  await expect(toggleMediaModelFavorite(host as never, "maker/beta")).resolves.toBe(true);
  await expect(toggleMediaModelFavorite(host as never, "maker/alpha")).resolves.toBe(false);
  expect(host.updateSettings).toHaveBeenLastCalledWith({ favoriteVideoModels: ["maker/clip", "maker/beta"] });
  expect(readMediaModelFavorites(host as never)).toEqual(["maker/clip", "maker/beta"]);
  expect(host.settings.favoriteImageModels).toEqual(["saved/image"]);
});
