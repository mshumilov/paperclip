import { spawn } from "node:child_process";
import { definePlugin, runWorker, type PluginContext, type PluginJobContext } from "@paperclipai/plugin-sdk";
import {
  JOB_KEY,
  STATE_LAST_RUNS,
  STATE_RUN_HISTORY,
  makeSchedulerErrorEntry,
  makeSchedulerRunningEntry,
  parseLastRunsMap,
  parseRunHistory,
  parseSchedulerConfig,
  pickWorkspace,
  resolveWorkingDirectory,
  shouldSkipScheduledRun,
  upsertRunHistoryEntries,
  type SchedulerRunLogEntry,
  type SchedulerTask,
} from "./scheduler-config.js";

/** One shell at a time per task id (covers overlapping host ticks / concurrent RPC if that ever happens). */
const taskShellInFlight = new Set<string>();

function runShellCommand(cwd: string, command: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() });
    });
  });
}

async function loadLastRunsMap(ctx: PluginContext): Promise<Record<string, string>> {
  const raw = await ctx.state.get({ scopeKind: "instance", stateKey: STATE_LAST_RUNS });
  return parseLastRunsMap(raw);
}

/**
 * Read-merge-write run-history with upsert by row `id` (retries on lost updates).
 * Replaces "running" placeholders with final rows and avoids dropping other tasks' rows.
 */
async function flushRunHistoryUpsert(ctx: PluginContext, entries: SchedulerRunLogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const historyKey = { scopeKind: "instance" as const, stateKey: STATE_RUN_HISTORY };
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const prev = await ctx.state.get(historyKey);
    const next = upsertRunHistoryEntries(prev, entries);
    await ctx.state.set(historyKey, next);
    const verify = parseRunHistory(await ctx.state.get(historyKey));
    if (entries.every((e) => verify.some((r) => r.id === e.id))) {
      return;
    }
  }
  ctx.logger.warn("run-history: upsert flush could not verify after retries", {
    ids: entries.map((e) => e.id),
  });
}

async function runOneTask(
  ctx: PluginContext,
  job: PluginJobContext,
  task: SchedulerTask,
  nowMs: number,
): Promise<SchedulerRunLogEntry | null> {
  const taskTag = task.label || task.id;

  try {
    const workspaces = await ctx.projects.listWorkspaces(task.projectId, task.companyId);
    const workspace = pickWorkspace(workspaces, task.workspaceName);
    if (!workspace) {
      const hint = task.workspaceName ? `named "${task.workspaceName}"` : "primary";
      const msg = `No workspace ${hint} for this project`;
      await ctx.activity.log({
        companyId: task.companyId,
        message: `plugin-razum-scheduler [${taskTag}]: setup failed — ${msg}`,
        entityType: "plugin_job",
        entityId: job.runId,
        metadata: {
          pluginId: ctx.manifest.id,
          jobKey: job.jobKey,
          taskId: task.id,
          exitCode: null,
          error: msg,
        },
      });
      return makeSchedulerErrorEntry({
        jobRunId: job.runId,
        task,
        trigger: job.trigger,
        message: msg,
      });
    }

    const cwd = resolveWorkingDirectory(workspace.path, task.cwdSubdir);

    if (taskShellInFlight.has(task.id)) {
      ctx.logger.debug("Skipping task — previous shell for this task is still running", {
        taskId: task.id,
        runId: job.runId,
      });
      return null;
    }

    ctx.logger.info("Running workspace command", {
      runId: job.runId,
      taskId: task.id,
      trigger: job.trigger,
      cwd,
      commandPreview: task.command.length > 120 ? `${task.command.slice(0, 120)}…` : task.command,
    });

    taskShellInFlight.add(task.id);
    try {
      await flushRunHistoryUpsert(ctx, [
        makeSchedulerRunningEntry({
          jobRunId: job.runId,
          task,
          trigger: job.trigger,
          cwd,
        }),
      ]);

      let code: number | null;
      let stdout: string;
      let stderr: string;
      try {
        const r = await runShellCommand(cwd, task.command);
        code = r.code;
        stdout = r.stdout;
        stderr = r.stderr;
      } catch (err) {
        code = null;
        stdout = "";
        stderr = err instanceof Error ? err.message : String(err);
      }

      const stdoutTail = stdout.length > 4000 ? `${stdout.slice(0, 4000)}…` : stdout;
      const stderrTail = stderr.length > 2000 ? `${stderr.slice(0, 2000)}…` : stderr;

      await ctx.activity.log({
        companyId: task.companyId,
        message:
          code === 0
            ? `plugin-razum-scheduler [${taskTag}]: command succeeded (exit ${code})`
            : `plugin-razum-scheduler [${taskTag}]: command failed (exit ${code ?? "null"})`,
        entityType: "plugin_job",
        entityId: job.runId,
        metadata: {
          pluginId: ctx.manifest.id,
          jobKey: job.jobKey,
          taskId: task.id,
          cwd,
          exitCode: code,
          stdoutTail,
          stderrTail,
        },
      });

      const entry: SchedulerRunLogEntry = {
        id: `${job.runId}:${task.id}`,
        at: new Date().toISOString(),
        trigger: job.trigger,
        ok: code === 0,
        exitCode: code,
        cwd,
        summary:
          code === 0
            ? `command succeeded (exit ${code})`
            : `command failed (exit ${code ?? "null"})`,
        stdoutTail,
        stderrTail,
        taskId: task.id,
        taskLabel: task.label || undefined,
      };

      if (code === 0 && job.trigger === "schedule") {
        const lastRunsKey = { scopeKind: "instance" as const, stateKey: STATE_LAST_RUNS };
        const prevMapRaw = await ctx.state.get(lastRunsKey);
        const prevMap = parseLastRunsMap(prevMapRaw);
        await ctx.state.set(lastRunsKey, {
          ...prevMap,
          [task.id]: new Date(nowMs).toISOString(),
        });
      }

      return entry;
    } finally {
      taskShellInFlight.delete(task.id);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.activity.log({
      companyId: task.companyId,
      message: `plugin-razum-scheduler [${taskTag}]: setup failed — ${msg}`,
      entityType: "plugin_job",
      entityId: job.runId,
      metadata: {
        pluginId: ctx.manifest.id,
        jobKey: job.jobKey,
        taskId: task.id,
        exitCode: null,
        error: msg,
      },
    });
    return makeSchedulerErrorEntry({
      jobRunId: job.runId,
      task,
      trigger: job.trigger,
      message: msg,
    });
  }
}

async function runScheduledCommand(ctx: PluginContext, job: PluginJobContext): Promise<void> {
  const raw = (await ctx.config.get()) as Record<string, unknown>;
  const config = parseSchedulerConfig(raw);

  if (config.tasks.length === 0) {
    ctx.logger.debug("No tasks configured — skipping job", { runId: job.runId });
    return;
  }

  const now = Date.now();
  let lastRuns = await loadLastRunsMap(ctx);
  const errors: string[] = [];
  let ranAny = false;
  let succeededAny = false;
  const historyBatch: SchedulerRunLogEntry[] = [];

  for (const task of config.tasks) {
    if (!task.companyId || !task.projectId || !task.command) {
      continue;
    }

    if (job.trigger === "schedule") {
      const last = lastRuns[task.id] ?? null;
      if (shouldSkipScheduledRun(last, task.intervalMinutes, now)) {
        ctx.logger.debug("Skipping task — interval not elapsed", {
          taskId: task.id,
          intervalMinutes: task.intervalMinutes,
          runId: job.runId,
        });
        continue;
      }
    }

    try {
      const entry = await runOneTask(ctx, job, task, now);
      if (entry === null) {
        continue;
      }
      historyBatch.push(entry);
      if (entry.ok) {
        ranAny = true;
        succeededAny = true;
      } else {
        ranAny = true;
        const hint =
          entry.stderrTail?.trim() || entry.stdoutTail?.trim() || entry.summary;
        errors.push(`${task.label || task.id}: ${hint}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${task.label || task.id}: ${msg}`);
      ranAny = true;
      historyBatch.push(
        makeSchedulerErrorEntry({
          jobRunId: job.runId,
          task,
          trigger: job.trigger,
          message: `Unexpected worker error: ${msg}`,
        }),
      );
    }
  }

  await flushRunHistoryUpsert(ctx, historyBatch);

  // One failing npm script must not mark the whole host job "failed" if another task succeeded.
  if (errors.length > 0 && !succeededAny) {
    throw new Error(errors.join(" | "));
  }
  if (errors.length > 0 && succeededAny) {
    ctx.logger.warn("Some scheduled tasks failed; others succeeded", {
      runId: job.runId,
      errors: errors.join(" | "),
    });
  }

  if (job.trigger === "schedule" && !ranAny && errors.length === 0) {
    ctx.logger.debug("All tasks skipped (interval throttle)", { runId: job.runId });
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.jobs.register(JOB_KEY, async (job) => {
      await runScheduledCommand(ctx, job);
    });

    ctx.data.register("health", async () => {
      const c = parseSchedulerConfig((await ctx.config.get()) as Record<string, unknown>);
      const ready = c.tasks.filter((t) => t.companyId && t.projectId && t.command);
      const intervals = ready.map((t) => t.intervalMinutes).filter((n) => n >= 1);
      return {
        status: "ok" as const,
        hasTarget: ready.length > 0,
        taskCount: ready.length,
        intervalMinutes: intervals.length ? Math.min(...intervals) : 1,
        checkedAt: new Date().toISOString(),
      };
    });

    ctx.data.register("run-history", async () => {
      const raw = await ctx.state.get({ scopeKind: "instance", stateKey: STATE_RUN_HISTORY });
      const runs = parseRunHistory(raw);
      return { runs: [...runs].reverse() };
    });
  },

  async onHealth() {
    return { status: "ok" as const, message: "plugin-razum-scheduler worker ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
