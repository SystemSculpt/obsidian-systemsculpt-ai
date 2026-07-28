export function captureStartupIdentity(): jest.SpyInstance {
  return jest.spyOn(console, "debug").mockImplementation(() => undefined);
}

export function expectProductionStartupIdentity(
  debugSpy: jest.SpyInstance,
  version: string,
): void {
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  expect(debugSpy).toHaveBeenCalledWith(
    expect.stringMatching(
      new RegExp(
        `^\\[SystemSculpt\\] v${escapedVersion} build `
          + "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
      ),
    ),
  );
}
