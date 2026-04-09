import path from "node:path";
import type { PluginWorkspace } from "@paperclipai/plugin-sdk";

/** Declared under the same value in `manifest.ts` as `MANIFEST_JOB_KEY`. */
export const JOB_KEY = "workspace-command";
export const STATE_LAST_RUN = "last-scheduled-run-at";
/** JSON array of {@link SchedulerRunLogEntry} (newest appended; worker trims). */
export const STATE_RUN_HISTORY = "run-history";

const MAX_RUN_HISTORY = 100;

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
  return (
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

export interface SchedulerConfig {
  companyId: string;
  projectId: string;
  /** Empty = primary workspace (or first in list). */
  workspaceName: string;
  /** Shell command line (e.g. `npm run sync-incoming`). */
  command: string;
  /** Minimum minutes between runs when trigger is `schedule` (host ticks job every minute). */
  intervalMinutes: number;
  /** Optional subdirectory under workspace root; must stay inside workspace. */
  cwdSubdir: string;
}

const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

export function parseSchedulerConfig(raw: Record<string, unknown>): SchedulerConfig {
  const companyId = typeof raw.companyId === "string" ? raw.companyId.trim() : "";
  const projectId = typeof raw.projectId === "string" ? raw.projectId.trim() : "";
  const workspaceName = typeof raw.workspaceName === "string" ? raw.workspaceName.trim() : "";
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  const intervalRaw = Number(raw.intervalMinutes ?? 1);
  const intervalMinutes =
    Number.isFinite(intervalRaw) && intervalRaw >= 1
      ? Math.min(MAX_INTERVAL_MINUTES, Math.floor(intervalRaw))
      : 1;
  const cwdSubdir = typeof raw.cwdSubdir === "string" ? raw.cwdSubdir.trim().replace(/\\/g, "/") : "";
  return { companyId, projectId, workspaceName, command, intervalMinutes, cwdSubdir };
}

export function pickWorkspace(workspaces: PluginWorkspace[], name: string): PluginWorkspace | null {
  if (workspaces.length === 0) return null;
  if (!name) {
    return workspaces.find((w) => w.isPrimary) ?? workspaces[0] ?? null;
  }
  return workspaces.find((w) => w.name === name) ?? null;
}

/**
 * Resolve working directory: workspace root or a safe subdirectory.
 */
export function resolveWorkingDirectory(workspacePath: string, cwdSubdir: string): string {
  const root = path.resolve(workspacePath);
  if (!cwdSubdir) return root;
  const resolved = path.resolve(root, cwdSubdir);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("cwdSubdir escapes workspace root");
  }
  return resolved;
}

export function shouldSkipScheduledRun(
  lastRunIso: string | null,
  intervalMinutes: number,
  nowMs: number,
): boolean {
  if (!lastRunIso) return false;
  const last = Date.parse(lastRunIso);
  if (!Number.isFinite(last)) return false;
  const elapsedMin = (nowMs - last) / 60_000;
  return elapsedMin < intervalMinutes;
}
