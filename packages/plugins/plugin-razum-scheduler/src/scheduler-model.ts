import type { PluginWorkspace } from "@paperclipai/plugin-sdk";

/** Declared under the same value in `manifest.ts` as `MANIFEST_JOB_KEY`. */
export const JOB_KEY = "workspace-command";
/** Per-task last successful scheduled run (ISO), JSON object `Record<taskId, iso>`. */
export const STATE_LAST_RUNS = "last-scheduled-runs";
/** JSON array of {@link SchedulerRunLogEntry} (newest appended; worker trims). */
export const STATE_RUN_HISTORY = "run-history";

const MAX_RUN_HISTORY = 100;
export const MAX_TASKS = 20;

export interface SchedulerRunLogEntry {
  id: string;
  at: string;
  trigger: string;
  ok: boolean;
  exitCode: number | null;
  cwd: string;
  /** Short status line for the list row (like activity message). */
  summary: string;
  stdoutTail: string;
  stderrTail: string;
  taskId?: string;
  taskLabel?: string;
}

export interface SchedulerTask {
  id: string;
  /** Optional name shown in logs and UI. */
  label: string;
  companyId: string;
  projectId: string;
  workspaceName: string;
  cwdSubdir: string;
  command: string;
  intervalMinutes: number;
}

export interface SchedulerConfig {
  tasks: SchedulerTask[];
}

const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

function clampIntervalMinutes(raw: unknown): number {
  const n = Number(raw ?? 1);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_INTERVAL_MINUTES, Math.floor(n));
}

function readTaskRow(o: unknown, index: number): SchedulerTask {
  const r = typeof o === "object" && o !== null ? (o as Record<string, unknown>) : {};
  const idRaw =
    typeof r.id === "string" && r.id.trim() ? r.id.trim() : `task-${index + 1}`;
  const companyId = typeof r.companyId === "string" ? r.companyId.trim() : "";
  const projectId = typeof r.projectId === "string" ? r.projectId.trim() : "";
  const workspaceName = typeof r.workspaceName === "string" ? r.workspaceName.trim() : "";
  const command = typeof r.command === "string" ? r.command.trim() : "";
  const cwdSubdir = typeof r.cwdSubdir === "string" ? r.cwdSubdir.trim().replace(/\\/g, "/") : "";
  const label = typeof r.label === "string" ? r.label.trim() : "";
  const intervalMinutes = clampIntervalMinutes(r.intervalMinutes);
  return {
    id: idRaw,
    label,
    companyId,
    projectId,
    workspaceName,
    cwdSubdir,
    command,
    intervalMinutes,
  };
}

/** Parses instance config: only `tasks[]` is supported (no legacy flat shape). */
export function parseSchedulerConfig(raw: Record<string, unknown>): SchedulerConfig {
  const tasksRaw = raw.tasks;
  if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) {
    return { tasks: [] };
  }
  const out: SchedulerTask[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < tasksRaw.length && out.length < MAX_TASKS; i++) {
    let t = readTaskRow(tasksRaw[i], i);
    if (seen.has(t.id)) {
      let n = 2;
      let candidate = `${t.id}-${n}`;
      while (seen.has(candidate) && n < 1_000) {
        n += 1;
        candidate = `${t.id}-${n}`;
      }
      t = { ...t, id: candidate };
    }
    seen.add(t.id);
    out.push(t);
  }
  return { tasks: out };
}

export function parseLastRunsMap(raw: unknown): Record<string, string> {
  if (raw == null || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string" && v && typeof k === "string" && k) {
      out[k] = v;
    }
  }
  return out;
}

export function parseRunHistory(raw: unknown): SchedulerRunLogEntry[] {
  if (raw == null) return [];
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.filter(isRunLogEntry);
}

function isRunLogEntry(x: unknown): x is SchedulerRunLogEntry {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  const taskOk =
    o.taskId === undefined || typeof o.taskId === "string";
  const labelOk = o.taskLabel === undefined || typeof o.taskLabel === "string";
  return (
    taskOk &&
    labelOk &&
    typeof o.id === "string" &&
    typeof o.at === "string" &&
    typeof o.trigger === "string" &&
    typeof o.ok === "boolean" &&
    (o.exitCode === null || typeof o.exitCode === "number") &&
    typeof o.cwd === "string" &&
    typeof o.summary === "string" &&
    typeof o.stdoutTail === "string" &&
    typeof o.stderrTail === "string"
  );
}

export function mergeRunHistory(
  previous: unknown,
  entry: SchedulerRunLogEntry,
): SchedulerRunLogEntry[] {
  const prev = parseRunHistory(previous);
  return [...prev, entry].slice(-MAX_RUN_HISTORY);
}

export function pickWorkspace(workspaces: PluginWorkspace[], name: string): PluginWorkspace | null {
  if (workspaces.length === 0) return null;
  if (!name) {
    return workspaces.find((w) => w.isPrimary) ?? workspaces[0] ?? null;
  }
  return workspaces.find((w) => w.name === name) ?? null;
}

export function shouldSkipScheduledRun(
  lastRunIso: string | null,
  intervalMinutes: number,
  nowMs: number,
): boolean {
  if (!lastRunIso) return false;
  const last = Date.parse(lastRunIso);
  if (!Number.isFinite(last)) return false;
  // `intervalMinutes === 1` with a ~1/min host cron: comparing wall-clock seconds to a full
  // 60_000 ms window skips almost every tick, because `last` is recorded when the command
  // *finishes*, so the next host tick is often slightly under 60s later. For 1 (or less),
  // treat the host schedule as the throttle — run on every host tick.
  if (intervalMinutes <= 1) return false;
  const elapsedMin = (nowMs - last) / 60_000;
  return elapsedMin < intervalMinutes;
}

/** Default row for new task editor (client may assign id). */
export function emptySchedulerTask(id: string): SchedulerTask {
  return {
    id,
    label: "",
    companyId: "",
    projectId: "",
    workspaceName: "",
    cwdSubdir: "",
    command: "",
    intervalMinutes: 1,
  };
}
