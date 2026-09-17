import { readMediaModelFavorites, toggleMediaModelFavorite } from "../studioMediaModelFavorites";

function plugin(initial: Partial<Record<"favoriteImageModels" | "favoriteVideoModels", unknown>> = {}) {
  const settings: Record<string, unknown> = { favoriteImageModels: [], favoriteVideoModels: [], ...initial };
  const updateSettings = jest.fn(async (patch: Record<string, unknown>) => { Object.assign(settings, patch); });
  return { settings, getSettingsManager: () => ({ updateSettings }), updateSettings };
}

it("stores favorites per media kind and reports the new state", async () => {
  const host = plugin({ favoriteVideoModels: ["maker/clip", 7] });
  expect(readMediaModelFavorites(host as never, "video")).toEqual(["maker/clip"]);
  await expect(toggleMediaModelFavorite(host as never, "image", "maker/alpha")).resolves.toBe(true);
  await expect(toggleMediaModelFavorite(host as never, "image", "maker/beta")).resolves.toBe(true);
  await expect(toggleMediaModelFavorite(host as never, "image", "maker/alpha")).resolves.toBe(false);
  expect(host.updateSettings).toHaveBeenLastCalledWith({ favoriteImageModels: ["maker/beta"] });
  expect(readMediaModelFavorites(host as never, "video")).toEqual(["maker/clip"]);
});
