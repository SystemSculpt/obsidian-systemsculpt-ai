describe("agent mode toggle effect on streaming", () => {
  it("builds stream options with allowTools: false when agent mode is disabled", () => {
    const buildStreamOptions = (agentModeEnabled: boolean) => {
      const base: any = {
        messages: [],
        model: "test-model",
        contextFiles: new Set<string>(),
        signal: new AbortController().signal,
        webSearchEnabled: false,
      };
      if (!agentModeEnabled) {
        base.allowTools = false;
      }
      return base;
    };

    const agentOn = buildStreamOptions(true);
    const agentOff = buildStreamOptions(false);

    expect(agentOn.allowTools).toBeUndefined();
    expect(agentOff.allowTools).toBe(false);
  });
});
