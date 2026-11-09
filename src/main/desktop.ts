import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { API_CHANNELS, FILE_OPEN_EVENT, SHORTCUT_EVENT, TRAY_EVENT, PermissionDeniedError, mimeOf, s, type DesktopApi, type FileFilter, type FileRef, type Permission } from "../core/index.js";
import type { MainFramework } from "./framework.js";

/** The OS side of FluxAPI. The Electron implementation is below; tests and non-Electron hosts supply their own. */
export interface DesktopBackend {
  notify(n: { title: string; body?: string; silent?: boolean }): void | Promise<void>;
  showOpenDialog(o: { title?: string; filters?: FileFilter[]; multiple?: boolean }): Promise<string[]>;
  showSaveDialog(o: { title?: string; defaultPath?: string; filters?: FileFilter[] }): Promise<string | undefined>;
  readFile(p: string): Promise<Buffer>;
  writeFile(p: string, data: Buffer): Promise<void>;
  stat(p: string): Promise<{ size: number; isFile: boolean }>;
  reveal(p: string): void | Promise<void>;
  readClipboard(): string | Promise<string>;
  writeClipboard(text: string): void | Promise<void>;
  openExternal(url: string): Promise<void>;
  appInfo(): { name: string; version: string; platform: string; locale: string };
  /** Optional capabilities: a backend without them makes the matching FluxAPI calls fail with a clear message. */
  print?(silent: boolean): Promise<void>;
  printToPDF?(): Promise<Buffer>;
  setTray?(t: { tooltip?: string; items: { id: string; label: string }[] } | null, onClick: (id: string) => void): void;
  registerShortcut?(accelerator: string, onPress: () => void): boolean;
  unregisterShortcut?(accelerator: string): void;
}

/** Structural subset of Electron's main-process modules (this package never imports `electron`). */
export interface ElectronDesktopLike {
  dialog: { showOpenDialog(o: any): Promise<{ canceled: boolean; filePaths: string[] }>; showSaveDialog(o: any): Promise<{ canceled: boolean; filePath?: string }> };
  Notification: new (o: { title: string; body?: string; silent?: boolean }) => { show(): void };
  clipboard: { readText(): string | Promise<string>; writeText(t: string): void | Promise<void> };
  shell: { openExternal(url: string): Promise<void>; showItemInFolder(p: string): void };
  app: { getName(): string; getVersion(): string; getLocale(): string };
  globalShortcut?: { register(accelerator: string, cb: () => void): boolean; unregister(accelerator: string): void };
  Tray?: new (icon: string) => { setToolTip(t: string): void; setContextMenu(m: unknown): void; destroy(): void };
  Menu?: { buildFromTemplate(t: unknown[]): unknown };
  BrowserWindow?: { getFocusedWindow(): { webContents: { print(o: unknown, cb?: () => void): void; printToPDF(o: unknown): Promise<Buffer> } } | null };
}

export function createElectronBackend(e: ElectronDesktopLike, opts: { trayIcon?: string } = {}): DesktopBackend {
  let tray: InstanceType<NonNullable<ElectronDesktopLike["Tray"]>> | undefined;
  const win = () => {
    const w = e.BrowserWindow?.getFocusedWindow();
    if (!w) throw new Error("no window is focused");
    return w;
  };
  const toFilters = (f?: FileFilter[]) => f?.map((x) => ({ name: x.name, extensions: x.extensions }));
  return {
    notify: (n) => void new e.Notification(n).show(),
    showOpenDialog: async (o) => {
      const r = await e.dialog.showOpenDialog({ title: o.title, filters: toFilters(o.filters), properties: ["openFile", ...(o.multiple ? ["multiSelections"] : [])] });
      return r.canceled ? [] : r.filePaths;
    },
    showSaveDialog: async (o) => {
      const r = await e.dialog.showSaveDialog({ title: o.title, defaultPath: o.defaultPath, filters: toFilters(o.filters) });
      return r.canceled ? undefined : r.filePath;
    },
    readFile: (p) => fs.readFile(p),
    writeFile: (p, d) => fs.writeFile(p, d),
    stat: async (p) => {
      const st = await fs.stat(p);
      return { size: st.size, isFile: st.isFile() };
    },
    reveal: (p) => e.shell.showItemInFolder(p),
    readClipboard: () => e.clipboard.readText(),
    writeClipboard: (t) => e.clipboard.writeText(t),
    openExternal: (u) => e.shell.openExternal(u),
    appInfo: () => ({ name: e.app.getName(), version: e.app.getVersion(), platform: process.platform, locale: e.app.getLocale() }),
    print: e.BrowserWindow ? (silent) => new Promise<void>((res) => win().webContents.print({ silent }, () => res())) : undefined,
    printToPDF: e.BrowserWindow ? () => win().webContents.printToPDF({}) : undefined,
    setTray: e.Tray && e.Menu && opts.trayIcon
      ? (cfg, onClick) => {
          tray?.destroy();
          tray = undefined;
          if (!cfg) return;
          tray = new e.Tray!(opts.trayIcon!);
          tray.setToolTip(cfg.tooltip ?? "");
          tray.setContextMenu(e.Menu!.buildFromTemplate(cfg.items.map((i) => ({ label: i.label, click: () => onClick(i.id) }))));
        }
      : undefined,
    registerShortcut: e.globalShortcut ? (a, cb) => e.globalShortcut!.register(a, cb) : undefined,
    unregisterShortcut: e.globalShortcut ? (a) => e.globalShortcut!.unregister(a) : undefined,
  };
}

export interface DesktopOptions {
  /** Largest file read/written through IPC. Default 25 MB. */
  maxBytes?: number;
  /** Folders plugins may read/write by plain path (besides the files the user picked). Default: none. */
  allowedRoots?: string[];
}

interface Grant {
  path: string;
  read: boolean;
  write: boolean;
  owners: Set<string>;
}

const SAFE_URL = /^(https?:|mailto:)/i;

/** True when `target` is `root` or lies under it. Uses path.relative, so it is right for any OS (drive-letter case, separators). */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel));
}

/**
 * Enforces FluxAPI. Plugins never get raw paths: they get **file refs** (capabilities) created when the user picks a file in a native
 * dialog or the OS hands one over, and each ref only works for the plugin it was granted to. Every method checks the caller's permission.
 */
export class DesktopService {
  private grants = new Map<string, Grant>();
  private pending: FileRef[] = [];
  private shortcutOwners = new Map<string, string>();
  private fw?: Pick<MainFramework, "broadcast">;
  /** Gives the service a way to announce shortcut presses and tray clicks. */
  attach(fw: Pick<MainFramework, "broadcast">): void {
    this.fw = fw;
  }
  constructor(
    readonly backend: DesktopBackend,
    private readonly perms: { has(pluginId: string, p: Permission): boolean },
    private readonly opts: DesktopOptions = {},
  ) {}

  private need(caller: string, perm: Permission, what: string): void {
    if (caller !== "host" && !this.perms.has(caller, perm)) throw new PermissionDeniedError(caller, perm, what);
  }

  private async ref(p: string, owner: string, read: boolean, write: boolean): Promise<FileRef> {
    const st = await this.backend.stat(p).catch(() => ({ size: 0, isFile: false }));
    const id = "f_" + crypto.randomBytes(12).toString("base64url");
    this.grants.set(id, { path: p, read, write, owners: new Set([owner]) });
    const ext = path.extname(p).replace(/^\./, "").toLowerCase();
    return { id, path: p, name: path.basename(p), ext, size: st.size, mime: mimeOf(ext) };
  }

  /** Resolves a ref (or, for the host / allowed roots, a path) to a real path, checking owner and mode. */
  private resolve(caller: string, target: FileRef | string, mode: "read" | "write"): string {
    const id = typeof target === "string" ? target : target.id;
    const g = this.grants.get(id);
    if (g) {
      if (caller !== "host" && !g.owners.has(caller)) throw new PermissionDeniedError(caller, "filesystem.read", "a file that was not shared with this plugin");
      if (!(mode === "read" ? g.read : g.write)) throw new Error(`this file reference does not allow ${mode}`);
      return g.path;
    }
    if (typeof target === "string") {
      const abs = path.resolve(target);
      if (caller === "host") return abs;
      if ((this.opts.allowedRoots ?? []).some((r) => isInside(path.resolve(r), abs))) return abs;
    }
    throw new PermissionDeniedError(caller, mode === "read" ? "filesystem.read" : "filesystem.write", "a path (use the file dialogs to get a file reference)");
  }

  async notify(caller: string, n: { title: string; body?: string; silent?: boolean }): Promise<void> {
    this.need(caller, "notifications", "desktop notifications");
    await this.backend.notify({ title: String(n.title).slice(0, 200), body: n.body?.slice(0, 1000), silent: n.silent });
  }
  async open(caller: string, o: { title?: string; filters?: FileFilter[]; multiple?: boolean } = {}): Promise<FileRef[]> {
    this.need(caller, "filesystem.read", "the open-file dialog");
    const paths = await this.backend.showOpenDialog(o);
    return Promise.all(paths.map((p) => this.ref(p, caller, true, false)));
  }
  async save(caller: string, o: { title?: string; defaultName?: string; filters?: FileFilter[] } = {}): Promise<FileRef | null> {
    this.need(caller, "filesystem.write", "the save-file dialog");
    const p = await this.backend.showSaveDialog({ title: o.title, defaultPath: o.defaultName, filters: o.filters });
    return p ? this.ref(p, caller, false, true) : null;
  }
  async read(caller: string, target: FileRef | string, as: "text" | "base64" = "text"): Promise<string> {
    this.need(caller, "filesystem.read", "reading a file");
    const p = this.resolve(caller, target, "read");
    const st = await this.backend.stat(p);
    if (st.size > (this.opts.maxBytes ?? 25_000_000)) throw new Error("file is too large for this API");
    const buf = await this.backend.readFile(p);
    return as === "base64" ? buf.toString("base64") : buf.toString("utf8");
  }
  async write(caller: string, target: FileRef | string, data: string, as: "text" | "base64" = "text"): Promise<void> {
    this.need(caller, "filesystem.write", "writing a file");
    const buf = as === "base64" ? Buffer.from(data, "base64") : Buffer.from(data, "utf8");
    if (buf.length > (this.opts.maxBytes ?? 25_000_000)) throw new Error("data is too large for this API");
    await this.backend.writeFile(this.resolve(caller, target, "write"), buf);
  }
  async reveal(caller: string, target: FileRef | string): Promise<void> {
    this.need(caller, "filesystem.read", "showing a file");
    await this.backend.reveal(this.resolve(caller, target, "read"));
  }
  async openExternal(caller: string, url: string): Promise<void> {
    this.need(caller, "shell", "opening links");
    if (!SAFE_URL.test(url)) throw new Error("only http(s) and mailto links can be opened");
    await this.backend.openExternal(url);
  }
  async readClipboard(caller: string): Promise<string> {
    this.need(caller, "clipboard", "the clipboard");
    return this.backend.readClipboard();
  }
  async writeClipboard(caller: string, text: string): Promise<void> {
    this.need(caller, "clipboard", "the clipboard");
    await this.backend.writeClipboard(text);
  }

  async print(caller: string, silent = false): Promise<void> {
    this.need(caller, "window", "printing");
    if (!this.backend.print) throw new Error("printing is not available in this application");
    await this.backend.print(silent);
  }
  async printToPDF(caller: string): Promise<string> {
    this.need(caller, "window", "printing");
    if (!this.backend.printToPDF) throw new Error("printing is not available in this application");
    return (await this.backend.printToPDF()).toString("base64");
  }
  async setTray(caller: string, cfg: { tooltip?: string; items?: { id: string; label: string }[] } | null): Promise<void> {
    this.need(caller, "window", "the tray icon");
    if (!this.backend.setTray) throw new Error("the tray icon is not available (give createElectronBackend a trayIcon)");
    this.backend.setTray(cfg && { tooltip: cfg.tooltip, items: cfg.items ?? [] }, (id) => this.fw?.broadcast(TRAY_EVENT, { id, owner: caller }));
  }
  /** Returns false when another plugin already owns the shortcut or the system refused it. */
  async registerShortcut(caller: string, accelerator: string): Promise<boolean> {
    this.need(caller, "shortcuts", "global shortcuts");
    if (!/^[A-Za-z0-9+]{1,40}$/.test(accelerator)) throw new Error("invalid accelerator");
    if (!this.backend.registerShortcut) throw new Error("global shortcuts are not available in this application");
    const owner = this.shortcutOwners.get(accelerator);
    if (owner && owner !== caller) return false;
    const ok = this.backend.registerShortcut(accelerator, () => this.fw?.broadcast(SHORTCUT_EVENT, { accelerator, owner: caller }));
    if (ok) this.shortcutOwners.set(accelerator, caller);
    return ok;
  }
  async unregisterShortcut(caller: string, accelerator: string): Promise<void> {
    if (this.shortcutOwners.get(accelerator) !== caller) return;
    this.backend.unregisterShortcut?.(accelerator);
    this.shortcutOwners.delete(accelerator);
  }

  /** The OS (or a drop) gave us a file: create a host-owned reference, queue it and tell the window. */
  async receive(p: string, fw: Pick<MainFramework, "broadcast">, source: "os" | "argv" | "drop" = "os"): Promise<FileRef | undefined> {
    const st = await this.backend.stat(p).catch(() => undefined);
    if (!st?.isFile) return undefined;
    const ref = await this.ref(path.resolve(p), "host", true, false);
    this.pending.push(ref);
    fw.broadcast(FILE_OPEN_EVENT, { ref, source });
    return ref;
  }
  takePending(): FileRef[] {
    return this.pending.splice(0);
  }
  /** The host routes a received file to a plugin's handler: from now on that plugin may read it. */
  handOver(id: string, pluginId: string): void {
    const g = this.grants.get(id);
    if (!g) throw new Error("unknown file reference");
    g.owners.add(pluginId);
  }

  /** The API as seen by one plugin (or "host"): main-process plugins use it via `ctx.host.api("flux.desktop")`. */
  forCaller(caller: string): DesktopApi {
    return {
      notify: (n) => this.notify(caller, n),
      files: {
        open: (o) => this.open(caller, o),
        save: (o) => this.save(caller, o),
        read: (r, as) => this.read(caller, r, as),
        write: (r, d, as) => this.write(caller, r, d, as),
        reveal: (r) => this.reveal(caller, r),
      },
      clipboard: { readText: () => this.readClipboard(caller), writeText: (t) => this.writeClipboard(caller, t) },
      shell: { openExternal: (u) => this.openExternal(caller, u) },
      app: { info: async () => this.backend.appInfo() },
      print: (o) => this.print(caller, o?.silent),
      printToPDF: () => this.printToPDF(caller),
      tray: { set: (cfg) => this.setTray(caller, cfg) },
      shortcuts: { register: (a) => this.registerShortcut(caller, a), unregister: (a) => this.unregisterShortcut(caller, a) },
    };
  }
}

const filters = s.array(s.object({ name: s.string(), extensions: s.array(s.string()) })).optional();
const target = s.union(s.string(), s.object({ id: s.string() }, {}));

/** Registers the FluxAPI IPC channels (callable by the renderer, which may only use what a plugin's permissions allow). */
export function registerDesktopApi(fw: MainFramework, svc: DesktopService): void {
  const ipc = fw.manager.ipc;
  const h = <I>(name: string, schema: ReturnType<typeof s.object> | ReturnType<typeof s.unknown>, fn: (input: I, caller: string) => unknown) =>
    ipc.handle(name, ((input: I, ctx: { caller: string }) => fn(input, ctx.caller)) as never, "host", { input: schema as never });
  h(API_CHANNELS.notify, s.object({ title: s.string({ min: 1 }), body: s.string().optional(), silent: s.boolean().optional() }), (i: { title: string; body?: string; silent?: boolean }, c) => svc.notify(c, i));
  h(API_CHANNELS.open, s.object({ title: s.string().optional(), filters, multiple: s.boolean().optional() }), (i: { title?: string; filters?: FileFilter[]; multiple?: boolean }, c) => svc.open(c, i));
  h(API_CHANNELS.save, s.object({ title: s.string().optional(), defaultName: s.string().optional(), filters }), (i: { title?: string; defaultName?: string; filters?: FileFilter[] }, c) => svc.save(c, i));
  h(API_CHANNELS.read, s.object({ ref: target, as: s.enum(["text", "base64"] as const).optional() }), (i: { ref: string | FileRef; as?: "text" | "base64" }, c) => svc.read(c, i.ref, i.as));
  h(API_CHANNELS.write, s.object({ ref: target, data: s.string(), as: s.enum(["text", "base64"] as const).optional() }), (i: { ref: string | FileRef; data: string; as?: "text" | "base64" }, c) => svc.write(c, i.ref, i.data, i.as));
  h(API_CHANNELS.reveal, s.object({ ref: target }), (i: { ref: string | FileRef }, c) => svc.reveal(c, i.ref));
  h(API_CHANNELS.clipRead, s.unknown(), (_i: unknown, c) => svc.readClipboard(c));
  h(API_CHANNELS.clipWrite, s.object({ text: s.string() }), (i: { text: string }, c) => svc.writeClipboard(c, i.text));
  h(API_CHANNELS.openExternal, s.object({ url: s.string() }), (i: { url: string }, c) => svc.openExternal(c, i.url));
  h(API_CHANNELS.appInfo, s.unknown(), () => svc.backend.appInfo());
  // host-only plumbing for files the OS opens
  h(API_CHANNELS.pending, s.unknown(), (_i: unknown, c) => (c === "host" ? svc.takePending() : []));
  h(API_CHANNELS.handOver, s.object({ id: s.string(), pluginId: s.string() }), (i: { id: string; pluginId: string }, c) => {
    if (c !== "host") throw new Error("only the host can hand a file to a plugin");
    svc.handOver(i.id, i.pluginId);
    return true;
  });
  svc.attach(fw);
  h(API_CHANNELS.print, s.object({ silent: s.boolean().optional() }), (i: { silent?: boolean }, c) => svc.print(c, i?.silent));
  h(API_CHANNELS.printPdf, s.unknown(), (_i: unknown, c) => svc.printToPDF(c));
  h(API_CHANNELS.trayset, s.unknown(), (i: { tooltip?: string; items?: { id: string; label: string }[] } | null, c) => svc.setTray(c, i));
  h(API_CHANNELS.shortcutRegister, s.object({ accelerator: s.string() }), (i: { accelerator: string }, c) => svc.registerShortcut(c, i.accelerator));
  h(API_CHANNELS.shortcutUnregister, s.object({ accelerator: s.string() }), (i: { accelerator: string }, c) => svc.unregisterShortcut(c, i.accelerator));
  fw.manager.provide("flux.desktop", ({ pluginId }) => svc.forCaller(pluginId));
}

/** Existing files named in a command line (Windows/Linux "Open with…" and double-click pass the path as an argument). */
export async function filesFromArgv(argv: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith("-") || /^(electron|node)(\.exe)?$/i.test(path.basename(a))) continue;
    try {
      if ((await fs.stat(a)).isFile()) out.push(path.resolve(a));
    } catch {
      /* not a file */
    }
  }
  return out;
}

export interface AppLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  requestSingleInstanceLock?(): boolean;
  quit?(): void;
}

/**
 * Wires OS file opening: macOS `open-file`, a second launch with a file (single instance), and the files in the first launch's argv.
 * Received files are announced to the window (`FILE_OPEN_EVENT`) and queued until the UI is ready.
 */
export function attachFileOpen(fw: MainFramework, app: AppLike, argv: string[] = process.argv): void {
  const svc = fw.desktop;
  if (!svc) throw new Error("enable `desktop` in MainFramework options first");
  if (app.requestSingleInstanceLock && !app.requestSingleInstanceLock()) return void app.quit?.();
  app.on("open-file", (e: { preventDefault?: () => void }, p: string) => (e?.preventDefault?.(), void svc.receive(p, fw, "os")));
  app.on("second-instance", (_e: unknown, args: string[]) => void filesFromArgv(args).then((files) => files.forEach((f) => void svc.receive(f, fw, "argv"))));
  void filesFromArgv(argv).then((files) => files.forEach((f) => void svc.receive(f, fw, "argv")));
}
