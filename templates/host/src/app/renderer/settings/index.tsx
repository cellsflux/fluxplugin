import type { ComponentType } from "react";
import { Group, Row, Switch, useSidebar, useT, usePluginFramework, usePlugins, formatShortcut, useOS, type RendererFramework } from "fluxplugin/react";
import { APP_NAME } from "../../shared/constants";

function GeneralSection() {
  const t = useT();
  const { collapsed, setCollapsed } = useSidebar();
  const plugins = usePlugins();
  return (
    <>
      <Group title={t("settings.about", "About")}>
        <Row title={t("settings.app", "Application")} right={APP_NAME} />
        <Row title={t("settings.plugins", "Plugins")} right={`${plugins.filter((p) => p.state === "ready").length} / ${plugins.length}`} />
        <Row title={t("settings.engine", "Engine")} right={navigator.userAgent.match(/(Electron|Chrome|Firefox|Safari)\/[\d.]+/)?.[0] ?? "—"} />
      </Group>
      <Group title={t("settings.sidebar", "Sidebar")} footer={t("settings.sidebarHint", "Collapse the sidebar to icons. Shortcut: Ctrl/Cmd+B.")}>
        <Row title={t("settings.compactSidebar", "Compact sidebar")} right={<Switch checked={collapsed} onChange={setCollapsed} label="Compact sidebar" />} />
      </Group>
    </>
  );
}

function ShortcutsSection() {
  const fw = usePluginFramework();
  const os = useOS();
  const t = useT();
  const cmds = fw.manager.commands.list().filter((c) => c.keybinding);
  return (
    <Group title={t("settings.shortcuts", "Keyboard shortcuts")}>
      {cmds.length === 0 && <Row title="—" />}
      {cmds.map((c) => <Row key={c.id} title={c.title} subtitle={c.category} right={<kbd>{formatShortcut(c.keybinding!, os)}</kbd>} />)}
    </Group>
  );
}

/** Host settings sections. Plugins contribute theirs to the same "settings" extension point. */
export function registerHostSettings(framework: RendererFramework): void {
  framework.manager.extensionPoints.contribute(
    "settings",
    { sections: [
      { id: "general", title: "General", icon: "settings", order: 0, component: GeneralSection as ComponentType },
      { id: "shortcuts", title: "Shortcuts", icon: "command", order: 90, component: ShortcutsSection as ComponentType },
    ] },
    "host",
  );
}
