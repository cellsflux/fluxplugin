import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CapabilityInfo, LogEntry, PluginDetails, PluginInfo, RegistryEntryLike, SchemaDescription, UpdateAnalysis, VideoInfo } from "../core/index.js";
import { parseVideo } from "../core/index.js";
import { StoreView, priceLabel, useInstallFlows } from "./store.js";
import { alertApi, useI18n, Button, Group, Icon, Img, Markdown, PluginSlot, Row, Segmented, Switch, VideoPlayer, navigate, usePlugin, usePluginFramework, usePlugins, useParams, useT, type RendererFramework } from "../react/index.js";

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
  isSystem?: boolean;
  price?: string;
  releaseNotes?: { version: string; notes: string }[];
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
  permissions: info.permissions.declared, dependencies: info.dependencies, assetBase, homepage: d.homepage, isSystem: info.isSystem, releaseNotes: d.releaseNotes,
});
const fromEntry = (e: RegistryEntryLike): PluginView => ({
  id: e.id, name: e.name, version: e.version, description: e.description, author: e.author, license: e.license, iconUrl: e.iconUrl, bannerUrl: e.bannerUrl,
  screenshots: e.screenshots ?? [], video: parseVideo(e.video) ?? undefined, categories: e.categories ?? [], keywords: e.keywords ?? [], links: e.links ?? {}, readme: e.readme,
  permissions: e.permissions, dependencies: e.dependencies ?? {}, assetBase: e.location, homepage: e.homepage, releaseNotes: e.updates, price: priceLabel(e, "Free"),
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

function Body({ v, permissionsSlot, lockReason, readmeNote }: { v: PluginView; permissionsSlot?: (perm: string) => React.ReactNode; lockReason?: (perm: string) => string | undefined; readmeNote?: React.ReactNode }): React.ReactElement {
  const t = useT();
  return (
    <>
      {v.bannerUrl && <Img className="flux-pm-banner" src={v.bannerUrl} base={v.assetBase} alt="" />}
      <Gallery v={v} />
      {v.video && <><h3 className="sec">{t("plugins.video", "Video")}</h3><VideoPlayer video={v.video} poster={undefined} title={`${v.name} video`} /></>}
      {v.readme && <><h3 className="sec">{t("plugins.about", "About")}</h3>{readmeNote}<div data-testid="plugin-readme"><Markdown source={v.readme} baseUrl={v.assetBase} /></div></>}
      {!!v.releaseNotes?.length && <><h3 className="sec">{t("plugins.whatsNew", "What's new")}</h3><div data-testid="release-notes">{v.releaseNotes.slice(0, 5).map((n) => <details key={n.version} open={n === v.releaseNotes![0]}><summary style={{ cursor: "pointer", fontWeight: 600 }}>{n.version}</summary><Markdown source={n.notes.replace(/<!--[\s\S]*?-->/g, "")} baseUrl={v.assetBase} /></details>)}</div></>}
      <h3 className="sec">{t("plugins.permissions", "Permissions")}</h3>
      <Group footer={t("plugins.permissionsFooter", "Plugins only get what they declare. Risky access is highlighted.")}>
        {v.permissions.length === 0 && <Row title={t("plugins.noPermissions", "No special access")} />}
        {v.permissions.map((p) => {
          const [title, desc] = permInfo(p);
          return <Row key={p} icon={RISKY.has(p) ? "shield" : "check"} iconColor={RISKY.has(p) ? "var(--flux-warn)" : "var(--flux-ok)"} title={t(`perm.${p}`, title)} subtitle={lockReason?.(p) ? <><span>{desc}</span><br /><span data-testid={"lock-" + p} style={{ color: "var(--flux-warn)" }}>🔒 {lockReason(p)}</span></> : desc} right={permissionsSlot?.(p) ?? (RISKY.has(p) ? <span className="flux-pill warn">{t("plugins.sensitive", "Sensitive")}</span> : undefined)} />;
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
  const [tick, setTick] = useState(0);
  const { d, info } = useDetails(id);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const { locale } = useI18n();
  const [tr, setTr] = useState<{ text: string; translated: boolean; from?: string; provider?: string }>();
  const [original, setOriginal] = useState(false);
  useEffect(() => { setTr(undefined); client.readme(id, locale).then(setTr).catch(() => undefined); }, [client, id, locale, d?.version]);
  const [analysis, setAnalysis] = useState<UpdateAnalysis>();
  const [caps, setCaps] = useState<CapabilityInfo[]>([]);
  const flows = useInstallFlows(() => setTick((x) => x + 1));
  useEffect(() => { client.analyze(id).then(setAnalysis).catch(() => setAnalysis(undefined)); }, [client, id, info?.version, tick]);
  useEffect(() => { client.capabilities().then(setCaps).catch(() => undefined); }, [client, info?.state, info?.enabled]);
  const run = async (label: string, fn: () => Promise<unknown>, after?: () => void) => { setBusy(label); setError(""); try { await fn(); after?.(); } catch (e) { setError((e as Error).message); } finally { setBusy(""); } };
  if (!info) return <div className="flux-pm"><button className="flux-pm-back" onClick={back}><Icon name="back" size={20} />{t("plugins.back", "Plugins")}</button><div className="flux-empty">{t("plugins.notFound", "This plugin is not installed.")}</div></div>;
  const view: PluginView | undefined = d ? { ...fromDetails(d, info, d.assetBase), readme: tr?.translated && !original ? tr.text : d.readme } : undefined;
  const [stateText, cls] = stateLabel(info);
  const locks = info.permissions.locks ?? {};
  const mine = caps.filter((c) => info.provides?.includes(c.capability) && c.conflict);
  return (
    <div className="flux-pm" data-testid="plugin-details">
      <button className="flux-pm-back" onClick={back} data-testid="plugin-back"><Icon name="back" size={20} />{t("plugins.back", "Plugins")}</button>
      <div className="flux-pm-hero">
        <Icon56 url={d?.iconUrl} large />
        <div>
          <h1>{info.name}</h1>
          <div className="by">{info.author ?? info.id} · {info.isSystem && <span className="flux-pill warn" data-testid="system-badge">🔒 {t("plugins.system", "System")}</span>} <span className={"flux-pill " + cls}>{t(`state.${info.state}`, stateText)}</span></div>
          <div className="flux-pm-actions">
            {analysis?.status === "update" && <Button variant="primary" disabled={!!flows.busy} data-testid="update-button" onClick={() => void flows.update(info.id, info.name)}>{t("plugins.updateTo", "Update to {v}", { v: analysis.to })}</Button>}
            {info.isSystem ? <span style={{ color: "var(--flux-muted)" }} data-testid="system-note">{t("plugins.systemNote", "System plugin: it cannot be disabled or uninstalled.")}</span> : <>
              <Switch checked={info.enabled} label={t("plugins.enable", "Enable")} disabled={!!busy} onChange={(on) => void run(on ? "enabling" : "disabling", () => (on ? client.enable(info.id) : client.disable(info.id)))} />
              <span style={{ color: "var(--flux-muted)" }}>{info.enabled ? t("plugins.enabled", "Enabled") : t("plugins.disabled", "Disabled")}</span>
              <Button size="sm" onClick={() => void run("reloading", () => client.reload(info.id))}>{t("plugins.reload", "Reload")}</Button>
              <Button size="sm" variant="destructive" data-testid="uninstall" onClick={() => void alertApi.confirm({ title: `${t("plugins.uninstall", "Uninstall")} ${info.name}?`, message: t("plugins.uninstallBody", "Its settings are kept; you can reinstall it later."), confirmLabel: t("plugins.uninstall", "Uninstall"), destructive: true }).then((ok) => { if (ok) void run("uninstalling", () => client.uninstall(info.id), () => navigate("/plugins")); })}>{t("plugins.uninstall", "Uninstall")}</Button>
            </>}
            <PluginSlot name="manager.plugin.actions" props={{ plugin: info }} />
          </div>
        </div>
      </div>
      {error && <div className="flux-note err" role="alert" data-testid="action-error">{error}</div>}
      {analysis?.status === "inconsistent" && <div className="flux-note" data-testid="inconsistent">{analysis.reasons.join(" ")}</div>}
      {info.error && <div className="flux-plugin-error" role="alert">{info.error.phase}: {info.error.message}</div>}
      {view && <Facts v={view} extra={[["Runtime", info.state]]} />}
      <p style={{ fontSize: "1.1em" }}>{info.description}</p>
      {mine.map((c) => (
        <Group key={c.capability} title={t("plugins.capability", "Used for {c}", { c: c.capability })} footer={t("plugins.capabilityHint", "Several plugins offer this. Only one can be in charge at a time.")}>
          {c.providers.map((p) => <Row key={p.id} data-testid={"cap-" + p.id} title={p.name} subtitle={p.isSystem ? t("plugins.system", "System") : undefined} right={<Switch checked={c.owner === p.id} label={p.name} onChange={() => void run("capability", async () => setCaps(await client.setCapability(c.capability, p.id)))} />} />)}
        </Group>
      ))}
      {view ? <Body v={view} readmeNote={tr?.translated && <div className="flux-note" data-testid="readme-translated">{t("plugins.autoTranslated", "Translated automatically from {from} with {p}.", { from: tr.from ?? "?", p: tr.provider ?? "" })} <button className="flux-link" onClick={() => setOriginal(!original)}>{original ? t("plugins.showTranslation", "Show translation") : t("plugins.showOriginal", "Show original")}</button></div>} lockReason={(p) => locks[p]?.reason} permissionsSlot={(perm) => <Switch checked={info.permissions.granted.includes(perm as never)} disabled={!!locks[perm]} label={perm} onChange={(on) => void run("perm", async () => void (on ? await client.grant(info.id, perm as never) : await client.revoke(info.id, perm as never)))} />} /> : <div className="flux-loading">…</div>}
      {!!info.features?.length && (
        <>
          <h3 className="sec">{t("plugins.features", "Features")}</h3>
          <Group footer={t("plugins.featuresHint", "Turning a feature off lets you revoke the permissions only it needed.")}>
            {info.features.map((f) => <Row key={f.id} data-testid={"feature-" + f.id} title={f.title} subtitle={[f.description, f.requires.length ? `needs: ${f.requires.join(", ")}` : ""].filter(Boolean).join(" · ")} right={<Switch checked={f.enabled} label={f.title} onChange={(on) => void run("feature", () => client.setFeature(info.id, f.id, on))} />} />)}
          </Group>
        </>
      )}
      <ConfigForm id={info.id} />
      <PluginSlot name="manager.plugin.details" props={{ plugin: info }} />
      <Logs id={info.id} state={info.state} />
      {flows.dialog}
    </div>
  );
}

/** Detail screen of a plugin listed in a store (route `/plugins/store/:id`). */
export function StorePluginPage(): React.ReactElement {
  const t = useT();
  const { client } = usePluginFramework();
  const { id = "" } = useParams();
  const [entry, setEntry] = useState<RegistryEntryLike>();
  const [err, setErr] = useState("");
  const [tick, setTick] = useState(0);
  const flows = useInstallFlows(() => setTick((x) => x + 1));
  useEffect(() => { client.search(id).then((r) => setEntry(r.find((e) => e.id === id))).catch((e: Error) => setErr(e.message)); }, [client, id, tick]);
  if (!entry) return <div className="flux-pm"><button className="flux-pm-back" onClick={back}><Icon name="back" size={20} />{t("plugins.discover", "Discover")}</button>{err ? <div className="flux-plugin-error">{err}</div> : <div className="flux-loading">…</div>}</div>;
  const v = fromEntry(entry);
  return (
    <div className="flux-pm" data-testid="store-details">
      <button className="flux-pm-back" onClick={back} data-testid="plugin-back"><Icon name="back" size={20} />{t("plugins.discover", "Discover")}</button>
      <div className="flux-pm-hero">
        <Icon56 url={v.iconUrl} base={v.assetBase} large />
        <div>
          <h1>{v.name}</h1>
          <div className="by">{v.author ?? v.id}{entry.stars ? ` · ★ ${entry.stars}` : ""} · {(entry.sources ?? [entry.source]).join(", ")} · <span className={"flux-pill" + (entry.pricing && entry.pricing.model !== "free" ? " warn" : " ok")}>{v.price}</span></div>
          <div className="flux-pm-actions">
            {entry.installedVersion && !entry.updateAvailable ? <Button variant="primary" onClick={() => navigate("/plugins/" + entry.id)}>{t("plugins.open", "Open")}</Button>
              : entry.updateAvailable ? <Button variant="primary" onClick={() => void flows.update(entry.id, entry.name)} data-testid="store-update">{t("plugins.update", "Update")}</Button>
              : <Button variant="primary" disabled={!!flows.busy} onClick={() => void flows.install(entry)} data-testid="store-install">{flows.busy ? "…" : entry.pricing && entry.pricing.model !== "free" ? `${t("plugins.buyShort", "Buy")} · ${v.price}` : t("plugins.get", "Get")}</Button>}
            {entry.installedVersion && <span style={{ color: "var(--flux-muted)" }}>{t("plugins.installedVersion", "Installed: {v}", { v: entry.installedVersion })}</span>}
          </div>
        </div>
      </div>
      {entry.conflict && <div className="flux-note" data-testid="store-conflict">{t("plugins.storeConflict", "Different stores disagree about: {f}. The first store in your list is used.", { f: entry.conflict.join(", ") })}</div>}
      <Facts v={v} />
      <p style={{ fontSize: "1.1em" }}>{v.description}</p>
      <Body v={v} />
      {flows.dialog}
    </div>
  );
}

/** The plugin list: Installed · Discover (stores, paginated) · Updates. Rows open the detail screens. */
export function PluginsPage(): React.ReactElement {
  const t = useT();
  const plugins = usePlugins();
  const [tab, setTab] = useState<"installed" | "discover" | "updates">("installed");
  const [q, setQ] = useState("");
  const installed = useMemo(() => plugins.filter((p) => !q || `${p.name} ${p.id} ${p.description ?? ""}`.toLowerCase().includes(q.toLowerCase())), [plugins, q]);
  const sorted = useMemo(() => [...installed].sort((a, b) => Number(!!b.isSystem) - Number(!!a.isSystem) || a.name.localeCompare(b.name)), [installed]);
  return (
    <div className="flux-pm" data-testid="plugins-page">
      <h1 className="flux-large-title">{t("plugins.title", "Plugins")}</h1>
      <div className="flux-pm-top">
        <Segmented<"installed" | "discover" | "updates"> value={tab} onChange={setTab} label="Plugins" options={[{ value: "installed", label: t("plugins.installed", "Installed") }, { value: "discover", label: t("plugins.discover", "Discover") }, { value: "updates", label: t("plugins.updates", "Updates") }]} />
        {tab === "installed" && <input className="flux-input" style={{ maxWidth: 260 }} placeholder={t("plugins.search", "Search plugins")} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search plugins" />}
      </div>
      {tab === "installed" ? (
        <Group>
          {sorted.length === 0 && <Row title={t("plugins.none", "No plugins installed")} />}
          {sorted.map((p) => { const [label, cls] = stateLabel(p); return <div key={p.id} data-plugin={p.id}><PluginRow p={p} label={label} cls={cls} /></div>; })}
        </Group>
      ) : <StoreView key={tab} mode={tab} />}
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
      title={<>{p.name} <span style={{ color: "var(--flux-muted)", fontWeight: 400 }}>v{p.version}</span> {p.isSystem && <span className="flux-pill warn" data-testid={"system-" + p.id}>🔒 {t("plugins.system", "System")}</span>}</>} subtitle={p.description ?? p.id}
      right={<><span className={"flux-pill " + cls}>{t(`state.${p.state}`, label)}</span><Switch checked={p.enabled} disabled={p.isSystem} label={p.name} onChange={(on) => void (on ? client.enable(p.id) : client.disable(p.id)).catch((e: Error) => void alertApi.alert({ title: "Error", message: e.message }))} /></>} />
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
