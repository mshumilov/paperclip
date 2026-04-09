import {
  usePluginData,
  type PluginSettingsPageProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  MAX_TASKS,
  emptySchedulerTask,
  parseSchedulerConfig,
  type SchedulerTask,
} from "../scheduler-model.js";

/** Must match `manifest.id` — used for `/api/plugins/:id/config` resolution by key. */
const PLUGIN_INSTANCE_KEY = "plugin-razum-scheduler";

function hostFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(path, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  }).then(async (response) => {
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Request failed: ${response.status}`);
    }
    return (await response.json()) as T;
  });
}

type HealthData = {
  status: "ok";
  hasTarget: boolean;
  taskCount?: number;
  intervalMinutes: number;
  checkedAt: string;
};

type RunHistoryData = {
  runs: Array<{
    id: string;
    at: string;
    trigger: string;
    ok: boolean;
    exitCode: number | null;
    cwd: string;
    summary: string;
    stdoutTail: string;
    stderrTail: string;
    taskId?: string;
    taskLabel?: string;
  }>;
};

/** Subset of `GET /api/plugins/:id/dashboard` used for Recent Job Runs. */
type PluginDashboardRecentJobRun = {
  id: string;
  jobId: string;
  jobKey?: string;
  trigger: string;
  status: string;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
};

type PluginDashboardPayload = {
  recentJobRuns: PluginDashboardRecentJobRun[];
  checkedAt: string;
};

function formatDurationMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function jobStatusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === "completed" || s === "success" || s === "succeeded") return "var(--chart-2, #22c55e)";
  if (s === "failed" || s === "error") return "var(--destructive, #ef4444)";
  if (s === "running" || s === "pending") return "var(--chart-4, #eab308)";
  return "var(--muted-foreground, #9ca3af)";
}

function workerRunsForHostRun(
  hostRunId: string,
  workers: RunHistoryData["runs"],
): RunHistoryData["runs"] {
  return workers.filter((w) => w.id === hostRunId || w.id.startsWith(`${hostRunId}:`));
}

const tabBarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "8px",
  marginBottom: "4px",
};

function TabButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "6px 12px",
        borderRadius: "8px",
        fontSize: "13px",
        border: `1px solid ${selected ? "var(--primary, #3b82f6)" : "var(--border, #444)"}`,
        background: selected ? "color-mix(in srgb, var(--primary, #3b82f6) 18%, transparent)" : "transparent",
        color: "var(--foreground, #eee)",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function newTaskId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function defaultTasksConfig(): Record<string, unknown> {
  return { tasks: [] };
}

/** Server config is only `tasks[]`; empty is valid (no default row). */
function configFromServer(raw: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const merged = { ...(raw ?? {}) } as Record<string, unknown>;
  const { tasks } = parseSchedulerConfig(merged);
  return { tasks: tasks.map((t) => ({ ...t })) };
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 45) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function useInstanceConfigForm() {
  const [configJson, setConfigJson] = useState<Record<string, unknown>>(() => defaultTasksConfig());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    hostFetchJson<{ configJson?: Record<string, unknown> | null } | null>(
      `/api/plugins/${encodeURIComponent(PLUGIN_INSTANCE_KEY)}/config`,
    )
      .then((result) => {
        if (cancelled) return;
        setConfigJson(configFromServer(result?.configJson ?? undefined));
        setError(null);
      })
      .catch((nextError) => {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (next: Record<string, unknown>) => {
    setSaving(true);
    try {
      await hostFetchJson(`/api/plugins/${encodeURIComponent(PLUGIN_INSTANCE_KEY)}/config`, {
        method: "POST",
        body: JSON.stringify({ configJson: next }),
      });
      setConfigJson(next);
      setError(null);
    } catch (nextError) {
      const msg = nextError instanceof Error ? nextError.message : String(nextError);
      setError(msg);
      throw nextError;
    } finally {
      setSaving(false);
    }
  }, []);

  return { configJson, setConfigJson, loading, saving, error, save };
}

const labelStyle: CSSProperties = { display: "grid", gap: "6px", fontSize: "13px" };
const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 10px",
  borderRadius: "8px",
  border: "1px solid var(--border, #333)",
  background: "var(--background, #111)",
  color: "var(--foreground, #eee)",
  fontSize: "13px",
};
const sectionTitle: CSSProperties = { fontSize: "15px", fontWeight: 600, margin: "0 0 8px" };
const helpStyle: CSSProperties = { fontSize: "11px", opacity: 0.65, marginTop: "4px" };

export function DashboardWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<HealthData>("health");

  if (loading) return <div>Loading…</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div style={{ display: "grid", gap: "0.35rem", fontSize: "0.9rem" }}>
      <strong>Razum scheduler</strong>
      <div>Status: {data?.status ?? "unknown"}</div>
      <div>
        Tasks: {data?.taskCount ?? (data?.hasTarget ? 1 : 0)} configured
        {!data?.hasTarget ? " — set company, project, and command per task" : ""}
      </div>
      <div>Shortest interval: {data?.intervalMinutes ?? "—"} min (per-task throttle)</div>
      <div style={{ opacity: 0.75 }}>Checked: {data?.checkedAt ?? "—"}</div>
    </div>
  );
}

function MergedRunLogRow({
  host,
  workers,
}: {
  host: PluginDashboardRecentJobRun | null;
  workers: RunHistoryData["runs"];
}) {
  const at = host?.createdAt ?? workers[0]?.at ?? "";
  const dotColor = host ? jobStatusColor(host.status) : workers[0]?.ok ? "var(--chart-2, #22c55e)" : "var(--destructive, #ef4444)";
  const headline =
    host != null
      ? `${host.status} · ${formatDurationMs(host.durationMs)} (${host.trigger})`
      : workers.length > 0
        ? `${workers.map((w) => w.summary).join(" · ")} (${workers[0]?.trigger ?? "?"})`
        : "—";

  return (
    <div
      style={{
        borderBottom: "1px solid color-mix(in srgb, var(--border, #444) 80%, transparent)",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: "12px",
          alignItems: "flex-start",
          padding: "10px 14px",
          fontSize: "13px",
        }}
      >
        <div
          style={{
            width: "28px",
            height: "28px",
            borderRadius: "999px",
            background: "color-mix(in srgb, var(--muted-foreground, #888) 22%, transparent)",
            display: "grid",
            placeItems: "center",
            fontSize: "10px",
            fontWeight: 600,
            flexShrink: 0,
            color: "var(--foreground, #eee)",
          }}
        >
          <span
            style={{
              width: "10px",
              height: "10px",
              borderRadius: "999px",
              background: dotColor,
              display: "block",
            }}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ lineHeight: 1.35 }}>
            <strong style={{ color: "var(--foreground, #eee)" }}>System</strong>
            <span style={{ color: "var(--muted-foreground, #9ca3af)", marginLeft: "6px", fontSize: "11px" }}>
              {headline}
            </span>
          </div>
          {host?.error ? (
            <pre
              style={{
                margin: "8px 0 0",
                fontSize: "11px",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: "var(--destructive, #fca5a5)",
              }}
            >
              {host.error}
            </pre>
          ) : null}
          {workers.length === 0 ? (
            <p style={{ fontSize: "11px", color: "var(--muted-foreground, #9ca3af)", margin: "8px 0 0" }}>
              No worker log for this run (often: host tick while the task was skipped by interval throttle).
            </p>
          ) : (
            workers.map((w) => <RunLogRow key={w.id} run={w} nested />)
          )}
        </div>
        <span
          style={{
            fontSize: "11px",
            color: "var(--muted-foreground, #9ca3af)",
            flexShrink: 0,
            paddingTop: "2px",
          }}
        >
          {timeAgo(at)}
        </span>
      </div>
    </div>
  );
}

function RunLogRow({ run, nested }: { run: RunHistoryData["runs"][number]; nested?: boolean }) {
  const { stdoutTail, stderrTail } = run;
  const hasOutput = Boolean(stdoutTail || stderrTail);
  const pad = nested ? "8px 0 8px 12px" : "10px 14px";
  const borderBottom = nested
    ? "1px solid color-mix(in srgb, var(--border, #444) 55%, transparent)"
    : "1px solid color-mix(in srgb, var(--border, #444) 80%, transparent)";
  return (
    <div
      style={{
        borderBottom: borderBottom,
      }}
    >
      <div
        style={{
          display: "flex",
          gap: "12px",
          alignItems: "flex-start",
          padding: pad,
          fontSize: nested ? "12px" : "13px",
        }}
      >
        {!nested ? (
        <div
          style={{
            width: "28px",
            height: "28px",
            borderRadius: "999px",
            background: "color-mix(in srgb, var(--muted-foreground, #888) 22%, transparent)",
            display: "grid",
            placeItems: "center",
            fontSize: "10px",
            fontWeight: 600,
            flexShrink: 0,
            color: "var(--foreground, #eee)",
          }}
        >
          SY
        </div>
        ) : null}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ lineHeight: 1.35 }}>
            <strong style={{ color: "var(--foreground, #eee)" }}>System</strong>
            {run.taskLabel || run.taskId ? (
              <span
                style={{
                  color: "var(--muted-foreground, #9ca3af)",
                  marginLeft: "6px",
                  fontSize: "11px",
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                [{run.taskLabel || run.taskId}]
              </span>
            ) : null}
            <span style={{ color: "var(--muted-foreground, #9ca3af)", marginLeft: "6px" }}>
              plugin-razum-scheduler: {run.summary}
            </span>
            <span style={{ color: "var(--muted-foreground, #9ca3af)", marginLeft: "6px", fontSize: "11px" }}>
              ({run.trigger})
            </span>
          </div>
          {hasOutput ? (
            <details style={{ marginTop: "8px" }}>
              <summary
                style={{
                  cursor: "pointer",
                  fontSize: "12px",
                  color: "var(--muted-foreground, #9ca3af)",
                  userSelect: "none",
                }}
              >
                Command output
                {run.exitCode !== null && run.exitCode !== undefined && (
                  <span style={{ fontFamily: "ui-monospace, monospace", marginLeft: "8px", fontSize: "11px" }}>
                    exit {String(run.exitCode)}
                  </span>
                )}
              </summary>
              <div style={{ display: "grid", gap: "10px", marginTop: "10px" }}>
                <div
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: "10px",
                    color: "var(--muted-foreground, #9ca3af)",
                    wordBreak: "break-all",
                  }}
                >
                  {run.cwd}
                </div>
                {stderrTail ? (
                  <pre
                    style={{
                      margin: 0,
                      maxHeight: "12rem",
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      padding: "10px",
                      borderRadius: "8px",
                      fontSize: "11px",
                      lineHeight: 1.45,
                      border: "1px solid color-mix(in srgb, var(--destructive, #b91c1c) 35%, transparent)",
                      background: "color-mix(in srgb, var(--destructive, #b91c1c) 8%, transparent)",
                      color: "var(--destructive, #fca5a5)",
                    }}
                  >
                    {stderrTail}
                  </pre>
                ) : null}
                {stdoutTail ? (
                  <pre
                    style={{
                      margin: 0,
                      maxHeight: "16rem",
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      padding: "10px",
                      borderRadius: "8px",
                      fontSize: "11px",
                      lineHeight: 1.45,
                      border: "1px solid color-mix(in srgb, var(--border, #444) 90%, transparent)",
                      background: "color-mix(in srgb, var(--card, #1a1a1a) 100%, transparent)",
                      color: "var(--foreground, #eee)",
                    }}
                  >
                    {stdoutTail}
                  </pre>
                ) : null}
              </div>
            </details>
          ) : (
            <p style={{ fontSize: "11px", color: "var(--muted-foreground, #9ca3af)", margin: "6px 0 0" }}>
              No captured stdout/stderr.
            </p>
          )}
        </div>
        {!nested ? (
          <span
            style={{
              fontSize: "11px",
              color: "var(--muted-foreground, #9ca3af)",
              flexShrink: 0,
              paddingTop: "2px",
            }}
          >
            {timeAgo(run.at)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

type IdName = { id: string; name: string };

export function SchedulerSettingsPage({ context }: PluginSettingsPageProps) {
  const [tab, setTab] = useState<"settings" | "output">("settings");
  const { configJson, setConfigJson, loading, saving, error, save } = useInstanceConfigForm();
  const { data: historyData, loading: historyLoading, error: historyError, refresh } =
    usePluginData<RunHistoryData>("run-history");
  const [hostDash, setHostDash] = useState<PluginDashboardPayload | null>(null);
  const [hostDashErr, setHostDashErr] = useState<string | null>(null);
  const [companies, setCompanies] = useState<IdName[]>([]);
  const [projectsByCompany, setProjectsByCompany] = useState<Record<string, IdName[]>>({});
  const projectsFetchedRef = useRef<Set<string>>(new Set());
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const tasks = (Array.isArray(configJson.tasks) ? configJson.tasks : []) as SchedulerTask[];

  const refreshDashboard = useCallback(() => {
    return hostFetchJson<PluginDashboardPayload>(
      `/api/plugins/${encodeURIComponent(PLUGIN_INSTANCE_KEY)}/dashboard`,
    )
      .then((d) => {
        setHostDash(d);
        setHostDashErr(null);
      })
      .catch((e) => {
        setHostDashErr(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => {
    if (tab !== "output") return;
    void refresh();
    void refreshDashboard();
    const t = window.setInterval(() => {
      void refresh();
      void refreshDashboard();
    }, 8000);
    return () => window.clearInterval(t);
  }, [tab, refresh, refreshDashboard]);

  useEffect(() => {
    if (tab !== "settings") return;
    let cancelled = false;
    hostFetchJson<IdName[]>("/api/companies")
      .then((rows) => {
        if (!cancelled) setCompanies(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setCompanies([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  const companyIdsKey = tasks
    .map((t) => t.companyId.trim())
    .filter(Boolean)
    .sort()
    .join("|");

  useEffect(() => {
    if (tab !== "settings") return;
    const cids = companyIdsKey ? companyIdsKey.split("|") : [];
    for (const cid of cids) {
      if (!cid || projectsFetchedRef.current.has(cid)) continue;
      projectsFetchedRef.current.add(cid);
      hostFetchJson<IdName[]>(`/api/companies/${encodeURIComponent(cid)}/projects`)
        .then((rows) => {
          setProjectsByCompany((m) => ({ ...m, [cid]: Array.isArray(rows) ? rows : [] }));
        })
        .catch(() => {
          setProjectsByCompany((m) => ({ ...m, [cid]: [] }));
        });
    }
  }, [tab, companyIdsKey]);

  const mergedLogRows = useMemo(() => {
    const w = historyData?.runs ?? [];
    const recent = hostDash?.recentJobRuns;
    if (recent && recent.length > 0) {
      return recent.map((hr) => ({
        key: hr.id,
        host: hr,
        workers: workerRunsForHostRun(hr.id, w),
      }));
    }
    return w.map((run) => ({
      key: run.id,
      host: null as PluginDashboardRecentJobRun | null,
      workers: [run],
    }));
  }, [historyData, hostDash]);

  function setTaskField(index: number, patch: Partial<SchedulerTask>) {
    setConfigJson((c) => {
      const list = [...((c.tasks as SchedulerTask[]) ?? [])];
      const cur = list[index] ?? emptySchedulerTask(newTaskId());
      list[index] = { ...cur, ...patch };
      return { tasks: list };
    });
  }

  function addTask() {
    setConfigJson((c) => {
      const list = [...((c.tasks as SchedulerTask[]) ?? [])];
      if (list.length >= MAX_TASKS) return c;
      list.push(emptySchedulerTask(newTaskId()));
      return { tasks: list };
    });
  }

  function removeTask(index: number) {
    setConfigJson((c) => {
      const list = [...((c.tasks as SchedulerTask[]) ?? [])];
      if (index < 0 || index >= list.length) return c;
      list.splice(index, 1);
      return { tasks: list };
    });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError(null);
    if (tasks.length > 0) {
      for (let i = 0; i < tasks.length; i += 1) {
        const t = tasks[i];
        if (!t.companyId?.trim() || !t.projectId?.trim() || !t.command?.trim()) {
          setValidationError(`Task ${i + 1}: choose company, project, and command (or remove the row).`);
          return;
        }
      }
    }
    await save({ tasks });
    setSavedMsg("Saved");
    window.setTimeout(() => setSavedMsg(null), 2000);
  }

  return (
    <div style={{ display: "grid", gap: "16px", maxWidth: "880px" }}>
      <div style={tabBarStyle}>
        <TabButton selected={tab === "settings"} onClick={() => setTab("settings")}>
          Configuration
        </TabButton>
        <TabButton selected={tab === "output"} onClick={() => setTab("output")}>
          Command output
        </TabButton>
      </div>

      {tab === "settings" ? (
        loading ? (
          <div style={{ fontSize: "13px", opacity: 0.75 }}>Loading plugin settings…</div>
        ) : (
          <form onSubmit={(e) => void onSubmit(e)} style={{ display: "grid", gap: "18px" }}>
            <div>
              <h3 style={sectionTitle}>Scheduler tasks</h3>
              <p style={{ fontSize: "12px", opacity: 0.75, margin: 0 }}>
                Board context company id: {context.companyId ?? "none"} (for reference). Pick company and project by name
                below; UUIDs are stored in config.
              </p>
            </div>

            {error ? (
              <div
                style={{
                  fontSize: "13px",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  border: "1px solid color-mix(in srgb, var(--destructive, #b91c1c) 40%, transparent)",
                  color: "var(--destructive, #fca5a5)",
                }}
              >
                {error}
              </div>
            ) : null}

            {validationError ? (
              <div
                style={{
                  fontSize: "13px",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  border: "1px solid color-mix(in srgb, var(--destructive, #b91c1c) 40%, transparent)",
                  color: "var(--destructive, #fca5a5)",
                }}
              >
                {validationError}
              </div>
            ) : null}

            {tasks.map((task, index) => (
              <fieldset
                key={task.id}
                style={{
                  margin: 0,
                  padding: "14px 16px",
                  borderRadius: "10px",
                  border: "1px solid color-mix(in srgb, var(--border, #444) 90%, transparent)",
                  display: "grid",
                  gap: "14px",
                }}
              >
                <legend style={{ padding: "0 8px", fontSize: "13px", fontWeight: 600 }}>
                  Task {index + 1}
                  <span style={{ fontWeight: 400, opacity: 0.65, marginLeft: "8px", fontFamily: "ui-monospace, monospace" }}>
                    ({task.id})
                  </span>
                </legend>

                <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" }}>
                  <button
                    type="button"
                    onClick={() => removeTask(index)}
                    style={{
                      padding: "6px 12px",
                      borderRadius: "8px",
                      border: "1px solid color-mix(in srgb, var(--destructive, #b91c1c) 50%, transparent)",
                      background: "transparent",
                      color: "var(--destructive, #fca5a5)",
                      fontSize: "12px",
                      cursor: "pointer",
                    }}
                  >
                    Remove task
                  </button>
                </div>

                <label style={labelStyle}>
                  Label (optional)
                  <input
                    style={inputStyle}
                    value={task.label}
                    onChange={(e) => setTaskField(index, { label: e.target.value })}
                    placeholder="Short name for logs"
                    autoComplete="off"
                  />
                </label>

                <label style={labelStyle}>
                  Company
                  <select
                    style={inputStyle}
                    value={task.companyId}
                    onChange={(e) => {
                      const cid = e.target.value;
                      setTaskField(index, { companyId: cid, projectId: "" });
                      if (cid && !projectsFetchedRef.current.has(cid)) {
                        projectsFetchedRef.current.add(cid);
                        hostFetchJson<IdName[]>(`/api/companies/${encodeURIComponent(cid)}/projects`)
                          .then((rows) => {
                            setProjectsByCompany((m) => ({
                              ...m,
                              [cid]: Array.isArray(rows) ? rows : [],
                            }));
                          })
                          .catch(() => {
                            setProjectsByCompany((m) => ({ ...m, [cid]: [] }));
                          });
                      }
                    }}
                  >
                    <option value="">— Select company —</option>
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <span style={helpStyle}>Stored id: {task.companyId || "—"}</span>
                </label>

                <label style={labelStyle}>
                  Project
                  <select
                    style={inputStyle}
                    value={task.projectId}
                    disabled={!task.companyId.trim()}
                    onChange={(e) => setTaskField(index, { projectId: e.target.value })}
                  >
                    <option value="">— Select project —</option>
                    {(projectsByCompany[task.companyId] ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <span style={helpStyle}>Stored id: {task.projectId || "—"}</span>
                </label>

                <label style={labelStyle}>
                  Workspace name
                  <input
                    style={inputStyle}
                    value={task.workspaceName}
                    onChange={(e) => setTaskField(index, { workspaceName: e.target.value })}
                    placeholder="Empty = primary workspace"
                    autoComplete="off"
                  />
                  <span style={helpStyle}>Optional; must match a workspace display name on the project.</span>
                </label>

                <label style={labelStyle}>
                  Subdirectory (under workspace)
                  <input
                    style={inputStyle}
                    value={task.cwdSubdir}
                    onChange={(e) => setTaskField(index, { cwdSubdir: e.target.value })}
                    placeholder="e.g. packages/app"
                    autoComplete="off"
                  />
                </label>

                <label style={labelStyle}>
                  Command
                  <input
                    style={inputStyle}
                    value={task.command}
                    onChange={(e) => setTaskField(index, { command: e.target.value })}
                    placeholder="Shell command (runs in workspace directory)"
                    autoComplete="off"
                  />
                </label>

                <label style={labelStyle}>
                  Min. interval (minutes, scheduled runs only)
                  <input
                    type="number"
                    min={1}
                    max={10080}
                    style={inputStyle}
                    value={task.intervalMinutes}
                    onChange={(e) => setTaskField(index, { intervalMinutes: Number(e.target.value) })}
                  />
                </label>
              </fieldset>
            ))}

            {tasks.length === 0 ? (
              <p style={{ fontSize: "13px", opacity: 0.75, margin: 0 }}>
                No tasks configured — the worker will not run any commands until you add at least one task.
              </p>
            ) : null}

            <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center" }}>
              <button
                type="button"
                disabled={tasks.length >= MAX_TASKS}
                onClick={() => addTask()}
                style={{
                  padding: "8px 16px",
                  borderRadius: "8px",
                  border: "1px solid var(--border, #444)",
                  background: "transparent",
                  color: "var(--foreground, #eee)",
                  fontSize: "13px",
                  cursor: tasks.length >= MAX_TASKS ? "not-allowed" : "pointer",
                  opacity: tasks.length >= MAX_TASKS ? 0.5 : 1,
                }}
              >
                Add task ({tasks.length}/{MAX_TASKS})
              </button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <button
                type="submit"
                disabled={saving}
                style={{
                  padding: "8px 16px",
                  borderRadius: "8px",
                  border: "1px solid var(--border, #444)",
                  background: "var(--primary, #3b82f6)",
                  color: "var(--primary-foreground, #fff)",
                  fontSize: "13px",
                  cursor: saving ? "wait" : "pointer",
                  opacity: saving ? 0.7 : 1,
                }}
              >
                {saving ? "Saving…" : "Save settings"}
              </button>
              {savedMsg ? (
                <span style={{ fontSize: "12px", color: "var(--muted-foreground, #9ca3af)" }}>{savedMsg}</span>
              ) : null}
            </div>
          </form>
        )
      ) : null}

      {tab === "output" ? (
        <section>
          <h3 style={sectionTitle}>Execution log</h3>
          <p style={{ fontSize: "12px", opacity: 0.75, margin: "0 0 12px" }}>
            Merges <strong>host job runs</strong> (same cadence as the Status tab) with <strong>worker</strong> stdout/stderr
            when a command actually ran. Rows with no worker section usually mean the host ticked but every task was
            skipped (interval throttle).
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
            <button
              type="button"
              onClick={() => {
                void refresh();
                void refreshDashboard();
              }}
              style={{
                padding: "6px 12px",
                borderRadius: "8px",
                border: "1px solid var(--border, #444)",
                background: "transparent",
                color: "var(--foreground, #eee)",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              Refresh
            </button>
            {hostDash?.checkedAt ? (
              <span style={{ fontSize: "11px", color: "var(--muted-foreground, #9ca3af)" }}>
                Host data {timeAgo(hostDash.checkedAt)}
              </span>
            ) : null}
          </div>
          {historyError ? (
            <p style={{ fontSize: "13px", color: "var(--destructive, #fca5a5)" }}>{historyError.message}</p>
          ) : null}
          {hostDashErr ? (
            <p style={{ fontSize: "13px", color: "var(--destructive, #fca5a5)" }}>{hostDashErr}</p>
          ) : null}
          {historyLoading && !historyData ? (
            <p style={{ fontSize: "13px", opacity: 0.7 }}>Loading log…</p>
          ) : null}
          {!historyLoading && mergedLogRows.length === 0 ? (
            <p style={{ fontSize: "13px", opacity: 0.7 }}>No runs recorded yet.</p>
          ) : null}
          {mergedLogRows.length > 0 ? (
            <div
              style={{
                border: "1px solid color-mix(in srgb, var(--border, #444) 90%, transparent)",
                borderRadius: "8px",
                overflow: "hidden",
              }}
            >
              {mergedLogRows.map((row) => (
                <MergedRunLogRow key={row.key} host={row.host} workers={row.workers} />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
