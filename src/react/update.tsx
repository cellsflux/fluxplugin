import React, { useEffect, useState } from "react";
import type { UpdateState } from "../core/index.js";
import { alertApi } from "./alerts.js";
import { usePluginFramework } from "./components.js";
import { Markdown } from "./markdown.js";

let latest: UpdateState | undefined;
/** True while an application update is downloading (the quit guard offers "keep downloading in background"). */
export const isUpdateDownloading = (): boolean => latest?.status === "downloading";

const mb = (n = 0) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

/** Show the release notes of the update in a sheet. */
export const showReleaseNotes = (title: string, notes?: string) => alertApi.alert({ title, message: notes ? <Markdown source={notes.replace(/<!--[\s\S]*?-->/g, "")} /> : "No notes were provided for this version.", okLabel: "Close" });

/** Small global card (bottom right): update available → download progress → restart. Dismissible; the download keeps running. */
export function UpdateHost(): React.ReactElement | null {
  const fw = usePluginFramework();
  const [s, setS] = useState<UpdateState>();
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const set = (x: UpdateState) => ((latest = x), setS(x), x.status === "available" || x.status === "ready" ? setHidden(false) : undefined);
    void (fw.bridge.invoke("flux.update.state") as Promise<UpdateState>).then(set).catch(() => undefined);
    return fw.bridge.on("flux.update.state", (p) => set(p as UpdateState));
  }, [fw]);
  const call = (name: string) => void fw.bridge.invoke(`flux.update.${name}`).catch((e: Error) => alertApi.alert({ title: "Update", message: e.message }));
  if (!s || hidden || !["available", "downloading", "ready", "error"].includes(s.status)) return null;
  const p = s.progress;
  const pct = p && p.totalBytes ? Math.min(100, Math.round((p.receivedBytes / p.totalBytes) * 100)) : 0;
  return (
    <div className="flux-update" role="status" data-testid="update-card" data-status={s.status}>
      <strong>{s.status === "ready" ? `Version ${s.latest} is ready` : s.status === "error" ? "Update failed" : `Version ${s.latest} ${s.status === "downloading" ? "is downloading" : "is available"}`}</strong>
      {s.status === "available" && s.requiresInstaller && <p data-testid="update-needs-installer">This version needs a full installer (your installed application is older than {s.requiresInstaller}). Download it from Settings → Updates.</p>}
      {s.status === "available" && !s.requiresInstaller && <p>Download {mb(s.totalBytes)} only{s.savedBytes ? ` (${mb(s.savedBytes)} already on your computer)` : ""}.</p>}
      {s.status === "downloading" && <><progress max={100} value={pct} data-testid="update-progress" /><p>{pct}% · {mb(p?.receivedBytes)} of {mb(p?.totalBytes)} · {p?.filesDone}/{p?.filesTotal} files</p></>}
      {s.status === "ready" && <p>Restart to use the new version. Your windows and plugins are restored.</p>}
      {s.status === "error" && <p>{s.error}</p>}
      <div className="flux-update-actions">
        {s.notes && <button type="button" className="flux-btn flux-btn-sm" onClick={() => void showReleaseNotes(`What's new in ${s.latest}`, s.notes)}>What's new</button>}
        {s.status === "available" && !s.requiresInstaller && <button type="button" className="flux-btn flux-btn-sm flux-btn-primary" data-testid="update-download" onClick={() => call("download")}>Download</button>}
        {s.status === "downloading" && <><button type="button" className="flux-btn flux-btn-sm" onClick={() => setHidden(true)}>Hide (keeps downloading)</button><button type="button" className="flux-btn flux-btn-sm" onClick={() => call("cancel")}>Cancel</button></>}
        {s.status === "ready" && <button type="button" className="flux-btn flux-btn-sm flux-btn-primary" data-testid="update-restart" onClick={() => call("restart")}>Restart now</button>}
        {s.status !== "downloading" && <button type="button" className="flux-btn flux-btn-sm" onClick={() => setHidden(true)}>Later</button>}
      </div>
    </div>
  );
}
