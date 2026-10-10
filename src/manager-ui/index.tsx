import React, { useCallback, useEffect, useState } from "react";
import type { LogEntry, PluginDetails, PluginInfo, RegistryEntryLike, SchemaDescription } from "../core/index.js";
import { Icon, Markdown, PluginSlot, usePluginFramework, usePlugins } from "../react/index.js";

const css = `.fluxm{font:14px system-ui;color:var(--flux-fg,#0f172a)}.fluxm h2{margin:0 0 12px}.fluxm-tabs{display:flex;gap:6px;margin-bottom:12px}
.fluxm button{cursor:pointer;border:1px solid var(--flux-border,#e2e8f0);background:var(--flux-surface,#f8fafc);color:inherit;border-radius:8px;padding:5px 10px}
.fluxm button.on{background:var(--flux-accent,#4f46e5);color:#fff;border-color:transparent}.fluxm button.danger{color:#dc2626}
.fluxm-row{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--flux-border,#e2e8f0);border-radius:10px;margin-bottom:8px}
.fluxm-grow{flex:1;min-width:0}.fluxm-muted{color:var(--flux-muted,#64748b);font-size:12px}
.fluxm-badge{font-size:11px;padding:1px 8px;border-radius:99px;background:#e2e8f0;color:#334155}.fluxm-ready{background:#dcfce7;color:#166534}.fluxm-error{background:#fee2e2;color:#991b1b}.fluxm-disabled{background:#f1f5f9;color:#64748b}
.fluxm-panel{border:1px solid var(--flux-border,#e2e8f0);border-radius:12px;padding:14px;margin-top:12px}.fluxm pre{max-height:180px;overflow:auto;font-size:11px;background:var(--flux-surface,#f8fafc);padding:8px;border-radius:8px}
.fluxm label{display:flex;gap:8px;align-items:center;margin:6px 0}.fluxm input[type=text],.fluxm input[type=number]{padding:4px 8px;border:1px solid var(--flux-border,#e2e8f0);border-radius:6px}`;

const badge = (p: PluginInfo) => <span className={`fluxm-badge fluxm-${p.state === "ready" ? "ready" : p.state === "error" ? "error" : p.state === "disabled" ? "disabled" : ""}`}>{p.state}</span>;

/** Auto-generated settings form from a plugin's config schema (`ctx.config.describe()`). */
export function ConfigForm({ id }: { id: string }): React.ReactElement | null {
  const { client } = usePluginFramework();
  const [schema, setSchema] = useState<SchemaDescription | null>(null);
  const [values, setValues] = useState<Record<string, any>>({});
  const [msg, setMsg] = useState("");
  useEffect(() => { client.configSchema(id).then(setSchema).catch(() => setSchema(null)); client.configGet(id).then(setValues).catch(() => undefined); }, [client, id]);
  if (!schema?.properties) return null;
  const save = (patch: Record<string, unknown>) => client.configSet(id, patch).then((v) => (setValues(v), setMsg("Saved"))).catch((e) => setMsg(String(e.message)));
  return (
    <div className="fluxm-panel"><strong>Settings</strong>
      {Object.entries(schema.properties).map(([k, d]) => (
        <label key={k}><span style={{ minWidth: 120 }}>{d.title ?? k}</span>
          {d.type === "boolean" ? <input type="checkbox" checked={!!values[k]} onChange={(e) => save({ [k]: e.target.checked })} />
            : d.type === "enum" ? <select value={values[k] ?? ""} onChange={(e) => save({ [k]: e.target.value })}>{d.enum?.map((o) => <option key={String(o)}>{String(o)}</option>)}</select>
            : <input type={d.type === "number" ? "number" : "text"} value={values[k] ?? ""} onChange={(e) => setValues({ ...values, [k]: d.type === "number" ? Number(e.target.value) : e.target.value })} onBlur={() => save({ [k]: values[k] })} />}
        </label>))}
      <div className="fluxm-muted">{msg}</div><button onClick={() => client.configReset(id).then(setValues)}>Reset to defaults</button>
    </div>);
}

const css2 = `.fluxm-icon{width:40px;height:40px;border-radius:10px;object-fit:cover;background:var(--flux-border);display:inline-flex;align-items:center;justify-content:center;flex:none}
.fluxm-banner{width:100%;max-height:180px;object-fit:cover;border-radius:10px;margin:8px 0}.fluxm-shots{display:flex;gap:8px;overflow:auto;padding:4px 0}.fluxm-shots img{height:110px;border-radius:8px;border:1px solid var(--flux-border);cursor:zoom-in}
.fluxm-video{aspect-ratio:16/9;width:100%;max-width:560px;border:0;border-radius:10px;background:#000}.fluxm-chip{display:inline-block;font-size:11px;padding:1px 8px;border-radius:99px;background:var(--flux-surface);border:1px solid var(--flux-border);margin:0 4px 4px 0}
.fluxm-zoom{position:fixed;inset:0;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;z-index:9999;cursor:zoom-out}.fluxm-zoom img{max-width:92vw;max-height:90vh;border-radius:10px}
.fluxm h3{margin:16px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--flux-muted)}`;

/** Plugin icon (from `manifest.icon`) with a fallback glyph. Loaded lazily through the details API. */
function PluginIcon({ id, url }: { id: string; url?: string }): React.ReactElement {
  const [broken, setBroken] = useState(false);
  return url && !broken ? <img className="fluxm-icon" src={url} alt="" data-testid={"icon-" + id} onError={() => setBroken(true)} /> : <span className="fluxm-icon"><Icon name="plug" size={20} /></span>;
}

function Details({ p, onClose }: { p: PluginInfo; onClose: () => void }): React.ReactElement {
  const { client } = usePluginFramework();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [d, setD] = useState<PluginDetails>();
  const [zoom, setZoom] = useState<string>();
  useEffect(() => { client.logs(p.id).then(setLogs).catch(() => undefined); }, [client, p.id, p.state]);
  useEffect(() => { setD(undefined); client.details(p.id).then(setD).catch(() => undefined); }, [client, p.id, p.version]);
  return (
    <div className="fluxm-panel" data-testid="plugin-details">
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <PluginIcon id={p.id} url={d?.iconUrl} />
        <div className="fluxm-grow"><strong>{p.name}</strong> <span className="fluxm-muted">{p.id}@{p.version}</span>
          <div className="fluxm-muted">{[d?.author, d?.license].filter(Boolean).join(" · ")}</div></div>
        <button onClick={onClose}>Close</button>
      </div>
      <div>{d?.categories.map((c) => <span key={c} className="fluxm-chip">{c}</span>)}{d?.keywords.map((c) => <span key={c} className="fluxm-chip">#{c}</span>)}</div>
      {d?.bannerUrl && <img className="fluxm-banner" src={d.bannerUrl} alt="" />}
      <p>{p.description}</p>
      {p.error && <p className="fluxm-error fluxm-badge">{p.error.phase}: {p.error.message}</p>}
      {d?.video && (<><h3>Video</h3>{d.video.embedUrl
        ? <iframe className="fluxm-video" data-testid="plugin-video" src={d.video.embedUrl} title="Plugin video" allow="encrypted-media; picture-in-picture; fullscreen" sandbox="allow-scripts allow-same-origin allow-presentation" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen />
        : <a href={d.video.url} target="_blank" rel="noopener noreferrer"><Icon name="play" /> Watch the video</a>}</>)}
      {!!d?.screenshotUrls.length && (<><h3>Screenshots</h3><div className="fluxm-shots" data-testid="plugin-shots">{d.screenshotUrls.map((u) => <img key={u} src={u} alt="screenshot" onClick={() => setZoom(u)} />)}</div></>)}
      {d?.readme && (<><h3>About</h3><div data-testid="plugin-readme"><Markdown source={d.readme} /></div></>)}
      {d && Object.keys(d.links).length > 0 && (<><h3>Links</h3>{Object.entries(d.links).map(([k, u]) => <div key={k}><a href={u} target="_blank" rel="noopener noreferrer">{k}</a></div>)}</>)}
      <h3>Permissions</h3>
      {p.permissions.declared.length === 0 && <div className="fluxm-muted">none requested</div>}
      {p.permissions.declared.map((perm) => { const on = p.permissions.granted.includes(perm); return (
        <label key={perm}><input type="checkbox" checked={on} onChange={() => (on ? client.revoke(p.id, perm) : client.grant(p.id, perm))} />{perm}</label>); })}
      <div><strong>Dependencies</strong> <span className="fluxm-muted">{Object.entries(p.dependencies).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}</span></div>
      <div><strong>Required by</strong> <span className="fluxm-muted">{p.dependents.join(", ") || "nobody"}</span></div>
      <ConfigForm id={p.id} />
      <PluginSlot name="manager.plugin.details" props={{ plugin: p }} />
      <h3>Logs</h3><pre>{logs.map((l) => `${new Date(l.time).toLocaleTimeString()} ${l.level.toUpperCase()} ${l.message}`).join("\n") || "no logs"}</pre>
      {zoom && <div className="fluxm-zoom" onClick={() => setZoom(undefined)}><img src={zoom} alt="" /></div>}
    </div>);
}

function PluginIconLazy({ id }: { id: string }): React.ReactElement {
  const { client } = usePluginFramework();
  const [url, setUrl] = useState<string>();
  useEffect(() => { client.details(id).then((d) => setUrl(d.iconUrl)).catch(() => undefined); }, [client, id]);
  return <PluginIcon id={id} url={url} />;
}

/** Full plugin manager screen. Extensible through the `manager.plugin.actions` / `manager.plugin.details` slots. */
export function PluginManagerUI(): React.ReactElement {
  const { client } = usePluginFramework();
  const plugins = usePlugins();
  const [tab, setTab] = useState<"installed" | "available" | "updates">("installed");
  const [sel, setSel] = useState<string>();
  const [avail, setAvail] = useState<RegistryEntryLike[]>([]);
  const [storeError, setStoreError] = useState("");
  const [loadingStore, setLoadingStore] = useState(false);
  const [busy, setBusy] = useState("");
  const wrap = useCallback(async (label: string, fn: () => Promise<unknown>) => { setBusy(label); try { await fn(); } catch (e) { alert((e as Error).message); } finally { setBusy(""); } }, []);
  useEffect(() => {
    if (tab === "installed") return;
    let live = true;
    setLoadingStore(true); setStoreError("");
    (tab === "available" ? client.search() : client.updates())
      .then((e) => live && setAvail(e))
      .catch((e: Error) => live && (setAvail([]), setStoreError(e.message)))
      .finally(() => live && setLoadingStore(false));
    return () => { live = false; };
  }, [client, tab]);
  const selected = plugins.find((p) => p.id === sel);
  return (
    <div className="fluxm"><style>{css}{css2}</style>
      <h2>Plugins {busy && <span className="fluxm-muted">{busy}…</span>}</h2>
      <div className="fluxm-tabs">{(["installed", "available", "updates"] as const).map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t[0]!.toUpperCase() + t.slice(1)}</button>)}</div>
      {tab === "installed" && plugins.map((p) => (
        <div className="fluxm-row" key={p.id} data-plugin={p.id}>
          <PluginIconLazy id={p.id} /><div className="fluxm-grow"><strong>{p.name}</strong> <span className="fluxm-muted">v{p.version}</span> {badge(p)}<div className="fluxm-muted">{p.description}</div></div>
          <PluginSlot name="manager.plugin.actions" props={{ plugin: p }} />
          <button onClick={() => setSel(p.id)}>Details</button>
          <button onClick={() => wrap("reloading", () => client.reload(p.id))}>Reload</button>
          {p.enabled ? <button onClick={() => wrap("disabling", () => client.disable(p.id))}>Disable</button> : <button className="on" onClick={() => wrap("enabling", () => client.enable(p.id))}>Enable</button>}
          <button className="danger" onClick={() => confirm(`Uninstall ${p.name}?`) && wrap("uninstalling", () => client.uninstall(p.id))}>Uninstall</button>
        </div>))}
      {tab !== "installed" && loadingStore && <div className="fluxm-muted">Searching the plugin stores…</div>}
      {tab !== "installed" && storeError && <div className="fluxm-error fluxm-badge" role="alert" data-testid="store-error">{storeError}</div>}
      {tab !== "installed" && !loadingStore && !storeError && avail.length === 0 && (
        <div className="fluxm-muted" data-testid="store-empty">{tab === "updates" ? "Everything is up to date." : "No plugins found. Plugins published with `fluxplugin publish` appear here; you can add your own store in fluxplugin.config.json."}</div>)}
      {tab !== "installed" && avail.map((e) => (
        <div className="fluxm-row" key={e.id + e.version} data-store-entry={e.id}>
          <div className="fluxm-grow">
            <strong>{e.name}</strong> <span className="fluxm-muted">v{e.version}{e.stars ? ` · ★ ${e.stars}` : ""} · {e.source}</span>
            <div className="fluxm-muted">{e.description}</div>
            <div className="fluxm-muted">asks for: {e.permissions.join(", ") || "no permissions"}{e.homepage ? <> · <a href={e.homepage} target="_blank" rel="noopener noreferrer">source</a></> : null}</div>
          </div>
          <button className="on" onClick={() => wrap("installing", () => (tab === "updates" ? client.update(e) : client.install(e)))}>{tab === "updates" ? "Update" : "Install"}</button>
        </div>))}
      {selected && <Details p={selected} onClose={() => setSel(undefined)} />}
    </div>);
}
