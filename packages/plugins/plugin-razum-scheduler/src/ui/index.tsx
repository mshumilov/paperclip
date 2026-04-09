import {
  usePluginData,
  type PluginSettingsPageProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";

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
  if (s === "completed" || s === "success") return "var(--chart-2, #22c55e)";
  if (s === "failed" || s === "error") return "var(--destructive, #ef4444)";
  if (s === "running" || s === "pending") return "var(--chart-4, #eab308)";
  return "var(--muted-foreground, #9ca3af)";
}

function useHostPluginDashboard(active: boolean) {
  const [data, setData] = useState<PluginDashboardPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!active) return Promise.resolve();
    setLoading(true);
    return hostFetchJson<PluginDashboardPayload>(
      `/api/plugins/${encodeURIComponent(PLUGIN_INSTANCE_KEY)}/dashboard`,
    )
      .then((d) => {
        setData(d);
        setFetchError(null);
      })
      .catch((e) => {
        setFetchError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [active]);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => void refresh(), 12_000);
    return () => window.clearInterval(t);
  }, [active, refresh]);

  return { data, loading, fetchError, refresh };
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

function HostJobRunRow({ run }: { run: PluginDashboardRecentJobRun }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: "10px",
        padding: "8px 10px",
        borderRadius: "8px",
        background: "color-mix(in srgb, var(--muted-foreground, #888) 8%, transparent)",
        fontSize: "13px",
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <span
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "999px",
              background: jobStatusColor(run.status),
              flexShrink: 0,
            }}
          />
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: "11px" }} title={run.jobKey ?? run.jobId}>
            {run.jobKey ?? run.jobId.slice(0, 8)}
          </span>
          <span
            style={{
              fontSize: "10px",
              padding: "2px 6px",
              borderRadius: "4px",
              border: "1px solid color-mix(in srgb, var(--border, #444) 80%, transparent)",
            }}
          >
            {run.trigger}
          </span>
          <span style={{ fontSize: "11px", color: "var(--muted-foreground, #9ca3af)" }}>{run.status}</span>
        </div>
        {run.error ? (
          <details style={{ marginTop: "6px" }}>
            <summary style={{ cursor: "pointer", fontSize: "12px", color: "var(--muted-foreground, #9ca3af)" }}>
              Error detail
            </summary>
            <pre
              style={{
                margin: "6px 0 0",
                fontSize: "11px",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: "var(--destructive, #fca5a5)",
              }}
            >
              {run.error}
            </pre>
          </details>
        ) : null}
      </div>
      <div
        style={{
          flexShrink: 0,
          textAlign: "right",
          fontSize: "11px",
          color: "var(--muted-foreground, #9ca3af)",
        }}
      >
        <div>{formatDurationMs(run.durationMs)}</div>
        <div title={run.createdAt}>{timeAgo(run.createdAt)}</div>
      </div>
    </div>
  );
}

const defaultConfig: Record<string, unknown> = {
  companyId: "",
  projectId: "",
  workspaceName: "",
  cwdSubdir: "",
  command: "npm run sync-incoming",
  intervalMinutes: 1,
};

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
  const [configJson, setConfigJson] = useState<Record<string, unknown>>({ ...defaultConfig });
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
        setConfigJson({ ...defaultConfig, ...(result?.configJson ?? {}) });
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
      <div>Configured: {data?.hasTarget ? "yes" : "no (set company, project, command)"}</div>
      <div>Interval: {data?.intervalMinutes ?? "—"} min (scheduled runs only)</div>
      <div style={{ opacity: 0.75 }}>Checked: {data?.checkedAt ?? "—"}</div>
    </div>
  );
}

function RunLogRow({ run }: { run: RunHistoryData["runs"][number] }) {
  const { stdoutTail, stderrTail } = run;
  const hasOutput = Boolean(stdoutTail || stderrTail);
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
          SY
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ lineHeight: 1.35 }}>
            <strong style={{ color: "var(--foreground, #eee)" }}>System</strong>
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
      </div>
    </div>
  );
}

export function SchedulerSettingsPage({ context }: PluginSettingsPageProps) {
  const [tab, setTab] = useState<"settings" | "hostJobs" | "output">("settings");
  const { configJson, setConfigJson, loading, saving, error, save } = useInstanceConfigForm();
  const { data: historyData, loading: historyLoading, error: historyError, refresh } =
    usePluginData<RunHistoryData>("run-history");
  const hostDash = useHostPluginDashboard(tab === "hostJobs");
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== "output") return;
    void refresh();
    const t = window.setInterval(() => {
      void refresh();
    }, 8000);
    return () => window.clearInterval(t);
  }, [tab, refresh]);

  function setField(key: string, value: unknown) {
    setConfigJson((c) => ({ ...c, [key]: value }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await save(configJson);
    setSavedMsg("Saved");
    window.setTimeout(() => setSavedMsg(null), 2000);
  }

  return (
    <div style={{ display: "grid", gap: "16px", maxWidth: "880px" }}>
      <div style={tabBarStyle}>
        <TabButton selected={tab === "settings"} onClick={() => setTab("settings")}>
          Configuration
        </TabButton>
        <TabButton selected={tab === "hostJobs"} onClick={() => setTab("hostJobs")}>
          Host job runs
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
              <h3 style={sectionTitle}>Scheduler configuration</h3>
              <p style={{ fontSize: "12px", opacity: 0.75, margin: 0 }}>
                Company context: {context.companyId ?? "none"} — you can paste the same company UUID below.
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

            <label style={labelStyle}>
              Company ID
              <input
                style={inputStyle}
                value={String(configJson.companyId ?? "")}
                onChange={(e) => setField("companyId", e.target.value)}
                placeholder="UUID"
                autoComplete="off"
              />
            </label>

            <label style={labelStyle}>
              Project ID
              <input
                style={inputStyle}
                value={String(configJson.projectId ?? "")}
                onChange={(e) => setField("projectId", e.target.value)}
                placeholder="UUID"
                autoComplete="off"
              />
            </label>

            <label style={labelStyle}>
              Workspace name
              <input
                style={inputStyle}
                value={String(configJson.workspaceName ?? "")}
                onChange={(e) => setField("workspaceName", e.target.value)}
                placeholder="Empty = primary workspace"
                autoComplete="off"
              />
              <span style={helpStyle}>Optional; must match a workspace display name on the project.</span>
            </label>

            <label style={labelStyle}>
              Subdirectory (under workspace)
              <input
                style={inputStyle}
                value={String(configJson.cwdSubdir ?? "")}
                onChange={(e) => setField("cwdSubdir", e.target.value)}
                placeholder="e.g. packages/app"
                autoComplete="off"
              />
            </label>

            <label style={labelStyle}>
              Command
              <input
                style={inputStyle}
                value={String(configJson.command ?? "")}
                onChange={(e) => setField("command", e.target.value)}
                placeholder="npm run sync-incoming"
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
                value={Number(configJson.intervalMinutes ?? 1)}
                onChange={(e) => setField("intervalMinutes", Number(e.target.value))}
              />
            </label>

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

      {tab === "hostJobs" ? (
        <section>
          <h3 style={sectionTitle}>Recent job runs (host)</h3>
          <p style={{ fontSize: "12px", opacity: 0.75, margin: "0 0 12px" }}>
            Same list as the board tab <strong>Status</strong> on this plugin&apos;s settings page. Worker diagnostics
            stay there; this view only mirrors scheduled job run history.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
            <button
              type="button"
              onClick={() => void hostDash.refresh()}
              disabled={hostDash.loading}
              style={{
                padding: "6px 12px",
                borderRadius: "8px",
                border: "1px solid var(--border, #444)",
                background: "transparent",
                color: "var(--foreground, #eee)",
                fontSize: "12px",
                cursor: hostDash.loading ? "wait" : "pointer",
              }}
            >
              {hostDash.loading ? "Refreshing…" : "Refresh"}
            </button>
            {hostDash.data?.checkedAt ? (
              <span style={{ fontSize: "11px", color: "var(--muted-foreground, #9ca3af)" }}>
                Checked {timeAgo(hostDash.data.checkedAt)}
              </span>
            ) : null}
          </div>
          {hostDash.fetchError ? (
            <p style={{ fontSize: "13px", color: "var(--destructive, #fca5a5)" }}>{hostDash.fetchError}</p>
          ) : null}
          {!hostDash.fetchError && hostDash.loading && !hostDash.data ? (
            <p style={{ fontSize: "13px", opacity: 0.7 }}>Loading…</p>
          ) : null}
          {hostDash.data && hostDash.data.recentJobRuns.length === 0 ? (
            <p style={{ fontSize: "13px", opacity: 0.7 }}>
              No job runs yet (or job scheduling unavailable for this plugin).
            </p>
          ) : null}
          {hostDash.data && hostDash.data.recentJobRuns.length > 0 ? (
            <div style={{ display: "grid", gap: "8px" }}>
              {hostDash.data.recentJobRuns.map((run) => (
                <HostJobRunRow key={run.id} run={run} />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {tab === "output" ? (
        <section>
          <h3 style={sectionTitle}>Execution log</h3>
          <p style={{ fontSize: "12px", opacity: 0.75, margin: "0 0 12px" }}>
            Recent command runs (newest first). Open a row to see stdout/stderr tails.
          </p>
          {historyError ? (
            <p style={{ fontSize: "13px", color: "var(--destructive, #fca5a5)" }}>{historyError.message}</p>
          ) : null}
          {historyLoading && !historyData ? (
            <p style={{ fontSize: "13px", opacity: 0.7 }}>Loading log…</p>
          ) : null}
          {historyData && historyData.runs.length === 0 ? (
            <p style={{ fontSize: "13px", opacity: 0.7 }}>No runs recorded yet.</p>
          ) : null}
          {historyData && historyData.runs.length > 0 ? (
            <div
              style={{
                border: "1px solid color-mix(in srgb, var(--border, #444) 90%, transparent)",
                borderRadius: "8px",
                overflow: "hidden",
              }}
            >
              {historyData.runs.map((run) => (
                <RunLogRow key={`${run.id}:${run.at}`} run={run} />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
