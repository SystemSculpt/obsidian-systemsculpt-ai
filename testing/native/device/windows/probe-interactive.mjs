#!/usr/bin/env node
import path from "node:path";
import { resolveWindowsInteractiveTempRoot } from "./common.mjs";
import { runInteractiveWindowsPowerShell } from "./interactive-task.mjs";

function usage() {
  console.log(`Usage: node testing/native/device/windows/probe-interactive.mjs [options]

Run a top-level window probe inside the active Windows desktop session without
bringing the VM to the foreground on the Mac. This is the first-line truth
source when a fresh Obsidian launch shows a trust or blocker modal.

Options:
  --match-title <text>   If provided, look for a window title containing this text
  --send-enter           Send Enter to the first matched window
  --send-escape          Send Escape to the first matched window
  --timeout-ms <n>       Interactive task timeout. Default: 30000
  --help, -h             Show this help
`);
}

function parseArgs(argv) {
  const options = {
    matchTitle: "",
    sendEnter: false,
    sendEscape: false,
    timeoutMs: 30_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--match-title") {
      options.matchTitle = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--send-enter") {
      options.sendEnter = true;
      continue;
    }
    if (arg === "--send-escape") {
      options.sendEscape = true;
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = Math.max(1000, Number(argv[index + 1]) || options.timeoutMs);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ...options, help: true };
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function buildProbeScript(options) {
  const matchTitle = JSON.stringify(String(options.matchTitle || "").trim().toLowerCase());
  const sendEnter = Boolean(options.sendEnter);
  const sendEscape = Boolean(options.sendEscape);
  const resultPath = JSON.stringify(String(options.resultPath || ""));

  const keyToSend = sendEnter ? "{ENTER}" : sendEscape ? "{ESC}" : "";

  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type @\"",
    "using System;",
    "using System.Text;",
    "using System.Runtime.InteropServices;",
    "public static class SystemSculptWindowProbe {",
    "  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);",
    "  [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);",
    "  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);",
    "  [DllImport(\"user32.dll\")] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);",
    "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);",
    "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);",
    "}",
    "\"@",
    `$resultPath = ${resultPath}`,
    `$matchTitle = ${matchTitle}`,
    "$windows = New-Object System.Collections.Generic.List[object]",
    "$callback = [SystemSculptWindowProbe+EnumWindowsProc]{",
    "  param($hWnd, $lParam)",
    "  $titleBuilder = New-Object System.Text.StringBuilder 1024",
    "  [SystemSculptWindowProbe]::GetWindowText($hWnd, $titleBuilder, $titleBuilder.Capacity) | Out-Null",
    "  $classBuilder = New-Object System.Text.StringBuilder 256",
    "  [SystemSculptWindowProbe]::GetClassName($hWnd, $classBuilder, $classBuilder.Capacity) | Out-Null",
    "  [uint32]$windowPid = 0",
    "  [SystemSculptWindowProbe]::GetWindowThreadProcessId($hWnd, [ref]$windowPid) | Out-Null",
    "  $processName = ''",
    "  try { $processName = (Get-Process -Id $windowPid -ErrorAction Stop).ProcessName } catch {}",
    "  $windows.Add([ordered]@{",
    "    hwnd = ('0x{0:X}' -f $hWnd.ToInt64())",
    "    title = $titleBuilder.ToString()",
    "    className = $classBuilder.ToString()",
    "    pid = [int]$windowPid",
    "    processName = $processName",
    "    visible = [bool][SystemSculptWindowProbe]::IsWindowVisible($hWnd)",
    "  }) | Out-Null",
    "  return $true",
    "}",
    "[SystemSculptWindowProbe]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null",
    "$matched = $null",
    "if ($matchTitle) {",
    "  $matched = $windows | Where-Object {",
    "    $_.visible -and $_.title -and $_.title.ToLowerInvariant().Contains($matchTitle)",
    "  } | Select-Object -First 1",
    "}",
    sendEnter || sendEscape
      ? [
          "if ($matched) {",
          "  $shell = New-Object -ComObject WScript.Shell",
          "  $shell.AppActivate([int]$matched.pid) | Out-Null",
          "  $hwndValue = [IntPtr]([Convert]::ToInt64(($matched.hwnd -replace '^0x', ''), 16))",
          "  [SystemSculptWindowProbe]::SetForegroundWindow($hwndValue) | Out-Null",
          "  Start-Sleep -Milliseconds 300",
          `  [System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(keyToSend)})`,
          "}",
        ].join("\n")
      : "",
    "$result = [ordered]@{",
    "  ok = $true",
    "  sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId",
    "  matched = $matched",
    "  windows = $windows",
    "}",
    "$result | ConvertTo-Json -Depth 6 | Set-Content -Path $resultPath -Encoding UTF8",
    "",
  ].join("\n");
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("Interactive Windows probing must run on the Windows host.");
  }

  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const resultPath = path.join(
    resolveWindowsInteractiveTempRoot(process.env),
    `systemsculpt-obsidian-probe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`
  );
  const result = await runInteractiveWindowsPowerShell({
    taskNamePrefix: "SystemSculptObsidianProbe",
    timeoutMs: options.timeoutMs,
    resultPath,
    scriptContent: buildProbeScript({
      ...options,
      resultPath,
    }),
  });

  console.log(JSON.stringify(result.parsed || null, null, 2));
}

main().catch((error) => {
  console.error(`[windows-probe] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
