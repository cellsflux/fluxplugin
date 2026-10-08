import { definePlugin } from "fluxplugin";
import { usePluginState } from "fluxplugin/react";

function Widget() {
  const [n, setN] = usePluginState("com.example.dashboard", "clicks", 0);
  return (
    <div className="dw-card" data-testid="dashboard-widget">
      <strong>Dashboard widget</strong>
      <p>Injected by a plugin into <code>dashboard.after</code>.</p>
      <button className="dw-btn" onClick={() => setN((c) => c + 1)}>Clicked {n} times</button>
    </div>
  );
}
const Analytics = () => <div className="dw-card"><h2>Analytics</h2><p>This page is code-split and registered at runtime by a plugin.</p></div>;

export default definePlugin({
  routes: [{ path: "/analytics", lazy: async () => ({ default: Analytics }), meta: { title: "Analytics", breadcrumb: "Analytics", menu: { label: "Analytics", order: 20 } } }],
  components: [{ slot: "dashboard.after", component: Widget, priority: 10 }],
  extensions: [{ point: "dashboard", contribution: { toolbar: [{ id: "refresh", label: "Refresh data", command: "dashboard.refresh" }] } }],
  commands: [{ id: "dashboard.refresh", title: "Refresh dashboard data", category: "Dashboard", keybinding: "Mod+Shift+R", execute: () => console.log("refreshed") }],
});
