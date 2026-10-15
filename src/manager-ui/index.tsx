import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry, PluginDetails, PluginInfo, RegistryEntryLike, SchemaDescription, VideoInfo } from "../core/index.js";
import { parseVideo } from "../core/index.js";
import { Button, Group, Icon, Img, Markdown, PluginSlot, Row, Segmented, Switch, VideoPlayer, navigate, usePlugin, usePluginFramework, usePlugins, useParams, useT, type RendererFramework } from "../react/index.js";

/* -------------------------------------------------------------- shared model */

/** Everything the "app page" of a plugin needs, whether it is installed or only listed in a store. */
export interface PluginView {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  iconUrl?: string;
  bannerUrl?: string;
  screenshots: string[];
  video?: VideoInfo;
  categories: string[];
  keywords: string[];
  links: Record<string, string>;
  readme?: string;
  permissions: string[];
  dependencies: Record<string, string>;
  /** Base URL used to resolve relative images in the README. */
  assetBase?: string;
  homepage?: string;
}

const RISKY = new Set(["network", "filesystem.read", "filesystem.write", "shell", "database", "clipboard", "window"]);
const PERMISSIONS: Record<string, [string, string]> = {
  ipc: ["Talk to the app's background process", "Call and answer background tasks."],
  services: ["Share and use services", "Offer features to other plugins and use theirs."],
  events: ["Send and receive events", "React to what happens in the app."],
  hooks: ["Change how the app behaves", "Intercept, validate or modify operations."],
  commands: ["Add commands", "Appear in the command palette and menus, with shortcuts."],
  routes: ["Add pages", "Create its own screens in the app."],
  menus: ["Add menu entries", "Appear in the menu bar and sidebar."],
  ui: ["Add interface elements", "Place widgets and buttons in the app."],
  styles: ["Style the interface", "Add its own look."],
  storage: ["Save its own data", "Keep settings and data on this device."],
  notifications: ["Show notifications", "Alert you inside the app."],
  network: ["Use the network", "Connect to the internet."],
  "filesystem.read": ["Read files", "Open files on your computer."],
  "filesystem.write": ["Write files", "Create or change files on your computer."],
  database: ["Use the database", "Read and write the app's data."],
  window: ["Control windows", "Open, move or resize windows."],
  clipboard: ["Use the clipboard", "Copy and paste for you."],
  shell: ["Run system commands", "Launch programs on your computer."],
};
const permInfo = (p: string): [string, string] => PERMISSIONS[p] ?? (p.startsWith("x.") ? [`Custom access: ${p.slice(2)}`, "A capability defined by this app."] : [p, ""]);

const fromDetails = (d: PluginDetails, info: PluginInfo, assetBase?: string): PluginView => ({
  id: d.id, name: d.name, version: d.version, description: d.description, author: d.author, license: d.license, iconUrl: d.iconUrl, bannerUrl: d.bannerUrl,
  screenshots: d.screenshotUrls, video: d.video, categories: d.categories, keywords: d.keywords, links: d.links, readme: d.readme,
  permissions: info.permissions.declared, dependencies: info.dependencies, assetBase, homepage: d.homepage,
});
const fromEntry = (e: RegistryEntryLike): PluginView => ({
  id: e.id, name: e.name, version: e.version, description: e.description, author: e.author, license: e.license, iconUrl: e.iconUrl, bannerUrl: e.bannerUrl,
  screenshots: e.screenshots ?? [], video: parseVideo(e.video) ?? undefined, categories: e.categories ?? [], keywords: e.keywords ?? [], links: e.links ?? {}, readme: e.readme,
  permissions: e.permissions, dependencies: {}, assetBase: e.location, homepage: e.homepage,
});

/** Last store listing, so a store entry page opens instantly after clicking a row. */
let storeCache: RegistryEntryLike[] = [];

const stateLabel = (p: PluginInfo): [string, string] => (p.state === "ready" ? ["Active", "ok"] : p.state === "error" ? ["Error", "err"] : p.state === "disabled" ? ["Disabled", ""] : [p.state, ""]);

function Icon56({ url, base, large }: { url?: string; base?: string; large?: boolean }): React.ReactElement {
  return <Img className={"flux-pm-icon" + (large ? " lg" : "")} src={url} base={base} alt="" fallback={<span className={"flux-pm-icon" + (large ? " lg" : "")} style={{ background: "var(--flux-accent)", color: "#fff", alignItems: "center", justifyContent: "center" }}><Icon name="plug" size={large ? 44 : 24} /></span>} />;
}

function useDetails(id: string) {
  const { client } = usePluginFramework();
  const [d, setD] = useState<PluginDetails>();
  const info = usePlugin(id);
  useEffect(() => {
    let live = true;
    setD(undefined);
    client.details(id).then((x) => live && setD(x)).catch(() => undefined);
    return () => { live = false; };
  }, [client, id, info?.version]);
  return { d, info };
}

/* ------------------------------------------------------------------- body */

function Facts({ v, extra }: { v: PluginView; extra?: [string, string][] }): React.ReactElement {
  const items: [string, string][] = [["Category", v.categories[0] ?? "Plugin"], ["Version", v.version], ["License", v.license ?? "—"], ["Developer", v.author ?? "—"], ["Access", `${v.permissions.length}`], ...(extra ?? [])];
  return <div className="flux-pm-facts">{items.map(([k, val]) => <div className="flux-pm-fact" key={k}><small>{k}</small><b>{val}</b></div>)}</div>;
}

function Gallery({ v }: { v: PluginView }): React.ReactElement | null {
  const [zoom, setZoom] = useState<string>();
  if (!v.screenshots.length) return null;
  return (
    <>
      <h3 className="sec">Preview</h3>
      <div className="flux-pm-shots" data-testid="plugin-shots">
        {v.screenshots.map((u) => <Img key={u} src={u} base={v.assetBase} alt="screenshot" onClick={() => setZoom(u)} />)}
      </div>
      {zoom && <div className="flux-zoom" onClick={() => setZoom(undefined)}><Img src={zoom} base={v.assetBase} alt="" /></div>}
    </>
  );
}

function Body({ v, permissionsSlot }: { v: PluginView; permissionsSlot?: (perm: string) => React.ReactNode }): React.ReactElement {
  const t = useT();
  return (
    <>
      {v.bannerUrl && <Img className="flux-pm-banner" src={v.bannerUrl} base={v.assetBase} alt="" />}
      <Gallery v={v} />
      {v.video && <><h3 className="sec">{t("plugins.video", "Video")}</h3><VideoPlayer video={v.video} poster={undefined} title={`${v.name} video`} /></>}
      {v.readme && <><h3 className="sec">{t("plugins.about", "About")}</h3><div data-testid="plugin-readme"><Markdown source={v.readme} baseUrl={v.assetBase} /></div></>}
      <h3 className="sec">{t("plugins.permissions", "Permissions")}</h3>
      <Group footer={t("plugins.permissionsFooter", "Plugins only get what they declare. Risky access is highlighted.")}>
        {v.permissions.length === 0 && <Row title={t("plugins.noPermissions", "No special access")} />}
        {v.permissions.map((p) => {
          const [title, desc] = permInfo(p);
          return <Row key={p} icon={RISKY.has(p) ? "shield" : "check"} iconColor={RISKY.has(p) ? "var(--flux-warn)" : "var(--flux-ok)"} title={t(`perm.${p}`, title)} subtitle={desc} right={permissionsSlot?.(p) ?? (RISKY.has(p) ? <span className="flux-pill warn">{t("plugins.sensitive", "Sensitive")}</span> : undefined)} />;
        })}
      </Group>
      <h3 className="sec">{t("plugins.information", "Information")}</h3>
      <Group>
        <Row title={t("plugins.developer", "Developer")} right={v.author ?? "—"} />
        <Row title={t("plugins.version", "Version")} right={v.version} />
        <Row title={t("plugins.license", "License")} right={v.license ?? "—"} />
        <Row title="ID" right={<code>{v.id}</code>} />
        {Object.keys(v.dependencies).length > 0 && <Row title={t("plugins.dependencies", "Requires")} right={Object.entries(v.dependencies).map(([k, r]) => `${k} ${r}`).join(", ")} />}
        {v.keywords.length > 0 && <Row title={t("plugins.keywords", "Keywords")} right={v.keywords.join(", ")} />}
        {Object.entries(v.links).map(([k, u]) => <Row key={k} icon="external" iconColor="var(--flux-muted)" title={k[0]!.toUpperCase() + k.slice(1)} right={<a href={u} target="_blank" rel="noopener noreferrer">{new URL(u).hostname}</a>} />)}
        {v.homepage && <Row icon="external" iconColor="var(--flux-muted)" title="Source" right={<a href={v.homepage} target="_blank" rel="noopener noreferrer">{new URL(v.homepage).hostname}</a>} />}
      </Group>
    </>
  );
}

/** Auto-generated settings form from the plugin's config schema. */
export function ConfigForm({ id }: { id: string }): React.ReactElement | null {
  const { client } = usePluginFramework();
  const t = useT();
  const [schema, setSchema] = useState<SchemaDescription | null>(null);
  const [values, setValues] = useState<Record<string, any>>({});
  const [msg, setMsg] = useState("");
  useEffect(() => { client.configSchema(id).then(setSchema).catch(() => setSchema(null)); client.configGet(id).then(setValues).catch(() => undefined); }, [client, id]);
  if (!schema?.properties) return null;
  const save = (patch: Record<string, unknown>) => client.configSet(id, patch).then((v) => (setValues(v), setMsg(t("plugins.saved", "Saved")))).catch((e: Error) => setMsg(e.message));
  return (
    <>
      <h3 className="sec">{t("plugins.settings", "Settings")}</h3>
      <Group footer={msg || undefined}>
        {Object.entries(schema.properties).map(([k, d]) => (
          <Row key={k} title={d.title ?? k} subtitle={d.description} right={
            d.type === "boolean" ? <Switch checked={!!values[k]} onChange={(v) => void save({ [k]: v })} label={d.title ?? k} />
            : d.type === "enum" ? <select className="flux-select" value={values[k] ?? ""} onChange={(e) => void save({ [k]: e.target.value })}>{d.enum?.map((o) => <option key={String(o)}>{String(o)}</option>)}</select>
            : <input className="flux-input" style={{ width: 160 }} type={d.type === "number" ? "number" : "text"} value={values[k] ?? ""} onChange={(e) => setValues({ ...values, [k]: d.type === "number" ? Number(e.target.value) : e.target.value })} onBlur={() => void save({ [k]: values[k] })} />} />
        ))}
        <Row title={t("plugins.reset", "Reset to defaults")} onClick={() => void client.configReset(id).then(setValues)} />
      </Group>
    </>
  );
}

function Logs({ id, state }: { id: string; state: string }): React.ReactElement {
  const { client } = usePluginFramework();
  const t = useT();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  useEffect(() => { client.logs(id).then(setLogs).catch(() => undefined); }, [client, id, state]);
  return (
    <details style={{ marginTop: 26 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>{t("plugins.logs", "Logs")} ({logs.length})</summary>
      <pre className="flux-pre">{logs.map((l) => `${new Date(l.time).toLocaleTimeString()} ${l.level.toUpperCase()} ${l.message}`).join("\n") || t("plugins.noLogs", "No logs")}</pre>
    </details>
  );
}

/* ------------------------------------------------------------------- pages */

const back = (): void => (history.length > 1 ? history.back() : navigate("/plugins"));

/** Detail screen of an installed plugin (route `/plugins/:id`). */
export function PluginDetailsPage(): React.ReactElement {
  const t = useT();
  const { client } = usePluginFramework();
  const { id = "" } = useParams();
  const { d, info } = useDetails(id);
  const [busy, setBusy] = useState("");
  const run = async (label: string, fn: () => Promise<unknown>, after?: () => void) => { setBusy(label); try { await fn(); after?.(); } catch (e) { alert((e as Error).message); } finally { setBusy(""); } };
  if (!info) return <div className="flux-pm"><button className="flux-pm-back" onClick={back}><Icon name="back" size={20} />{t("plugins.back", "Plugins")}</button><div className="flux-empty">{t("plugins.notFound", "This plugin is not installed.")}</div></div>;
  const view: PluginView | undefined = d ? fromDetails(d, info, d.assetBase) : undefined;
  const [stateText, cls] = stateLabel(info);
  return (
    <div className="flux-pm" data-testid="plugin-details">
      <button className="flux-pm-back" onClick={back} data-testid="plugin-back"><Icon name="back" size={20} />{t("plugins.back", "Plugins")}</button>
      <div className="flux-pm-hero">
        <Icon56 url={d?.iconUrl} large />
        <div>
          <h1>{info.name}</h1>
          <div className="by">{info.author ?? info.id} · <span className={"flux-pill " + cls}>{t(`state.${info.state}`, stateText)}</span></div>
          <div className="flux-pm-actions">
            <Switch checked={info.enabled} label={t("plugins.enable", "Enable")} disabled={!!busy} onChange={(on) => void run(on ? "enabling" : "disabling", () => (on ? client.enable(info.id) : client.disable(info.id)))} />
            <span style={{ color: "var(--flux-muted)" }}>{info.enabled ? t("plugins.enabled", "Enabled") : t("plugins.disabled", "Disabled")}</span>
            <Button size="sm" onClick={() => void run("reloading", () => client.reload(info.id))}>{t("plugins.reload", "Reload")}</Button>
            <Button size="sm" variant="destructive" onClick={() => confirm(`${t("plugins.uninstall", "Uninstall")} ${info.name}?`) && void run("uninstalling", () => client.uninstall(info.id), () => navigate("/plugins"))}>{t("plugins.uninstall", "Uninstall")}</Button>
            <PluginSlot name="manager.plugin.actions" props={{ plugin: info }} />
          </div>
        </div>
      </div>
      {info.error && <div className="flux-plugin-error" role="alert">{info.error.phase}: {info.error.message}</div>}
      {view && <Facts v={view} extra={[["Runtime", info.state]]} />}
      <p style={{ fontSize: "1.1em" }}>{info.description}</p>
      {view ? <Body v={view} permissionsSlot={(perm) => <Switch checked={info.permissions.granted.includes(perm as never)} label={perm} onChange={(on) => void (on ? client.grant(info.id, perm as never) : client.revoke(info.id, perm as never))} />} /> : <div className="flux-loading">…</div>}
      <ConfigForm id={info.id} />
      <PluginSlot name="manager.plugin.details" props={{ plugin: info }} />
      <Logs id={info.id} state={info.state} />
    </div>
  );
}

/** Detail screen of a plugin listed in a store (route `/plugins/store/:id`). */
export function StorePluginPage(): React.ReactElement {
  const t = useT();
  const { client } = usePluginFramework();
  const { id = "" } = useParams();
  const [entry, setEntry] = useState<RegistryEntryLike | undefined>(() => storeCache.find((e) => e.id === id));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (entry) return;
    client.search(id).then((r) => setEntry(r.find((e) => e.id === id))).catch((e: Error) => setErr(e.message));
  }, [client, id, entry]);
  const install = async () => { if (!entry) return; setBusy(true); try { await (entry.installedVersion ? client.update(entry) : client.install(entry)); navigate("/plugins/" + entry.id); } catch (e) { alert((e as Error).message); } finally { setBusy(false); } };
  if (!entry) return <div className="flux-pm"><button className="flux-pm-back" onClick={back}><Icon name="back" size={20} />{t("plugins.discover", "Discover")}</button>{err ? <div className="flux-plugin-error">{err}</div> : <div className="flux-loading">…</div>}</div>;
  const v = fromEntry(entry);
  const needsUpdate = !!entry.installedVersion && entry.installedVersion !== entry.version;
  return (
    <div className="flux-pm" data-testid="store-details">
      <button className="flux-pm-back" onClick={back} data-testid="plugin-back"><Icon name="back" size={20} />{t("plugins.discover", "Discover")}</button>
      <div className="flux-pm-hero">
        <Icon56 url={v.iconUrl} base={v.assetBase} large />
        <div>
          <h1>{v.name}</h1>
          <div className="by">{v.author ?? v.id}{entry.stars ? ` · ★ ${entry.stars}` : ""} · {entry.source}</div>
          <div className="flux-pm-actions">
            {entry.installedVersion && !needsUpdate ? <Button variant="primary" onClick={() => navigate("/plugins/" + entry.id)}>{t("plugins.open", "Open")}</Button>
              : <Button variant="primary" disabled={busy} onClick={() => void install()} data-testid="store-install">{busy ? "…" : needsUpdate ? t("plugins.update", "Update") : t("plugins.get", "Get")}</Button>}
            {entry.installedVersion && <span style={{ color: "var(--flux-muted)" }}>{t("plugins.installedVersion", "Installed: {v}", { v: entry.installedVersion })}</span>}
          </div>
        </div>
      </div>
      <Facts v={v} />
      <p style={{ fontSize: "1.1em" }}>{v.description}</p>
      <Body v={v} />
    </div>
  );
}

/** The plugin list: Installed · Discover (stores) · Updates. Rows open the detail screens. */
export function PluginsPage(): React.ReactElement {
  const t = useT();
  const { client } = usePluginFramework();
  const plugins = usePlugins();
  const [tab, setTab] = useState<"installed" | "discover" | "updates">("installed");
  const [q, setQ] = useState("");
  const [entries, setEntries] = useState<RegistryEntryLike[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (tab === "installed") return;
    let live = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setLoading(true); setError("");
      (tab === "discover" ? client.search(q || undefined) : client.updates())
        .then((e) => { if (live) { setEntries(e); if (tab === "discover") storeCache = e; } })
        .catch((e: Error) => live && (setEntries([]), setError(e.message)))
        .finally(() => live && setLoading(false));
    }, tab === "discover" && q ? 350 : 0);
    return () => { live = false; };
  }, [client, tab, q]);
  const installed = useMemo(() => plugins.filter((p) => !q || `${p.name} ${p.id} ${p.description ?? ""}`.toLowerCase().includes(q.toLowerCase())), [plugins, q]);
  const act = useCallback(async (e: RegistryEntryLike) => { setBusy(e.id); try { await (e.installedVersion ? client.update(e) : client.install(e)); setEntries((l) => l.map((x) => (x.id === e.id ? { ...x, installedVersion: e.version } : x))); } catch (err) { alert((err as Error).message); } finally { setBusy(""); } }, [client]);
  return (
    <div className="flux-pm" data-testid="plugins-page">
      <h1 className="flux-large-title">{t("plugins.title", "Plugins")}</h1>
      <div className="flux-pm-top">
        <Segmented<"installed" | "discover" | "updates"> value={tab} onChange={setTab} label="Plugins" options={[{ value: "installed", label: t("plugins.installed", "Installed") }, { value: "discover", label: t("plugins.discover", "Discover") }, { value: "updates", label: t("plugins.updates", "Updates") }]} />
        <input className="flux-input" style={{ maxWidth: 260 }} placeholder={t("plugins.search", "Search plugins")} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search plugins" />
      </div>
      {tab === "installed" && (
        <Group>
          {installed.length === 0 && <Row title={t("plugins.none", "No plugins installed")} />}
          {installed.map((p) => {
            const [label, cls] = stateLabel(p);
            return <div key={p.id} data-plugin={p.id}><PluginRow p={p} label={label} cls={cls} /></div>;
          })}
        </Group>
      )}
      {tab !== "installed" && loading && <div className="flux-loading">{t("plugins.searching", "Searching the plugin stores…")}</div>}
      {tab !== "installed" && error && <div className="flux-plugin-error" role="alert" data-testid="store-error">{error}</div>}
      {tab !== "installed" && !loading && !error && entries.length === 0 && <div className="flux-empty" data-testid="store-empty">{tab === "updates" ? t("plugins.upToDate", "Everything is up to date.") : t("plugins.storeEmpty", "No plugins found in your stores.")}</div>}
      {tab !== "installed" && entries.length > 0 && (
        <Group>
          {entries.map((e) => {
            const update = !!e.installedVersion && e.installedVersion !== e.version;
            return (
              <div key={e.id + e.version} data-store-entry={e.id}>
                <Row onClick={() => navigate("/plugins/store/" + e.id)} chevron
                  icon={<Img src={e.iconUrl} base={e.location} alt="" fallback={<Icon name="plug" size={16} />} style={{ width: 28, height: 28 }} />} iconColor={e.iconUrl ? "transparent" : undefined}
                  title={<>{e.name} <span style={{ color: "var(--flux-muted)", fontWeight: 400 }}>v{e.version}</span></>} subtitle={e.description ?? e.id}
                  right={e.installedVersion && !update ? <span className="flux-pill ok">{t("plugins.installedTag", "Installed")}</span> : <Button size="sm" variant="primary" disabled={busy === e.id} onClick={() => void act(e)}>{busy === e.id ? "…" : update || tab === "updates" ? t("plugins.update", "Update") : t("plugins.get", "Get")}</Button>} />
              </div>
            );
          })}
        </Group>
      )}
    </div>
  );
}

function PluginRow({ p, label, cls }: { p: PluginInfo; label: string; cls: string }): React.ReactElement {
  const { client } = usePluginFramework();
  const t = useT();
  const [url, setUrl] = useState<string>();
  useEffect(() => { client.details(p.id).then((d) => setUrl(d.iconUrl)).catch(() => undefined); }, [client, p.id, p.version]);
  return (
    <Row onClick={() => navigate("/plugins/" + p.id)} chevron data-testid={"row-" + p.id}
      icon={<Img src={url} alt="" fallback={<Icon name="plug" size={16} />} style={{ width: 28, height: 28 }} />} iconColor={url ? "transparent" : undefined}
      title={<>{p.name} <span style={{ color: "var(--flux-muted)", fontWeight: 400 }}>v{p.version}</span></>} subtitle={p.description ?? p.id}
      right={<><span className={"flux-pill " + cls}>{t(`state.${p.state}`, label)}</span><Switch checked={p.enabled} label={p.name} onChange={(on) => void (on ? client.enable(p.id) : client.disable(p.id))} /></>} />
  );
}

/** Registers `/plugins`, `/plugins/:id` and `/plugins/store/:id` with their breadcrumbs. */
export function registerPluginManagerRoutes(framework: RendererFramework): void {
  const r = framework.manager.routes;
  r.register({ path: "/plugins", component: PluginsPage, meta: { title: "Plugins", breadcrumb: "Plugins" } }, "host");
  r.register({ path: "/plugins/:id", component: PluginDetailsPage, meta: { breadcrumb: (p) => p["id"] ?? "" } }, "host");
  r.register({ path: "/plugins/store/:id", component: StorePluginPage, meta: { breadcrumb: (p) => p["id"] ?? "" } }, "host");
}

/** Back-compat: the list page. */
export const PluginManagerUI = PluginsPage;
