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
  /** True while the shell command is in progress (replaced by the final row with the same `id`). */
  running?: boolean;
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

function asTrimmedString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return String(v);
}

/**
 * Build one log row from JSON stored in `plugin_state` / Postgres jsonb.
 * Driver + round-trip may yield `null` tails, numeric `ok`, string `exitCode`, etc. — strict `typeof` checks drop those and broke verify/UI.
 */
export function parseRunHistoryRowFromStorage(x: unknown): SchedulerRunLogEntry | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return null;
  if (typeof o.at !== "string" || !o.at) return null;
  if (typeof o.trigger !== "string") return null;

  const running = o.running === true;

  let ok: boolean;
  if (o.ok === true) ok = true;
  else if (o.ok === false) ok = false;
  else if (o.ok === 1 || o.ok === 0) ok = Boolean(o.ok);
  else return null;

  let exitCode: number | null = null;
  if (o.exitCode !== null && o.exitCode !== undefined) {
    if (typeof o.exitCode === "number" && Number.isFinite(o.exitCode)) {
      exitCode = o.exitCode;
    } else if (typeof o.exitCode === "string") {
      const t = o.exitCode.trim();
      if (t === "") exitCode = null;
      else if (/^-?\d+$/.test(t)) exitCode = Number(t);
      else return null;
    } else {
      return null;
    }
  }

  const cwd = asTrimmedString(o.cwd);
  const summary = asTrimmedString(o.summary);
  const stdoutTail = asTrimmedString(o.stdoutTail);
  const stderrTail = asTrimmedString(o.stderrTail);

  const taskIdRaw = o.taskId;
  const taskId =
    taskIdRaw === undefined || taskIdRaw === null
      ? undefined
      : typeof taskIdRaw === "string"
        ? taskIdRaw || undefined
        : asTrimmedString(taskIdRaw) || undefined;

  const taskLabelRaw = o.taskLabel;
  const taskLabel =
    taskLabelRaw === undefined || taskLabelRaw === null
      ? undefined
      : typeof taskLabelRaw === "string"
        ? taskLabelRaw || undefined
        : asTrimmedString(taskLabelRaw) || undefined;

  const row: SchedulerRunLogEntry = {
    id: o.id,
    at: o.at,
    trigger: o.trigger,
    ok,
    exitCode,
    cwd,
    summary,
    stdoutTail,
    stderrTail,
    taskId,
    taskLabel,
  };
  if (running) row.running = true;
  return row;
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
  return list
    .map((x) => parseRunHistoryRowFromStorage(x))
    .filter((x): x is SchedulerRunLogEntry => x != null);
}

/** Placeholder row while the command is executing; same `id` as the finished row. */
export function makeSchedulerRunningEntry(input: {
  jobRunId: string;
  task: SchedulerTask;
  trigger: string;
  cwd: string;
}): SchedulerRunLogEntry {
  const { jobRunId, task, trigger, cwd } = input;
  return {
    id: `${jobRunId}:${task.id}`,
    at: new Date().toISOString(),
    trigger,
    running: true,
    ok: false,
    exitCode: null,
    cwd,
    summary: "Running…",
    stdoutTail: "",
    stderrTail: "",
    taskId: task.id,
    taskLabel: task.label || undefined,
  };
}

/** Log row when the task never reached `exec` (missing workspace, bad cwdSubdir, API error, etc.). */
export function makeSchedulerErrorEntry(input: {
  jobRunId: string;
  task: SchedulerTask;
  trigger: string;
  message: string;
  cwd?: string;
}): SchedulerRunLogEntry {
  const { jobRunId, task, trigger, message } = input;
  const cwd = typeof input.cwd === "string" ? input.cwd : "";
  const summary = message.length > 200 ? `${message.slice(0, 200)}…` : message;
  return {
    id: `${jobRunId}:${task.id}`,
    at: new Date().toISOString(),
    trigger,
    ok: false,
    exitCode: null,
    cwd,
    summary,
    stdoutTail: "",
    stderrTail: message,
    taskId: task.id,
    taskLabel: task.label || undefined,
  };
}

export function mergeRunHistory(
  previous: unknown,
  entry: SchedulerRunLogEntry,
): SchedulerRunLogEntry[] {
  const prev = parseRunHistory(previous);
  return [...prev, entry].slice(-MAX_RUN_HISTORY);
}

/** Append many entries in one merge (used in tests and simple merges). */
export function appendRunHistoryEntries(
  previous: unknown,
  entries: SchedulerRunLogEntry[],
): SchedulerRunLogEntry[] {
  if (entries.length === 0) return parseRunHistory(previous);
  const prev = parseRunHistory(previous);
  return [...prev, ...entries].slice(-MAX_RUN_HISTORY);
}

/**
 * Replace any prior rows with the same `id`, then append new rows (trim to last {@link MAX_RUN_HISTORY}).
 * Used so a "running" placeholder is overwritten by the final result for that job run + task.
 */
export function upsertRunHistoryEntries(
  previous: unknown,
  entries: SchedulerRunLogEntry[],
): SchedulerRunLogEntry[] {
  if (entries.length === 0) return parseRunHistory(previous);
  const prev = parseRunHistory(previous);
  const ids = new Set(entries.map((e) => e.id));
  const kept = prev.filter((p) => !ids.has(p.id));
  return [...kept, ...entries].slice(-MAX_RUN_HISTORY);
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
  // Clock skew or identical timestamp — do not skip (avoids a stuck "always throttle" state).
  if (nowMs <= last) return false;
  // With a ~1/min host cron, `last` is set when the command *finishes*, so the next tick is
  // often slightly under 60s later; `elapsedMin < 1` would skip almost every run. For interval
  // 1, the host cadence is the throttle — run on every schedule tick.
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
