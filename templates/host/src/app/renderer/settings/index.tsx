import { useEffect, useState, type ComponentType } from "react";
import type { ReleaseEntry, UpdateState } from "fluxplugin";
import { Button, Group, Row, Switch, showReleaseNotes, useFlux, useSidebar, useT, usePluginFramework, usePlugins, formatShortcut, useOS, type RendererFramework } from "fluxplugin/react";
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

function UpdatesSection() {
  const fw = usePluginFramework();
  const flux = useFlux();
  const t = useT();
  const [version, setVersion] = useState("");
  const [state, setState] = useState<UpdateState>();
  const [releases, setReleases] = useState<ReleaseEntry[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    void flux.app.info().then((i) => setVersion(i.version)).catch(() => undefined);
    void (fw.bridge.invoke("flux.update.state") as Promise<UpdateState>).then(setState).catch(() => setError(t("updates.disabled", "Updates are not configured: set \"updates\" in fluxplugin.config.json.")));
    void (fw.bridge.invoke("flux.update.releases") as Promise<ReleaseEntry[]>).then(setReleases).catch(() => undefined);
    return fw.bridge.on("flux.update.state", (p) => setState(p as UpdateState));
  }, [fw, flux, t]);
  return (
    <>
      <Group title={t("updates.current", "Version")}>
        <Row title={t("updates.installed", "Installed")} right={state?.current ?? version} />
        <Row title={t("updates.check", "Check for updates")} subtitle={error || (state?.status === "up-to-date" ? t("updates.upToDate", "You have the latest version.") : state?.status === "available" ? t("updates.available", "Version {v} is available.", { v: state.latest ?? "" }) : state?.status)}
          right={<Button size="sm" onClick={() => void fw.bridge.invoke("flux.update.check").catch((e: Error) => setError(e.message))}>{t("updates.checkNow", "Check now")}</Button>} />
      </Group>
      <Group title={t("updates.history", "Version history")} footer={t("updates.historyHint", "Open a version to read what changed, or download its full installer.")}>
        {releases.length === 0 && <Row title="—" />}
        {releases.map((r) => (
          <Row key={r.version} title={`v${r.version}`} subtitle={new Date(r.publishedAt).toLocaleDateString()} onClick={() => void showReleaseNotes(`v${r.version}`, r.notes)}
            right={<>{Object.entries(r.installers ?? {}).map(([plat, url]) => <Button key={plat} size="sm" onClick={() => void flux.shell.openExternal(url)}>{plat}</Button>)}</>} />
        ))}
      </Group>
    </>
  );
}

/** Host settings sections. Plugins contribute theirs to the same "settings" extension point. */
export function registerHostSettings(framework: RendererFramework): void {
  framework.manager.extensionPoints.contribute(
    "settings",
    { sections: [
      { id: "general", title: "General", icon: "settings", order: 0, component: GeneralSection as ComponentType },
      { id: "updates", title: "Updates", icon: "download", order: 80, component: UpdatesSection as ComponentType },
      { id: "shortcuts", title: "Shortcuts", icon: "command", order: 90, component: ShortcutsSection as ComponentType },
    ] },
    "host",
  );
}
