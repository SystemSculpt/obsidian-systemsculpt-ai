import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRepositoryScopedGitEnvironment } from "./repository-git.mjs";

export function assertCanonicalWatcherCheckout(root) {
  const resolved = fs.realpathSync(root);
  const paths = execFileSync("git", ["-C", resolved, "rev-parse", "--path-format=absolute",
    "--show-toplevel", "--git-dir", "--git-common-dir"], {
    encoding: "utf8", env: createRepositoryScopedGitEnvironment(), stdio: ["ignore", "pipe", "pipe"],
  }).trim().split(/\r?\n/).map((entry) => fs.realpathSync(entry));
  if (paths.length !== 3 || paths[0] !== resolved || paths[1] !== paths[2]) {
    throw new Error("Start or install the watcher from the main Git checkout, never a linked worktree.");
  }
}

function processIdentity(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "uid=", "-o", "command="], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"],
    }).trim() || null;
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
}

function readLock(lockPath) {
  try {
    const descriptor = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o022) || stat.size > 16384) {
        throw new Error("Watcher lock ownership is ambiguous; inspect it manually before starting.");
      }
      const text = fs.readFileSync(descriptor, "utf8").trim();
      let record;
      try { record = JSON.parse(text); } catch { record = null; }
      return { record, text, ino: stat.ino, dev: stat.dev };
    } finally { fs.closeSync(descriptor); }
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function removeOwnedLock(lockPath, observed) {
  const current = readLock(lockPath);
  if (!current) return;
  if (current.ino !== observed.ino || current.dev !== observed.dev || current.text !== observed.text) {
    throw new Error("Watcher ownership changed during handover; retry after the other start finishes.");
  }
  fs.unlinkSync(lockPath);
}

function withHandover(lockPath, releasing, operation) {
  if (typeof process.getuid !== "function") throw new Error("The shell watcher requires a POSIX host.");
  const handover = `${lockPath}.handover`;
  try { fs.mkdirSync(handover, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    // The next owner removes our old record after the child and shell exit.
    if (releasing) return;
    throw new Error("Watcher handover is busy; if no startup is running, inspect the handover directory manually.");
  }
  try { return operation(); }
  finally { fs.rmdirSync(handover); }
}

export function acquireWatcherLock(options) {
  return withHandover(options.lockPath, false, () => acquireUnlocked(options));
}

function acquireUnlocked({ lockPath, pid, root, identity = processIdentity,
  signal = (target) => process.kill(target, "SIGTERM"),
  sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50), attempts = 100 }) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid watcher process ID.");
  const ownIdentity = identity(pid);
  if (!ownIdentity) throw new Error("Cannot verify the starting watcher process.");
  const existing = readLock(lockPath);
  if (existing) {
    const record = existing.record;
    const priorPid = Number.isSafeInteger(record?.pid) ? record.pid : Number(existing.text);
    if (!Number.isSafeInteger(priorPid) || priorPid <= 1) {
      throw new Error("Watcher lock is malformed; inspect it manually before starting.");
    }
    const live = identity(priorPid);
    if (live) {
      if (record?.version !== 1 || record.root !== root || !record.identity || live !== record.identity || priorPid === pid) {
        throw new Error("Existing watcher process identity is ambiguous or changed; stop it manually before starting.");
      }
      // Revalidate immediately before signaling; never escalate an uncertain PID to SIGKILL.
      if (identity(priorPid) !== live) throw new Error("Watcher process changed before handover; retry safely.");
      signal(priorPid);
      let remaining = attempts;
      while (identity(priorPid) === live && remaining-- > 0) sleep();
      if (identity(priorPid) === live) throw new Error("Previous watcher did not stop; no replacement was started.");
    }
    removeOwnedLock(lockPath, existing);
  }
  fs.writeFileSync(lockPath, JSON.stringify({ version: 1, pid, root, identity: ownIdentity }), { flag: "wx", mode: 0o600 });
}

export function releaseWatcherLock({ lockPath, pid, identity = processIdentity }) {
  return withHandover(lockPath, true, () => {
    const existing = readLock(lockPath);
    if (existing?.record?.pid === pid && existing.record.identity === identity(pid)) {
      removeOwnedLock(lockPath, existing);
    }
  });
}

export async function runWatcher({ root, lockPath, command, args = [], spawnChild = spawn,
  acquire = acquireWatcherLock, release = releaseWatcherLock, events = process }) {
  assertCanonicalWatcherCheckout(root);
  const owner = { root, lockPath, pid: process.pid };
  let acquired = false;
  let child;
  let requestedSignal;
  const stop = (signal) => {
    requestedSignal = signal;
    // ChildProcess tracks exit/reaping; a saved shell PID cannot offer that guarantee.
    if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  // Install before publishing ownership: a concurrent handover may stop us
  // as soon as the lock exists, including while the child is being spawned.
  events.on("SIGINT", interrupt);
  events.on("SIGTERM", terminate);
  try {
    acquire(owner);
    acquired = true;
    if (requestedSignal) return requestedSignal === "SIGINT" ? 130 : 143;
    child = spawnChild(command, args, { cwd: root, stdio: "inherit" });
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
      if (requestedSignal) stop(requestedSignal);
    });
  } finally {
    events.removeListener("SIGINT", interrupt);
    events.removeListener("SIGTERM", terminate);
    if (acquired) release(owner);
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const [command, root, lockPath, executable, ...args] = process.argv.slice(2);
    if (command === "check") assertCanonicalWatcherCheckout(root);
    else if (command === "run" && executable) {
      process.exitCode = await runWatcher({ root, lockPath, command: executable, args });
    }
    else throw new Error("Unknown watcher ownership command.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
