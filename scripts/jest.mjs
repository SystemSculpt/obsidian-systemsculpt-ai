import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const jestBin = path.resolve(__dirname, "..", "node_modules", "jest", "bin", "jest.js");
const preload = path.resolve(__dirname, "jest-preload.cjs");

const rawArgs = process.argv.slice(2);
let strictConsole = false;
let debugConsole = false;
const jestArgs = [];

for (const arg of rawArgs) {
  if (arg === "--strict-console") {
    strictConsole = true;
    continue;
  }
  if (arg === "--debug-console") {
    debugConsole = true;
    continue;
  }
  jestArgs.push(arg);
}

const existingNodeOptions = process.env.NODE_OPTIONS ?? "";
const requireFlag = `--require ${preload}`;
const nextNodeOptions = existingNodeOptions.includes(preload)
  ? existingNodeOptions
  : [requireFlag, existingNodeOptions].filter(Boolean).join(" ");

const child = spawn(process.execPath, [jestBin, ...jestArgs], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_OPTIONS: nextNodeOptions,
    ...(strictConsole ? { SYSTEMSCULPT_TEST_STRICT_CONSOLE: "1" } : {}),
    ...(debugConsole ? { SYSTEMSCULPT_TEST_DEBUG: "1" } : {}),
  },
});

child.on("exit", (code, signal) => {
  if (typeof code === "number") process.exit(code);
  if (signal) process.kill(process.pid, signal);
  process.exit(1);
});
