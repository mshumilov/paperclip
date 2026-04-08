import { describe, expect, it } from "vitest";
import {
  parseSchedulerConfig,
  pickWorkspace,
  resolveWorkingDirectory,
  shouldSkipScheduledRun,
} from "../src/scheduler-config.js";
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
  it("applies defaults and clamps interval", () => {
    expect(
      parseSchedulerConfig({
        companyId: " c1 ",
        projectId: "p1",
        command: " npm run x ",
      }),
    ).toEqual({
      companyId: "c1",
      projectId: "p1",
      workspaceName: "",
      command: "npm run x",
      intervalMinutes: 1,
      cwdSubdir: "",
    });
  });

  it("clamps huge interval to one week in minutes", () => {
    const c = parseSchedulerConfig({
      companyId: "c1",
      projectId: "p1",
      command: "true",
      intervalMinutes: 999999,
    });
    expect(c.intervalMinutes).toBe(7 * 24 * 60);
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
});
