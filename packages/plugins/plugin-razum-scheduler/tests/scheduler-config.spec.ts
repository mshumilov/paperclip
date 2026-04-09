import { describe, expect, it } from "vitest";
import {
  appendRunHistoryEntries,
  mergeRunHistory,
  parseRunHistory,
  parseSchedulerConfig,
  pickWorkspace,
  shouldSkipScheduledRun,
} from "../src/scheduler-model.js";
import { resolveWorkingDirectory } from "../src/scheduler-config.js";
import type { PluginWorkspace } from "@paperclipai/plugin-sdk";

function ws(partial: Partial<PluginWorkspace> & Pick<PluginWorkspace, "id" | "name" | "path">): PluginWorkspace {
  return {
    projectId: "p1",
    isPrimary: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

describe("parseSchedulerConfig", () => {
  it("parses tasks array with trimming", () => {
    expect(
      parseSchedulerConfig({
        tasks: [
          {
            id: "a",
            companyId: " c1 ",
            projectId: "p1",
            command: " npm run x ",
            intervalMinutes: 2,
          },
        ],
      }),
    ).toEqual({
      tasks: [
        {
          id: "a",
          label: "",
          companyId: "c1",
          projectId: "p1",
          workspaceName: "",
          command: "npm run x",
          intervalMinutes: 2,
          cwdSubdir: "",
        },
      ],
    });
  });

  it("returns empty tasks when tasks missing or empty", () => {
    expect(parseSchedulerConfig({})).toEqual({ tasks: [] });
    expect(parseSchedulerConfig({ tasks: [] })).toEqual({ tasks: [] });
  });

  it("clamps huge interval to one week in minutes", () => {
    const c = parseSchedulerConfig({
      tasks: [
        {
          id: "x",
          companyId: "c1",
          projectId: "p1",
          command: "true",
          intervalMinutes: 999999,
        },
      ],
    });
    expect(c.tasks[0]?.intervalMinutes).toBe(7 * 24 * 60);
  });
});

describe("pickWorkspace", () => {
  const list = [
    ws({ id: "w1", name: "secondary", path: "/a", isPrimary: false }),
    ws({ id: "w2", name: "pclip-workspace", path: "/b", isPrimary: true }),
  ];

  it("finds by name", () => {
    expect(pickWorkspace(list, "secondary")?.id).toBe("w1");
  });

  it("uses primary when name empty", () => {
    expect(pickWorkspace(list, "")?.id).toBe("w2");
  });
});

describe("resolveWorkingDirectory", () => {
  it("rejects escape", () => {
    expect(() => resolveWorkingDirectory("/repo", "../etc")).toThrow(/escapes/);
  });

  it("allows nested dir", () => {
    expect(resolveWorkingDirectory("/repo", "packages/foo")).toMatch(/packages[/\\]foo$/);
  });
});

describe("parseRunHistory / mergeRunHistory", () => {
  const entry = {
    id: "r1",
    at: "2026-01-01T00:00:00.000Z",
    trigger: "schedule",
    ok: true,
    exitCode: 0,
    cwd: "/tmp/ws",
    summary: "command succeeded (exit 0)",
    stdoutTail: "hi",
    stderrTail: "",
  };

  it("parses JSON string", () => {
    expect(parseRunHistory(JSON.stringify([entry]))).toEqual([entry]);
  });

  it("merges and trims length", () => {
    let acc: unknown = [];
    for (let i = 0; i < 105; i += 1) {
      acc = mergeRunHistory(acc, { ...entry, id: `id-${i}` });
    }
    expect(parseRunHistory(acc)).toHaveLength(100);
    expect(parseRunHistory(acc)[99].id).toBe("id-104");
  });

  it("appendRunHistoryEntries preserves order and extends prior history", () => {
    const e1 = { ...entry, id: "run-1:task-a" };
    const e2 = { ...entry, id: "run-1:task-b" };
    expect(appendRunHistoryEntries([], [e1, e2]).map((r) => r.id)).toEqual(["run-1:task-a", "run-1:task-b"]);
    expect(appendRunHistoryEntries(JSON.stringify([e1]), [e2]).map((r) => r.id)).toEqual([
      "run-1:task-a",
      "run-1:task-b",
    ]);
  });
});

describe("shouldSkipScheduledRun", () => {
  const t0 = Date.parse("2026-01-01T12:00:00.000Z");

  it("never skips without last run", () => {
    expect(shouldSkipScheduledRun(null, 5, t0)).toBe(false);
  });

  it("skips inside window", () => {
    const last = new Date(t0 - 2 * 60_000).toISOString();
    expect(shouldSkipScheduledRun(last, 5, t0)).toBe(true);
  });

  it("runs after window", () => {
    const last = new Date(t0 - 6 * 60_000).toISOString();
    expect(shouldSkipScheduledRun(last, 5, t0)).toBe(false);
  });

  it("does not throttle when interval is 1 (host already fires ~once per minute)", () => {
    const last = new Date(t0 - 30_000).toISOString();
    expect(shouldSkipScheduledRun(last, 1, t0)).toBe(false);
  });

  it("does not skip when now is not after last (clock skew)", () => {
    const last = new Date(t0 + 60_000).toISOString();
    expect(shouldSkipScheduledRun(last, 5, t0)).toBe(false);
  });
});

/**
 * Simulates the host calling the scheduled job every `tickMs` (default 60s).
 * When `shouldSkipScheduledRun` is false, we "run" the command and set `last` to this tick’s time
 * (same idea as the worker updating last-success after a run).
 */
function simulateMinuteCadence(
  startMs: number,
  tickCount: number,
  intervalMinutes: number,
  tickMs: number = 60_000,
): boolean[] {
  let last: string | null = null;
  const executed: boolean[] = [];
  for (let i = 0; i < tickCount; i++) {
    const nowMs = startMs + i * tickMs;
    const skip = shouldSkipScheduledRun(last, intervalMinutes, nowMs);
    executed.push(!skip);
    if (!skip) {
      last = new Date(nowMs).toISOString();
    }
  }
  return executed;
}

describe("shouldSkipScheduledRun — 1-minute host cadence", () => {
  const t0 = Date.parse("2026-06-15T08:00:00.000Z");

  it("interval 1 minute: command allowed on every tick (no extra throttle)", () => {
    const n = 12;
    const ran = simulateMinuteCadence(t0, n, 1);
    expect(ran).toHaveLength(n);
    expect(ran.every(Boolean)).toBe(true);
  });

  it("interval 2 minutes: command runs every other minute", () => {
    const ran = simulateMinuteCadence(t0, 12, 2);
    expect(ran).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
    ]);
  });

  it("interval 3 minutes: command runs every third tick", () => {
    const ran = simulateMinuteCadence(t0, 10, 3);
    expect(ran).toEqual([true, false, false, true, false, false, true, false, false, true]);
  });
});
