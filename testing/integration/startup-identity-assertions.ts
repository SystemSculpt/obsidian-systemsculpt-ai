export function captureStartupIdentity(): jest.SpyInstance {
  return jest.spyOn(console, "debug").mockImplementation(() => undefined);
}

export function expectProductionStartupIdentity(
  debugSpy: jest.SpyInstance,
  version: string,
): void {
  expect(debugSpy).toHaveBeenCalledWith(
    `[SystemSculpt] v${version} build release-${version}`,
  );
}
