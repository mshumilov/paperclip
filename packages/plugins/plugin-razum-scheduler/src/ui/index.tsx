import { usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

type HealthData = {
  status: "ok";
  hasTarget: boolean;
  intervalMinutes: number;
  checkedAt: string;
};

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
