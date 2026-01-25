import { expect } from "@wdio/globals";
import fs from "node:fs/promises";
import path from "node:path";
import { ensurePluginEnabled, runCommand } from "../utils/obsidian";
import {
  configurePluginForLiveChat,
  ensureE2EVault,
  exportBenchmarkFailureArtifacts,
  getEnv,
  PLUGIN_ID,
  readLatestBenchmarkRun,
  requireEnv,
} from "../utils/systemsculptChat";

describe("BenchView (live)", () => {
  const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
  const serverUrl = getEnv("SYSTEMSCULPT_E2E_SERVER_URL");
  const selectedModelId = getEnv("SYSTEMSCULPT_E2E_MODEL_ID") ?? "systemsculpt@@systemsculpt/ai-agent";
  const benchDifficultyRaw = (getEnv("SYSTEMSCULPT_E2E_BENCH_DIFFICULTY") ?? "easy").toLowerCase();
  const benchDifficulty = (["all", "easy", "medium", "hard"] as const).includes(benchDifficultyRaw as any)
    ? (benchDifficultyRaw as "all" | "easy" | "medium" | "hard")
    : "easy";

  let vaultPath: string;

  const dumpBrowserLogs = async (label: string, runId?: string) => {
    try {
      // `browser` log type is not guaranteed across drivers, so keep best-effort.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const entries: any[] = await (browser as any).getLogs?.("browser");
      if (!Array.isArray(entries) || entries.length === 0) {
        console.log(`[bench] ${label}: no browser console logs captured.`);
        return;
      }

      const lines = entries.map((entry) => {
        const level = String(entry?.level ?? entry?.levelname ?? "INFO");
        const message = String(entry?.message ?? "");
        return `[${level}] ${message}`;
      });

      const maxLines = 250;
      const tail = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
      console.log(`[bench] ${label}: browser console logs (last ${tail.length}/${lines.length})\n${tail.join("\n")}`);

      if (runId) {
        const outputDir = path.join(process.cwd(), "testing", "e2e", "logs");
        await fs.mkdir(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, `bench-browser-logs-${runId}.txt`);
        await fs.writeFile(outputPath, tail.join("\n"));
        console.log(`[bench] ${label}: wrote browser console log tail to ${outputPath}`);
      }
    } catch (error: any) {
      console.log(`[bench] ${label}: browser console log capture failed: ${String(error?.message || error)}`);
    }
  };

  const dumpFailureArtifacts = async (artifactPath: string) => {
    try {
      const raw = await fs.readFile(artifactPath, "utf8");
      const parsed = JSON.parse(raw);
      const artifacts = parsed?.artifacts && typeof parsed.artifacts === "object" ? parsed.artifacts : {};

      for (const [caseId, payload] of Object.entries<any>(artifacts)) {
        const errors = Array.isArray(payload?.result?.errors) ? payload.result.errors : [];
        if (errors.length === 0) continue;
        console.log(`[bench] ${caseId}: errors\n${errors.join("\n\n")}`);
      }
    } catch (error: any) {
      console.log(`[bench] Failed to read artifacts from ${artifactPath}: ${String(error?.message || error)}`);
    }
  };

  before(async () => {
    vaultPath = await ensureE2EVault();
    await ensurePluginEnabled(PLUGIN_ID, vaultPath);
    await configurePluginForLiveChat({
      licenseKey,
      serverUrl,
      selectedModelId,
      settingsOverride: {
        mcpEnabled: true,
        mcpAutoAccept: false,
        toolingAutoApproveReadOnly: true,
      },
    });
  });

  it("starts a benchmark run and renders the sandbox prompt", async function () {
    this.timeout(180000);

    await runCommand("systemsculpt-ai:open-systemsculpt-benchmark");

    const viewRoot = await $(".systemsculpt-bench-view");
    await viewRoot.waitForExist({ timeout: 20000 });

    await browser.waitUntil(
      async () => {
        const filter = await browser.execute(() => {
          const el = document.querySelector(".benchview-difficulty-select") as HTMLSelectElement | null;
          if (!el) return null;
          return { value: el.value, options: Array.from(el.options).map((o) => o.value) };
        });
        if (!filter) return false;
        const { value, options } = filter as { value: string; options: string[] };
        return value === "all" && options.includes("all") && options.includes("easy") && options.includes("medium") && options.includes("hard");
      },
      { timeout: 20000, timeoutMsg: "Benchmark difficulty filter did not render." }
    );

    await browser.waitUntil(
      async () => {
        const groupTexts = await browser.execute(() => {
          const nodes = Array.from(document.querySelectorAll(".benchview-case-group"));
          return nodes.map((node) => (node.textContent || "").trim());
        });
        return groupTexts.length > 0;
      },
      { timeout: 20000, timeoutMsg: "Benchmark case groups did not render (Easy/Medium)." }
    );

    const runtimeTotal = await $(".benchview-runtime-total");
    await runtimeTotal.waitForExist({ timeout: 20000 });

    await browser.waitUntil(
      async () => {
        const ok = await browser.execute(() => {
          const rows = Array.from(document.querySelectorAll(".benchview-case-row"));
          if (!rows.length) return false;
          return rows.every((row) => Boolean(row.querySelector(".benchview-case-runtime")));
        });
        return ok === true;
      },
      { timeout: 20000, timeoutMsg: "Per-case runtime counters did not render." }
    );

    const difficultySelect = await $(".benchview-difficulty-select");
    await difficultySelect.selectByAttribute("value", benchDifficulty);
    await browser.waitUntil(
      async () => (await difficultySelect.getValue()) === benchDifficulty,
      { timeout: 20000, timeoutMsg: "Benchmark difficulty filter did not switch." }
    );

    const runButton = await $(".benchview-run-button");
    await runButton.waitForEnabled({ timeout: 20000 });
    await runButton.click();

    await browser.waitUntil(
      async () => (await runButton.getText()).trim().toLowerCase() === "stop",
      { timeout: 20000, timeoutMsg: "Benchmark run did not start." }
    );

    await browser.waitUntil(
      async () => (await runtimeTotal.getText()).trim() !== "—",
      { timeout: 20000, timeoutMsg: "Benchmark runtime counter did not start." }
    );

    await browser.waitUntil(
      async () => {
        const runtimeText = await browser.execute(() => {
          const runningRow = document
            .querySelector(".benchview-case-status.benchview-status-running")
            ?.closest(".benchview-case-row");
          if (!runningRow) return "";
          return (runningRow.querySelector(".benchview-case-runtime")?.textContent || "").trim();
        });
        return typeof runtimeText === "string" && runtimeText.length > 0;
      },
      { timeout: 20000, timeoutMsg: "Per-case runtime counter did not start." }
    );

    await browser.waitUntil(
      async () => {
        const promptText = await browser.execute(() => {
          const nodes = Array.from(document.querySelectorAll(".benchview-chat-container .systemsculpt-user-message"));
          return nodes.map((node) => node.textContent || "");
        });
        return promptText.some((text) => text.includes("BenchmarkVault"));
      },
      { timeout: 30000, timeoutMsg: "Benchmark prompt did not render BenchmarkVault root." }
    );

    await browser.waitUntil(
      async () => (await runButton.getText()).trim().toLowerCase() === "run",
      { timeout: 600000, timeoutMsg: "Benchmark run did not complete in time." }
    );

    const finalRuntimeText = (await runtimeTotal.getText()).trim();
    expect(finalRuntimeText).not.toBe("—");
    expect(finalRuntimeText.length).toBeGreaterThan(0);

    const runSummary = await readLatestBenchmarkRun(vaultPath);

    const caseIds = runSummary.cases.map((c: { caseId: string }) => String(c.caseId || ""));
    const hasMedium = caseIds.some((id: string) => id.startsWith("medium-"));
    const hasHard = caseIds.some((id: string) => id.startsWith("hard-"));
    const hasEasy = caseIds.some((id: string) => !id.startsWith("medium-") && !id.startsWith("hard-"));

    if (benchDifficulty === "easy") {
      expect(hasEasy).toBe(true);
      expect(hasMedium).toBe(false);
      expect(hasHard).toBe(false);
    } else if (benchDifficulty === "medium") {
      expect(hasEasy).toBe(false);
      expect(hasMedium).toBe(true);
      expect(hasHard).toBe(false);
    } else if (benchDifficulty === "hard") {
      expect(hasEasy).toBe(false);
      expect(hasMedium).toBe(false);
      expect(hasHard).toBe(true);
    } else {
      expect(hasEasy).toBe(true);
      expect(hasMedium).toBe(true);
    }

    const badStatuses = new Set(["error", "skipped", "pending", "running"]);
    const failed = runSummary.cases.filter((c: { status: string }) => badStatuses.has(c.status));

    const nonPass = runSummary.cases.filter((c: { status: string }) => c.status !== "pass");
    if (benchDifficulty !== "easy" && nonPass.length > 0) {
      const artifactPath = await exportBenchmarkFailureArtifacts(
        runSummary.runId,
        nonPass.map((c: { caseId: string }) => c.caseId)
      );
      const summary = nonPass
        .map((c: { caseId: string; status: string; scorePercent?: number }) => {
          const score = typeof c.scorePercent === "number" ? ` (${Math.round(c.scorePercent)}%)` : "";
          return `${c.caseId}:${c.status}${score}`;
        })
        .join(", ");
      console.log(`[bench] non-pass cases: ${summary}. Artifacts: ${artifactPath}`);
      await dumpFailureArtifacts(artifactPath);
      await dumpBrowserLogs("non-pass", runSummary.runId);
    }

    if (failed.length > 0) {
      const artifactPath = await exportBenchmarkFailureArtifacts(
        runSummary.runId,
        failed.map((c: { caseId: string }) => c.caseId)
      );
      const detail = failed
        .map((c: { caseId: string; status: string; errors?: string[] }) =>
          `${c.caseId}:${c.status}${c.errors?.length ? ` (${c.errors.join("; ")})` : ""}`
        )
        .join(", ");
      await dumpFailureArtifacts(artifactPath);
      await dumpBrowserLogs("execution-failed", runSummary.runId);
      throw new Error(`Benchmark run had non-pass execution status: ${detail}. Artifacts: ${artifactPath}`);
    }
  });
});
