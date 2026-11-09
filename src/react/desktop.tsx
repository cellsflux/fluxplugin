import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_CHANNELS, FILE_OPEN_EVENT, SHORTCUT_EVENT, TRAY_EVENT, resolveFileHandlers, type DesktopApi, type FileHandlerDef, type FileRef, type FluxBridge } from "../core/index.js";
import { alertApi, describeBusy } from "./alerts.js";
import { busy } from "./busy.js";
import { useExtensionItemsWithOwner, usePluginFramework } from "./components.js";
import { navigate } from "./router.js";

/** FluxAPI over IPC. `caller` is the plugin using it (permissions are checked per plugin in the main process); omit for the host. */
export function createDesktopClient(bridge: FluxBridge, caller = "host"): DesktopApi {
  const call = <T,>(channel: string, input?: unknown) => bridge.invoke(channel, input, caller === "host" ? undefined : caller) as Promise<T>;
  return {
    notify: (n) => call(API_CHANNELS.notify, n),
    files: {
      open: (o) => call(API_CHANNELS.open, o ?? {}),
      save: (o) => call(API_CHANNELS.save, o ?? {}),
      read: (ref, as) => call(API_CHANNELS.read, { ref, as }),
      write: (ref, data, as) => call(API_CHANNELS.write, { ref, data, as }),
      reveal: (ref) => call(API_CHANNELS.reveal, { ref }),
    },
    clipboard: { readText: () => call(API_CHANNELS.clipRead), writeText: (text) => call(API_CHANNELS.clipWrite, { text }) },
    shell: { openExternal: (url) => call(API_CHANNELS.openExternal, { url }) },
    app: { info: () => call(API_CHANNELS.appInfo) },
    print: (o) => call(API_CHANNELS.print, o ?? {}),
    printToPDF: () => call(API_CHANNELS.printPdf),
    tray: { set: (cfg) => call(API_CHANNELS.trayset, cfg) },
    shortcuts: { register: (accelerator) => call(API_CHANNELS.shortcutRegister, { accelerator }), unregister: (accelerator) => call(API_CHANNELS.shortcutUnregister, { accelerator }) },
  };
}

/** Registers a global shortcut while mounted and calls `onPress` when it is pressed (permission "shortcuts"). */
export function useShortcut(pluginId: string, accelerator: string, onPress: () => void): void {
  const fw = usePluginFramework();
  const cb = useRef(onPress);
  cb.current = onPress;
  useEffect(() => {
    const api = createDesktopClient(fw.bridge, pluginId);
    const off = fw.bridge.on(SHORTCUT_EVENT, (p) => { const e = p as { accelerator: string; owner: string }; if (e.accelerator === accelerator && e.owner === pluginId) cb.current(); });
    void api.shortcuts.register(accelerator).catch(() => undefined);
    return () => (off(), void api.shortcuts.unregister(accelerator).catch(() => undefined));
  }, [fw, pluginId, accelerator]);
}

/** Calls `onClick(itemId)` when one of *your* tray menu items is chosen. */
export function useTrayClick(pluginId: string, onClick: (id: string) => void): void {
  const fw = usePluginFramework();
  const cb = useRef(onClick);
  cb.current = onClick;
  useEffect(() => fw.bridge.on(TRAY_EVENT, (p) => { const e = p as { id: string; owner: string }; if (e.owner === pluginId) cb.current(e.id); }), [fw, pluginId]);
}

/** `const flux = useFlux("com.acme.notes"); await flux.files.save({ defaultName: "note.md" })` — works in any plugin or in the host. */
export function useFlux(pluginId?: string): DesktopApi {
  const fw = usePluginFramework();
  return useMemo(() => createDesktopClient(fw.bridge, pluginId), [fw, pluginId]);
}

/** Camera access (permission "camera" for plugins). `capture` grabs the current frame as a Blob. */
export function useCamera(pluginId?: string) {
  const fw = usePluginFramework();
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState("");
  const allowed = !pluginId || fw.manager.permissions.has(pluginId, "camera");
  const start = useCallback(async (video: MediaTrackConstraints | boolean = true) => {
    if (!allowed) throw new Error(`"${pluginId}" does not have the camera permission`);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video });
      setStream(s);
      setError("");
      return s;
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }, [allowed, pluginId]);
  const stop = useCallback(() => setStream((s) => (s?.getTracks().forEach((t) => t.stop()), null)), []);
  useEffect(() => stop, [stop]);
  const capture = useCallback(async (video: HTMLVideoElement, type = "image/jpeg", quality = 0.92): Promise<Blob> => {
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext("2d")!.drawImage(video, 0, 0);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("capture failed"))), type, quality));
  }, []);
  return { stream, start, stop, capture, error, allowed };
}

/** <video> bound to a MediaStream. */
export function CameraPreview({ stream, className }: { stream: MediaStream | null; className?: string }): React.ReactElement {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => void (ref.current && (ref.current.srcObject = stream)), [stream]);
  return <video ref={ref} className={className ?? "flux-video"} autoPlay playsInline muted />;
}

type Opened = { file: FileRef; handlerId?: string } | null;
let opened: Opened = null;
const openedListeners = new Set<() => void>();
const setOpened = (o: Opened) => ((opened = o), openedListeners.forEach((l) => l()));

/** The file a route handler was started for (`mode: "route"`). */
export function useOpenedFile(): FileRef | null {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((x) => x + 1);
    openedListeners.add(l);
    return () => void openedListeners.delete(l);
  }, []);
  return opened?.file ?? null;
}

let opener: ((file: FileRef, opts?: { choose?: boolean }) => void) | undefined;
/** "Open with…" from your own UI: `openFile(ref, { choose: true })` always asks which plugin should receive the file. */
export const openFile = (file: FileRef, opts?: { choose?: boolean }): void => opener?.(file, opts);

type Owned = FileHandlerDef & { owner: string };

/**
 * Receives files the OS opens (double-click, "Open with…", dropped on the icon, second launch) and files you pass to `openFile`.
 * It asks the plugins' handlers how to receive them: open a route, show a modal, or import silently. With several candidates the
 * user picks ("Open with…") and may remember the choice per extension.
 */
export function FileOpenHost(): React.ReactElement | null {
  const fw = usePluginFramework();
  const raw = useExtensionItemsWithOwner<FileHandlerDef>("fileHandlers", "handlers");
  const handlers = useMemo<Owned[]>(() => raw.map((r) => ({ ...r.value, owner: r.owner })), [raw]);
  const [chooser, setChooser] = useState<{ file: FileRef; options: Owned[] } | null>(null);
  const [modal, setModal] = useState<{ file: FileRef; handler: Owned } | null>(null);
  const [remember, setRemember] = useState(false);
  const latest = useRef(handlers);
  latest.current = handlers;

  const run = useCallback(async (h: Owned, file: FileRef) => {
    if (h.owner !== "host") await fw.bridge.invoke(API_CHANNELS.handOver, { id: file.id, pluginId: h.owner }).catch(() => undefined);
    if (h.mode === "route" && h.route) {
      setOpened({ file, handlerId: h.id });
      navigate(`${h.route}${h.route.includes("?") ? "&" : "?"}file=${encodeURIComponent(file.id)}`);
    } else if (h.mode === "modal") setModal({ file, handler: h });
    else if (h.mode === "import" && h.import) {
      const done = busy.register("busy", `Importing ${file.name}`);
      try {
        await h.import(file);
        await alertApi.alert({ title: "Imported", message: `${file.name} was imported by ${h.title}.` });
      } catch (e) {
        await alertApi.alert({ title: "Import failed", message: (e as Error).message });
      } finally {
        done();
      }
    }
  }, [fw]);

  const receive = useCallback((file: FileRef, opts: { choose?: boolean } = {}) => {
    const options = resolveFileHandlers(latest.current, file);
    if (!options.length) return void alertApi.alert({ title: "No plugin can open this file", message: `Nothing installed handles “.${file.ext}” (${file.name}). Install a plugin that supports it.` });
    let remembered: string | null = null;
    try {
      remembered = localStorage.getItem("fluxplugin.openwith." + file.ext);
    } catch {
      /* storage unavailable */
    }
    const pick = !opts.choose && (options.length === 1 ? options[0] : options.find((o) => o.id === remembered));
    if (pick) void run(pick, file);
    else setChooser({ file, options });
  }, [run]);

  useEffect(() => {
    opener = receive;
    const off = fw.bridge.on(FILE_OPEN_EVENT, (p) => receive((p as { ref: FileRef }).ref));
    // files received before the UI was ready
    void (fw.bridge.invoke(API_CHANNELS.pending) as Promise<FileRef[]>).then((list) => list?.forEach((f) => receive(f))).catch(() => undefined);
    return () => (off(), void (opener = undefined));
  }, [fw, receive]);

  if (modal) {
    const C = modal.handler.component as React.ComponentType<{ file: FileRef; onClose: () => void }> | undefined;
    return (
      <div className="flux-dialog-backdrop" role="presentation">
        <div className="flux-dialog" role="dialog" aria-modal="true" data-testid="file-modal" style={{ width: "min(720px,94vw)" }}>
          {C ? <C file={modal.file} onClose={() => setModal(null)} /> : <p>{modal.file.name}</p>}
        </div>
      </div>
    );
  }
  if (chooser) {
    return (
      <div className="flux-dialog-backdrop" role="presentation">
        <div className="flux-dialog flux-sheet" role="dialog" aria-modal="true" data-testid="open-with">
          <h3>Open “{chooser.file.name}” with…</h3>
          <div className="flux-dialog-body">
            {chooser.options.map((o) => (
              <button key={o.owner + o.id} type="button" className="flux-row is-link" data-testid={"open-with-" + o.id}
                onClick={() => { if (remember) try { localStorage.setItem("fluxplugin.openwith." + chooser.file.ext, o.id); } catch { /* ignore */ } const f = chooser.file; setChooser(null); void run(o, f); }}>
                <span className="flux-row-text"><span className="flux-row-title">{o.title}</span><span className="flux-row-sub">{o.mode === "route" ? "Opens a page" : o.mode === "modal" ? "Opens a window" : "Imports the file"} · {o.owner}</span></span>
              </button>
            ))}
            <label style={{ display: "flex", gap: 8, marginTop: 10 }}><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Always use this for .{chooser.file.ext} files</label>
          </div>
          <div className="flux-dialog-actions"><button type="button" className="flux-btn" onClick={() => setChooser(null)}>Cancel</button></div>
        </div>
      </div>
    );
  }
  return null;
}

/**
 * Asks before the window closes while something is running or unsaved. The main process (guardWindowClose) forwards the close
 * request; the choice is sent back. With an application update downloading, the user may keep it running in the background.
 */
export function QuitGuard({ updateDownloading }: { updateDownloading?: () => boolean }): null {
  const fw = usePluginFramework();
  useEffect(() => fw.bridge.on("flux.app.closeRequested", () => {
    void fw.bridge.invoke("flux.app.closeAck").catch(() => undefined); // the window is alive and will answer
    void (async () => {
      const things = describeBusy();
      const updating = updateDownloading?.() ?? false;
      if (!things.length && !updating) return void fw.bridge.invoke("flux.app.confirmClose", { ok: true });
      const choice = await alertApi.choose({
        title: "Quit the application?",
        message: <>{things.length > 0 && <><p>These would be lost:</p><ul>{things.map((t) => <li key={t}>{t}</li>)}</ul></>}{updating && <p>An update is being downloaded.</p>}</>,
        buttons: [
          { label: "Cancel", value: "cancel", variant: "secondary" },
          ...(updating ? [{ label: "Keep downloading in background", value: "background", variant: "primary" as const }] : []),
          { label: "Quit anyway", value: "quit", variant: "destructive" },
        ],
      });
      void fw.bridge.invoke("flux.app.confirmClose", { ok: choice !== "cancel", background: choice === "background" });
    })();
  }), [fw, updateDownloading]);
  return null;
}
