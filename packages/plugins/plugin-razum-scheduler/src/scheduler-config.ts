import path from "node:path";
import type { PluginWorkspace } from "@paperclipai/plugin-sdk";

/** Declared under the same value in `manifest.ts` as `MANIFEST_JOB_KEY`. */
export const JOB_KEY = "workspace-command";
export const STATE_LAST_RUN = "last-scheduled-run-at";

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
