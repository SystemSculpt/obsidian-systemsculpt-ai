import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveWindowsInteractiveTempRoot } from "./common.mjs";
import { parseJsonText, stripUtf8Bom } from "../../shared/json.mjs";

function fail(message) {
  throw new Error(message);
}

function assertWindowsHost() {
  if (process.platform !== "win32") {
    fail("Interactive Windows tasks can only run on a Windows host.");
  }
}

export function resolveDefaultInteractiveUser(env = process.env) {
  const username = String(env.USERNAME || "").trim();
  const userDomain = String(env.USERDOMAIN || "").trim();
  if (userDomain && username) {
    return `${userDomain}\\${username}`;
  }
  return username || "administrator";
}

export function buildInteractiveUserCandidates(value) {
  const requested = String(value || "").trim();
  if (!requested) {
    return ["administrator", ".\\administrator"];
  }

  const candidates = [];
  const seen = new Set();
  const append = (candidate) => {
    const normalized = String(candidate || "").trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(normalized);
  };

  append(requested);

  const shortUser = requested.split(/[\\/]/).pop();
  if (shortUser && shortUser !== requested) {
    append(shortUser);
    append(`.\\${shortUser}`);
  } else if (shortUser) {
    append(`.\\${shortUser}`);
  }

  return candidates;
}

function psSingleQuote(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function runPowerShellScript(scriptPath) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    {
      encoding: "utf8",
      stdio: "pipe",
    }
  );

  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`PowerShell failed.${output ? `\n${output}` : ""}`);
  }
  return result;
}

function buildPowerShellScriptPath(tempDir, fileName) {
  return path.join(tempDir, fileName);
}

export function buildWrappedInteractiveTaskScript(scriptContent, resultPath) {
  return [
    `$systemSculptInteractiveResultPath = ${psSingleQuote(resultPath)}`,
    "try {",
    scriptContent,
    "  if (!(Test-Path $systemSculptInteractiveResultPath)) {",
    "    [ordered]@{",
    "      ok = $false",
    "      error = 'Interactive script completed without writing a result file.'",
    "      sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId",
    "      finishedAt = (Get-Date).ToString('o')",
    "    } | ConvertTo-Json -Depth 5 | Set-Content -Path $systemSculptInteractiveResultPath -Encoding UTF8",
    "    exit 1",
    "  }",
    "} catch {",
    "  [ordered]@{",
    "    ok = $false",
    "    error = $_.Exception.Message",
    "    detail = ($_ | Out-String)",
    "    sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId",
    "    failedAt = (Get-Date).ToString('o')",
    "  } | ConvertTo-Json -Depth 6 | Set-Content -Path $systemSculptInteractiveResultPath -Encoding UTF8",
    "  exit 1",
    "}",
    "",
  ].join("\n");
}

function readScheduledTaskInfo(taskName) {
  const tempDir = fs.mkdtemp(path.join(os.tmpdir(), "systemsculpt-obsidian-task-info-"));
  return tempDir.then(async (createdDir) => {
    const scriptPath = buildPowerShellScriptPath(createdDir, "task-info.ps1");
    await fs.writeFile(
      scriptPath,
      [
        "$ErrorActionPreference = 'Stop'",
        `$taskName = ${psSingleQuote(taskName)}`,
        "$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue",
        "$info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue",
        "[ordered]@{",
        "  taskName = $taskName",
        "  taskState = if ($task) { [string]$task.State } else { $null }",
        "  lastRunTime = if ($info) { $info.LastRunTime.ToString('o') } else { $null }",
        "  lastTaskResult = if ($info) { [int]$info.LastTaskResult } else { $null }",
        "  numberOfMissedRuns = if ($info) { [int]$info.NumberOfMissedRuns } else { $null }",
        "} | ConvertTo-Json -Depth 4",
        "",
      ].join("\n"),
      "utf8"
    );

    try {
      const result = runPowerShellScript(scriptPath);
      return parseJsonText(String(result.stdout || "{}").trim() || "{}");
    } catch {
      return null;
    } finally {
      await fs.rm(createdDir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

export async function unregisterInteractiveTask(taskName) {
  assertWindowsHost();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "systemsculpt-obsidian-task-cleanup-"));
  const scriptPath = buildPowerShellScriptPath(tempDir, "cleanup-task.ps1");
  await fs.writeFile(
    scriptPath,
    [
      "$ErrorActionPreference = 'Stop'",
      `Unregister-ScheduledTask -TaskName ${psSingleQuote(taskName)} -Confirm:$false -ErrorAction SilentlyContinue | Out-Null`,
      "",
    ].join("\n"),
    "utf8"
  );
  try {
    runPowerShellScript(scriptPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runInteractiveWindowsPowerShell(options = {}) {
  assertWindowsHost();

  const taskNamePrefix = String(options.taskNamePrefix || "SystemSculptInteractive").trim() || "SystemSculptInteractive";
  const interactiveUser =
    String(options.interactiveUser || resolveDefaultInteractiveUser(process.env)).trim() || "administrator";
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 60_000);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || 500);
  const hostTempRoot = resolveWindowsInteractiveTempRoot(process.env);
  const tempDir = await fs.mkdtemp(path.join(hostTempRoot, "systemsculpt-obsidian-interactive-"));
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const taskName = `${taskNamePrefix}_${nonce}`;
  const taskScriptPath = buildPowerShellScriptPath(tempDir, "interactive-task.ps1");
  const schedulerScriptPath = buildPowerShellScriptPath(tempDir, "schedule-task.ps1");
  const resultPath = path.resolve(String(options.resultPath || path.join(tempDir, "result.json")));
  const scriptContent = String(options.scriptContent || "").trim();

  if (!scriptContent) {
    fail("Missing interactive PowerShell script content.");
  }

  await fs.writeFile(taskScriptPath, buildWrappedInteractiveTaskScript(scriptContent, resultPath), "utf8");
  await fs.writeFile(
    schedulerScriptPath,
    [
      "$ErrorActionPreference = 'Stop'",
      `$taskName = ${psSingleQuote(taskName)}`,
      `$taskScriptPath = ${psSingleQuote(taskScriptPath)}`,
      `$interactiveUser = ${psSingleQuote(interactiveUser)}`,
      `$taskWorkingDirectory = ${psSingleQuote(path.dirname(taskScriptPath))}`,
      `Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null`,
      `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $taskScriptPath + '"') -WorkingDirectory $taskWorkingDirectory`,
      "$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(2)",
      "$principalUserId = $interactiveUser",
      `$principalCandidates = @(${buildInteractiveUserCandidates(interactiveUser).map(psSingleQuote).join(", ")})`,
      "foreach ($candidate in $principalCandidates) {",
      "  try {",
      "    $principalUserId = ([System.Security.Principal.NTAccount]$candidate).Translate([System.Security.Principal.SecurityIdentifier]).Value",
      "    break",
      "  } catch {}",
      "}",
      "$principal = New-ScheduledTaskPrincipal -UserId $principalUserId -LogonType Interactive -RunLevel Highest",
      "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -StartWhenAvailable",
      "Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null",
      "Start-ScheduledTask -TaskName $taskName",
      "",
    ].join("\n"),
    "utf8"
  );

  try {
    runPowerShellScript(schedulerScriptPath);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const raw = await fs.readFile(resultPath, "utf8");
        const trimmed = stripUtf8Bom(String(raw || "")).trim();
        if (!trimmed) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          continue;
        }

        let parsed = null;
        try {
          parsed = parseJsonText(trimmed);
        } catch (error) {
          if (error instanceof SyntaxError) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
            continue;
          }
          throw error;
        }

        return {
          taskName,
          resultPath,
          raw: trimmed,
          parsed,
        };
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    const taskInfo = await readScheduledTaskInfo(taskName);
    fail(
      `Timed out waiting for interactive task output at ${resultPath}. Task: ${taskName}${
        taskInfo ? ` Task info: ${JSON.stringify(taskInfo)}` : ""
      }`
    );
  } finally {
    await unregisterInteractiveTask(taskName).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
