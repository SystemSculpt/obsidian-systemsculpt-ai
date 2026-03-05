import { StudioTerminalSidecarBackend } from "../terminal/StudioTerminalSidecarBackend";

describe("StudioTerminalSidecarBackend", () => {
  const createPlugin = () => {
    const logger = {
      warn: jest.fn(),
    };
    const plugin = {
      getLogger: () => logger,
    } as any;
    return { plugin, logger };
  };

  it("does not warn for expected sidecar connection misses during refresh", async () => {
    const { plugin, logger } = createPlugin();
    const disconnected = {
      state: "disconnected",
      protocol: "studio.terminal.sidecar.v1",
      pid: null,
      startedAt: null,
      updatedAt: new Date().toISOString(),
      lastHeartbeatAt: null,
      lastClientSeenAt: null,
      timeoutMinutes: 15,
      timeoutAt: null,
      activeConnections: 0,
      sessionCount: 0,
      sessions: [],
      lastShutdownReason: "",
      socketPath: "/tmp/test.sock",
      vaultKey: "abc",
      message: "Unable to connect to terminal sidecar: connect ENOENT /tmp/test.sock.",
    };
    const backend = new StudioTerminalSidecarBackend(plugin, {
      client: {
        fetchStatus: jest.fn(async () => {
          throw new Error("Unable to connect to terminal sidecar: connect ENOENT /tmp/test.sock.");
        }),
        getSidecarStatus: jest.fn(() => disconnected),
      } as any,
    });

    const status = await backend.refreshSidecarStatus();
    expect(status?.state).toBe("disconnected");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns once for repeated unexpected sidecar refresh errors", async () => {
    const { plugin, logger } = createPlugin();
    const backend = new StudioTerminalSidecarBackend(plugin, {
      client: {
        fetchStatus: jest.fn(async () => {
          throw new Error("bad payload shape");
        }),
        getSidecarStatus: jest.fn(() => null),
      } as any,
    });

    const firstStatus = await backend.refreshSidecarStatus();
    const secondStatus = await backend.refreshSidecarStatus();
    expect(firstStatus).toBeNull();
    expect(secondStatus).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("does not warn for expected sidecar connection misses during peek", async () => {
    const { plugin, logger } = createPlugin();
    const backend = new StudioTerminalSidecarBackend(plugin, {
      client: {
        peekSession: jest.fn(async () => {
          throw new Error("Unable to connect to terminal sidecar: connect ENOENT /tmp/test.sock.");
        }),
      } as any,
    });

    const snapshot = await backend.peekSession({ sessionId: "session-a" });
    expect(snapshot).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
