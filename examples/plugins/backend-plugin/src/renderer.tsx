import { definePlugin } from "fluxplugin";
import { usePluginEvent, usePluginIPC } from "fluxplugin/react";
import { useEffect } from "react";

type Stats = { students: number; uptimeSec: number; at: number };
function StatsPage() {
  const get = usePluginIPC<void, Stats>("stats.get", { caller: "com.example.stats" });
  const add = usePluginIPC<{ count: number }, Stats>("stats.addStudent", { caller: "com.example.stats" });
  const live = usePluginEvent<{ students: number }>("stats.updated");
  useEffect(() => void get.call().catch(() => undefined), []);
  const s = add.data ?? get.data;
  return (
    <div className="st-card" data-testid="stats-page">
      <h2>Stats (from the main process)</h2>
      <p>Students: <b data-testid="students">{s?.students ?? "…"}</b> · uptime {s?.uptimeSec ?? 0}s</p>
      <p>Live push: <b data-testid="live">{live?.students ?? "waiting…"}</b></p>
      <button className="st-btn" onClick={() => void add.call({ count: 5 })}>Add 5 students</button>
      {add.error && <p role="alert">{add.error.message}</p>}
    </div>
  );
}
export default definePlugin({
  routes: [{ path: "/stats", component: StatsPage, meta: { title: "Stats", breadcrumb: "Stats", menu: { label: "Stats", order: 10 } } }],
});
