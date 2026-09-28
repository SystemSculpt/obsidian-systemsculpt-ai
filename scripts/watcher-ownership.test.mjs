import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { acquireWatcherLock, releaseWatcherLock, assertCanonicalWatcherCheckout, runWatcher } from "./watcher-ownership.mjs";
import { installDevWatcherService } from "./dev-watcher-service.mjs";
import { createRepositoryScopedGitEnvironment, execRepositoryGitSync as git } from "./repository-git.mjs";

// The managed launchd/shell watcher is a POSIX development tool.
const test = process.platform === "win32" ? nodeTest.skip : nodeTest;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-watcher-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "watcher.lock");
  const processes = new Map([[10, "old-start uid bash run.sh"], [20, "new-start uid bash run.sh"]]);
  const signals = [];
  const options = { root, lockPath, pid: 20, identity: (pid) => processes.get(pid) ?? null,
    signal: (pid) => { signals.push(pid); processes.delete(pid); }, sleep: () => {}, attempts: 2 };
  const previous = () => fs.writeFileSync(lockPath, JSON.stringify({ version: 1, pid: 10, root, identity: processes.get(10) }), { mode: 0o600 });
  return { root, lockPath, processes, signals, options, previous };
}

test("only the recorded live watcher may be terminated during handover", (t) => {
  const f = fixture(t); f.previous();
  acquireWatcherLock(f.options);
  assert.deepEqual(f.signals, [10]);
  assert.equal(JSON.parse(fs.readFileSync(f.lockPath)).pid, 20);
  releaseWatcherLock({ ...f.options, pid: 10 });
  assert.ok(fs.existsSync(f.lockPath));
  releaseWatcherLock(f.options);
  assert.equal(fs.existsSync(f.lockPath), false);
});

test("recycled PIDs and live legacy locks fail closed without signals", (t) => {
  const f = fixture(t); f.previous();
  f.processes.set(10, "different-start uid unrelated-command");
  assert.throws(() => acquireWatcherLock(f.options), /identity is ambiguous or changed/);
  assert.deepEqual(f.signals, []);
  fs.writeFileSync(f.lockPath, "10\n");
  assert.throws(() => acquireWatcherLock(f.options), /identity is ambiguous or changed/);
  assert.deepEqual(f.signals, []);
});

test("a dead legacy owner is replaced without signaling", (t) => {
  const f = fixture(t); fs.writeFileSync(f.lockPath, "10\n", { mode: 0o600 });
  f.processes.delete(10);
  acquireWatcherLock(f.options);
  assert.deepEqual(f.signals, []);
  assert.equal(JSON.parse(fs.readFileSync(f.lockPath)).pid, 20);
});

test("identity changes immediately before a signal abort the handover", (t) => {
  const f = fixture(t); f.previous();
  let reads = 0;
  assert.throws(() => acquireWatcherLock({ ...f.options, identity: (pid) => {
    if (pid === 10 && ++reads > 1) return "recycled";
    return f.processes.get(pid);
  } }), /changed before handover/);
  assert.deepEqual(f.signals, []);
});

test("unresponsive owners are never escalated and retain the lock", (t) => {
  const f = fixture(t); f.previous();
  assert.throws(() => acquireWatcherLock({ ...f.options, signal: (pid) => f.signals.push(pid) }), /did not stop/);
  assert.deepEqual(f.signals, [10]);
  assert.equal(JSON.parse(fs.readFileSync(f.lockPath)).pid, 10);
});

test("concurrent handover cannot remove another owner's replacement lock", (t) => {
  const f = fixture(t); f.previous();
  assert.throws(() => acquireWatcherLock({ ...f.options, signal: () => {
    f.processes.delete(10);
    fs.writeFileSync(f.lockPath, JSON.stringify({ pid: 30, identity: "third" }));
  } }), /ownership changed/);
  assert.equal(JSON.parse(fs.readFileSync(f.lockPath)).pid, 30);
});

test("handover serializes competing acquires while allowing the old shell to exit", (t) => {
  const f = fixture(t); f.previous();
  acquireWatcherLock({ ...f.options, signal: () => {
    assert.throws(() => acquireWatcherLock({ ...f.options, pid: 30 }), /handover is busy/);
    releaseWatcherLock({ ...f.options, pid: 10 });
    assert.equal(JSON.parse(fs.readFileSync(f.lockPath)).pid, 10);
    f.processes.delete(10);
  } });
  assert.equal(JSON.parse(fs.readFileSync(f.lockPath)).pid, 20);
  assert.equal(fs.existsSync(`${f.lockPath}.handover`), false);
});

test("symlink locks cannot overwrite or signal on behalf of another file", (t) => {
  const f = fixture(t);
  const target = path.join(f.root, "unrelated");
  fs.writeFileSync(target, "10\n"); fs.symlinkSync(target, f.lockPath);
  assert.throws(() => acquireWatcherLock(f.options));
  assert.equal(fs.readFileSync(target, "utf8"), "10\n");
  assert.deepEqual(f.signals, []);
});

test("linked worktree start and install fail before dependency repair or launchd writes", (t) => {
  const f = fixture(t);
  const main = path.join(f.root, "main");
  const linked = path.join(f.root, "linked");
  git(["init", "--quiet", main]);
  fs.mkdirSync(path.join(main, "scripts"));
  for (const file of ["run.sh", "scripts/watcher-ownership.mjs", "scripts/repository-git.mjs"]) {
    fs.copyFileSync(new URL(`../${file}`, import.meta.url), path.join(main, file));
  }
  git(["-C", main, "add", "."]);
  git(["-C", main, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "fixture"]);
  git(["-C", main, "worktree", "add", "--quiet", "--detach", linked]);
  assert.doesNotThrow(() => assertCanonicalWatcherCheckout(main));
  assert.throws(() => assertCanonicalWatcherCheckout(linked), /never a linked worktree/);
  const home = path.join(f.root, "home");
  const commands = [];
  assert.throws(() => installDevWatcherService({ root: linked, home, platform: "darwin", uid: 501,
    runCommand: (...args) => commands.push(args) }), /never a linked worktree/);
  assert.deepEqual(commands, []);
  assert.equal(fs.existsSync(home), false);
  assert.throws(() => execFileSync("bash", [path.join(linked, "run.sh"), "--no-sync"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: createRepositoryScopedGitEnvironment({
      ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` }),
  }), (error) => {
    assert.match(error.stderr, /never a linked worktree/);
    assert.doesNotMatch(error.stdout, /Repairing JS dependencies/);
    return true;
  });
});

test("watcher lifetime forwards signals only to its live child handle and releases on close", async (t) => {
  const f = fixture(t);
  git(["init", "--quiet", f.root]);
  const events = new EventEmitter();
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null;
  const signals = []; child.kill = (signal) => signals.push(signal);
  const ownership = [];
  const running = runWatcher({ root: f.root, lockPath: f.lockPath, command: "unused", events,
    spawnChild: () => child, acquire: () => ownership.push("acquire"), release: () => ownership.push("release") });
  events.emit("SIGTERM");
  assert.deepEqual(signals, ["SIGTERM"]);
  child.exitCode = 0;
  events.emit("SIGTERM");
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.deepEqual(ownership, ["acquire"]);
  child.emit("close", 0, null);
  assert.equal(await running, 0);
  assert.deepEqual(ownership, ["acquire", "release"]);
  assert.equal(events.listenerCount("SIGTERM"), 0);
  assert.equal(events.listenerCount("SIGINT"), 0);
});

test("failed child startup releases watcher ownership", async (t) => {
  const f = fixture(t);
  git(["init", "--quiet", f.root]);
  let released = false;
  await assert.rejects(runWatcher({ root: f.root, lockPath: f.lockPath, command: "unused",
    spawnChild: () => { throw new Error("spawn failed"); }, acquire: () => {}, release: () => { released = true; } }), /spawn failed/);
  assert.equal(released, true);
});

test("shutdown during child spawn is retained and forwarded before waiting", async (t) => {
  const f = fixture(t);
  git(["init", "--quiet", f.root]);
  const events = new EventEmitter();
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null;
  child.kill = (signal) => { child.signalCode = signal; child.emit("close", null, signal); };
  let released = false;
  const result = await runWatcher({ root: f.root, lockPath: f.lockPath, command: "unused", events,
    spawnChild: () => { events.emit("SIGTERM"); return child; },
    acquire: () => {}, release: () => { released = true; } });
  assert.equal(result, 143);
  assert.equal(child.signalCode, "SIGTERM");
  assert.equal(released, true);
});

test("shutdown while publishing ownership prevents child spawn", async (t) => {
  const f = fixture(t);
  git(["init", "--quiet", f.root]);
  const events = new EventEmitter();
  let released = false;
  const result = await runWatcher({ root: f.root, lockPath: f.lockPath, command: "unused", events,
    spawnChild: () => assert.fail("must not start child after cancellation"),
    acquire: () => events.emit("SIGINT"), release: () => { released = true; } });
  assert.equal(result, 130);
  assert.equal(released, true);
});
