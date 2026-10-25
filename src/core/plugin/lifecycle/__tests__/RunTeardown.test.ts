import { Component } from "obsidian";
import { registerRunTeardown } from "../RunTeardown";

const children = (owner: Component): unknown[] => (owner as unknown as { children: unknown[] }).children;

/** Obsidian's removeChild unloads the child; the shared mock only drops it. */
class UnloadingOwner extends Component {
  removeChild<T extends Component>(child: T): T {
    super.removeChild(child);
    child.unload();
    return child;
  }
}

describe("registerRunTeardown", () => {
  it("runs the teardown once when the owner unloads before the run settles", () => {
    const owner = new Component();
    owner.load();
    const teardown = jest.fn();
    const release = registerRunTeardown(owner, teardown);

    owner.unload();
    release();

    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("leaves nothing registered after release, so a later unload runs nothing", () => {
    const owner = new Component();
    owner.load();
    const teardown = jest.fn();
    const release = registerRunTeardown(owner, teardown);
    expect(children(owner)).toHaveLength(1);

    release();
    release();
    expect(children(owner)).toHaveLength(0);
    owner.unload();

    expect(teardown).not.toHaveBeenCalled();
  });

  it("does not run the teardown when Obsidian unloads the released child", () => {
    const owner = new UnloadingOwner();
    owner.load();
    const teardown = jest.fn();

    registerRunTeardown(owner, teardown)();
    owner.unload();

    expect(children(owner)).toHaveLength(0);
    expect(teardown).not.toHaveBeenCalled();
  });

  it("keeps each run's teardown separate", () => {
    const owner = new Component();
    owner.load();
    const finished = jest.fn();
    const running = jest.fn();
    registerRunTeardown(owner, finished)();
    registerRunTeardown(owner, running);

    owner.unload();

    expect(finished).not.toHaveBeenCalled();
    expect(running).toHaveBeenCalledTimes(1);
  });
});
