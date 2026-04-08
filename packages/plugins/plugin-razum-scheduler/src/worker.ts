import { spawn } from "node:child_process";
import { definePlugin, runWorker, type PluginContext, type PluginJobContext } from "@paperclipai/plugin-sdk";
import {
  JOB_KEY,
  STATE_LAST_RUN,
  parseSchedulerConfig,
  pickWorkspace,
  resolveWorkingDirectory,
  shouldSkipScheduledRun,
} from "./scheduler-config.js";

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

async function runScheduledCommand(ctx: PluginContext, job: PluginJobContext): Promise<void> {
  const raw = (await ctx.config.get()) as Record<string, unknown>;
  const config = parseSchedulerConfig(raw);

  if (!config.companyId || !config.projectId) {
    throw new Error("Set companyId and projectId in plugin settings");
  }
  if (!config.command) {
    throw new Error("Set command in plugin settings (e.g. npm run sync-incoming)");
  }

  const stateKey = { scopeKind: "instance" as const, stateKey: STATE_LAST_RUN };
  const now = Date.now();

  if (job.trigger === "schedule") {
    const last = (await ctx.state.get(stateKey)) as string | null;
    if (shouldSkipScheduledRun(last, config.intervalMinutes, now)) {
      ctx.logger.debug("Skipping run — interval not elapsed", {
        intervalMinutes: config.intervalMinutes,
        runId: job.runId,
      });
      return;
    }
  }

  const workspaces = await ctx.projects.listWorkspaces(config.projectId, config.companyId);
  const workspace = pickWorkspace(workspaces, config.workspaceName);
  if (!workspace) {
    const hint = config.workspaceName ? `named "${config.workspaceName}"` : "primary";
    throw new Error(`No workspace ${hint} for this project`);
  }

  const cwd = resolveWorkingDirectory(workspace.path, config.cwdSubdir);
  ctx.logger.info("Running workspace command", {
    runId: job.runId,
    trigger: job.trigger,
    cwd,
    commandPreview: config.command.length > 120 ? `${config.command.slice(0, 120)}…` : config.command,
  });

  const { code, stdout, stderr } = await runShellCommand(cwd, config.command);

  await ctx.activity.log({
    companyId: config.companyId,
    message:
      code === 0
        ? `plugin-razum-scheduler: command succeeded (exit ${code})`
        : `plugin-razum-scheduler: command failed (exit ${code ?? "null"})`,
    entityType: "plugin_job",
    entityId: job.runId,
    metadata: {
      pluginId: ctx.manifest.id,
      jobKey: job.jobKey,
      cwd,
      exitCode: code,
      stdoutTail: stdout.length > 4000 ? `${stdout.slice(0, 4000)}…` : stdout,
      stderrTail: stderr.length > 2000 ? `${stderr.slice(0, 2000)}…` : stderr,
    },
  });

  if (code !== 0) {
    throw new Error(stderr || stdout || `Command exited with code ${code ?? "null"}`);
  }

  if (job.trigger === "schedule") {
    await ctx.state.set(stateKey, new Date(now).toISOString());
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.jobs.register(JOB_KEY, async (job) => {
      await runScheduledCommand(ctx, job);
    });

    ctx.data.register("health", async () => {
      const c = parseSchedulerConfig((await ctx.config.get()) as Record<string, unknown>);
      return {
        status: "ok" as const,
        hasTarget: Boolean(c.companyId && c.projectId && c.command),
        intervalMinutes: c.intervalMinutes,
        checkedAt: new Date().toISOString(),
      };
    });
  },

  async onHealth() {
    return { status: "ok" as const, message: "plugin-razum-scheduler worker ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
