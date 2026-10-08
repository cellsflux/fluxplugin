import { PluginSlot, useExtensionItems, usePluginFramework } from "fluxplugin/react";
import { EXTENSION_POINTS, SLOTS } from "../../shared/constants";
import type { ToolbarAction } from "../../shared/types";
import { useCreateItem } from "../hooks/useCreateItem";

export function DashboardPage() {
  const framework = usePluginFramework();
  const actions = useExtensionItems<ToolbarAction>(EXTENSION_POINTS.dashboard, "toolbar");
  const { create, result } = useCreateItem();
  return (
    <div>
      <h2>Dashboard</h2>
      <PluginSlot name={SLOTS.dashboardBefore} />
      <p className="hint">These buttons are contributed by plugins through a host-declared extension point.</p>
      <div className="row" data-testid="toolbar">
        {actions.map((a) => (
          <button key={a.id} className="btn" onClick={() => a.command && void framework.manager.commands.execute(a.command)}>
            {a.label}
          </button>
        ))}
      </div>
      <div className="row">
        <button className="btn" onClick={() => void create("  Ada  ")}>Create item “  Ada  ” (plugin hooks may rewrite it)</button>
        <button className="btn" onClick={() => void create("   ")}>Create empty item (a plugin may veto)</button>
      </div>
      <div className="row">
        <button className="btn" data-testid="notify" onClick={() => framework.manager.notifications.push({ title: "Hello from the host", body: "Plugins can do this too.", level: "success" })}>Show a notification</button>
      </div>
      <pre data-testid="hook-result" className="hint">{result}</pre>
      <PluginSlot name={SLOTS.dashboardAfter} />
    </div>
  );
}
