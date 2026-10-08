import { promises as fsp, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import * as core from "../core/index.js";
import {
  CHANNELS,
  FRAMEWORK_VERSION,
  LogStore,
  MGMT,
  PermissionManager,
  PluginManager,
  errorMessage,
  serializeError,
  type Bootstrap,
  type PluginDetails,
  videoEmbedUrl,
  type InvokeRequest,
  type InvokeResponse,
  type Permission,
  type PluginManagerOptions,
  type RendererPluginDescriptor,
} from "../core/index.js";
import { discoverPlugins, readPluginDir, type DiscoverOptions } from "./discover.js";
import { FsStorageBackend, JsonStateFile } from "./fs-storage.js";
import { PluginInstaller, type PluginRegistry } from "./registry.js";
import { createRegistries, type StoreSpec } from "./stores.js";

export interface MainFrameworkOptions {
  /** Directories scanned for plugins (each sub-directory with a plugin.json). */
  pluginDirs: string[];
  /** Where plugin storage/config/state lives (typically `app.getPath("userData")/plugins-data`). */
  dataDir: string;
  /** Where installs/uninstalls happen. Defaults to the first of `pluginDirs`. */
  installDir?: string;
  /** Plugin stores (default: GitHub topic store). Ready-made registries, or `stores` specs below. */
  registries?: PluginRegistry[];
  /** Store specs, same shape as `fluxplugin.config.json` → "stores". Ignored when `registries` is given. */
  stores?: StoreSpec[];
  /** Third-party plugins start with no permissions until the user approves them. Default: false (all declared granted). */
  requireApproval?: boolean;
  /** Reject plugins without a valid signature from one of these keys. */
  trustedKeys?: string[];
  requireSignature?: boolean;
  /** Re-load plugins when files change on disk. Default false (enable in development). */
  hotReload?: boolean;
  /** Builds the URL used by the renderer to import `<pluginId>/<relative file>` (custom protocol or dev server). */
  assetUrl?: (pluginId: string, relativePath: string) => string;
  /** Channels the renderer may call in addition to those exposed by plugins. */
  allowedRendererChannels?: string[];
  /** Whether renderer code may use `flux.plugins.*` management channels. Default true (the host UI needs them). */
  allowManagement?: boolean;
  frameworkVersion?: string;
  manager?: Partial<PluginManagerOptions>;
  /** Replaces discovery loader (tests). */
  discover?: DiscoverOptions;
}

type BroadcastListener = (channel: string, payload: unknown, target?: number | string) => void;

/**
 * Everything the main process needs, with no dependency on Electron. Adapters (`attachElectron`, `attachHttp`)
 * connect it to a transport. This keeps the logic testable and lets the same framework run under
 * Electron, a dev HTTP server, or an integration test.
 */
export class MainFramework {
  readonly manager: PluginManager;
  readonly logs: LogStore;
  readonly installer: PluginInstaller;
  private readonly permissions: PermissionManager;
  private readonly state: JsonStateFile;
  private readonly broadcastListeners = new Set<BroadcastListener>();
  private watchers: FSWatcher[] = [];
  private revision = 0;
  private reloadTimers = new Map<string, NodeJS.Timeout>();
  private started = false;

  constructor(readonly options: MainFrameworkOptions) {
    this.logs = new LogStore(5000);
    this.state = new JsonStateFile(path.join(options.dataDir, "plugins-state.json"));
    this.permissions = new PermissionManager({
      autoGrant: !options.requireApproval,
      onChange: (id, snap) => void this.state.update((s) => ({ approved: { ...s.approved, [id]: snap.granted } })).catch(() => undefined),
    });
    this.manager = new PluginManager({
      runtime: "main",
      storage: new FsStorageBackend(path.join(options.dataDir, "storage")),
      permissions: this.permissions,
      logs: this.logs,
      frameworkVersion: options.frameworkVersion,
      stateStore: {
        load: async () => (await this.state.readAll()).disabled,
        save: (ids) => this.state.update({ disabled: ids }),
      },
      onBroadcastEvent: (name, payload) => this.broadcast("flux.event." + name, payload),
      ...options.manager,
    });
    this.manager.ipc.setTransport({ broadcast: (c, p, t) => this.broadcast(c, p, t) });
    this.installer = new PluginInstaller(options.installDir ?? options.pluginDirs[0]!, path.join(options.dataDir, "backups"), options.registries ?? createRegistries(options.stores));
    this.manager.subscribe(() => {
      this.revision++;
      this.broadcast(MGMT.changed, { revision: this.revision });
    });
    this.manager.notifications.onPush((n) => this.broadcast("flux.notification", n));
    this.registerManagementApi();
  }

  /* --------------------------------------------------------- start / stop */

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const approved = (await this.state.readAll()).approved;
    // Plugin bundles built by `fluxplugin build` import fluxplugin / fluxplugin from the host (single instance).
    const g = globalThis as unknown as { __FLUXPLUGIN_SHARED__?: Record<string, unknown> };
    g.__FLUXPLUGIN_SHARED__ = { ...(g.__FLUXPLUGIN_SHARED__ ?? {}), "fluxplugin": core };
    this.permissions.restore(approved as Record<string, Permission[]>);
    await this.manager.init();
    await this.scan();
    await this.manager.startup();
    if (this.options.hotReload) this.watch();
  }

  private discoverOpts(): DiscoverOptions {
    return { trustedKeys: this.options.trustedKeys, requireSignature: this.options.requireSignature, ...this.options.discover };
  }

  /** (Re)scans the plugin directories and registers plugins that are new. */
  async scan(): Promise<void> {
    for (const dir of this.options.pluginDirs) {
      for (const p of await discoverPlugins(dir, this.discoverOpts())) {
        const id = typeof p.manifest["id"] === "string" ? (p.manifest["id"] as string) : "";
        if (id && this.manager.has(id)) continue;
        const info = this.manager.register(p.source);
        if (p.problem) this.logs.logger(info.id).error(p.problem);
      }
    }
  }

  async stop(): Promise<void> {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    for (const t of this.reloadTimers.values()) clearTimeout(t);
    await this.manager.dispose();
    await this.state.flush();
  }

  /** Watches plugin directories and reloads the affected plugin (debounced). */
  private watch(): void {
    for (const dir of this.options.pluginDirs) {
      try {
        const w = watch(dir, { recursive: true }, (_evt, filename) => {
          if (!filename) return;
          const parts = String(filename).split(path.sep);
          if (parts.includes("node_modules") || parts.includes("src")) return;
          const folder = parts[0]!;
          clearTimeout(this.reloadTimers.get(folder));
          this.reloadTimers.set(
            folder,
            setTimeout(() => void this.hotReloadFolder(path.join(dir, folder)), 150),
          );
        });
        this.watchers.push(w);
      } catch (e) {
        this.logs.logger("core").warn(`hot reload disabled for ${dir}: ${errorMessage(e)}`);
      }
    }
  }

  private async hotReloadFolder(root: string): Promise<void> {
    try {
      const p = await readPluginDir(root, this.discoverOpts());
      const id = String(p.manifest["id"] ?? "");
      if (!id) return;
      if (!this.manager.has(id)) {
        this.manager.register(p.source);
        await this.manager.activate(id).catch(() => undefined);
      } else {
        await this.manager.unregister(id);
        this.manager.register(p.source);
        await this.manager.activate(id).catch(() => undefined);
      }
      this.logs.logger(id).info("hot reloaded");
      this.broadcast("flux.event.plugin.hotreload", { id });
    } catch (e) {
      this.logs.logger("core").error(`hot reload failed for ${root}: ${errorMessage(e)}`);
    }
  }

  /* ----------------------------------------------------------- broadcasting */

  onBroadcast(l: BroadcastListener): () => void {
    this.broadcastListeners.add(l);
    return () => void this.broadcastListeners.delete(l);
  }

  broadcast(channel: string, payload: unknown, target?: number | string): void {
    for (const l of [...this.broadcastListeners]) {
      try {
        l(channel, payload, target);
      } catch {
        /* a broken window must not affect others */
      }
    }
  }

  /* ---------------------------------------------------------------- bootstrap */

  bootstrap(): Bootstrap {
    const assetUrl = this.options.assetUrl ?? ((id, rel) => `fluxplugin://${id}/${rel.replace(/^\.\//, "")}`);
    const plugins: RendererPluginDescriptor[] = this.manager.list().map((info) => {
      const m = this.manager.manifest(info.id);
      const rejected = info.state === "error" && info.error?.phase === "validate";
      return {
        id: info.id,
        manifest: m,
        enabled: info.enabled && !rejected,
        rendererUrl: m.renderer && !rejected ? assetUrl(info.id, m.renderer) : undefined,
        styleUrls: (m.styles ?? []).map((s) => assetUrl(info.id, s)),
        granted: info.permissions.granted,
        state: info.state,
      };
    });
    return { frameworkVersion: this.options.frameworkVersion ?? FRAMEWORK_VERSION, plugins, preload: this.manager.preload.manifest(), revision: this.revision };
  }

  /* --------------------------------------------------- renderer-facing IPC */

  private exposedChannels(kind: "invoke" | "send"): Set<string> {
    const out = new Set<string>(this.options.allowedRendererChannels ?? []);
    for (const e of this.manager.preload.list()) for (const m of Object.values(e.spec)) if (m.kind === kind) out.add(m.channel);
    return out;
  }

  /**
   * Handles an invoke coming from a renderer. Policy: the renderer may only call channels that a plugin explicitly
   * exposed through `preload.expose`, channels the host allow-listed, and (optionally) `flux.plugins.*`.
   */
  async handleInvoke(req: InvokeRequest, senderId?: number | string): Promise<InvokeResponse> {
    try {
      if (!req || typeof req.channel !== "string") throw new Error("malformed request");
      const ch = req.channel;
      const mgmt = ch.startsWith("flux.plugins.");
      if (mgmt) {
        if (this.options.allowManagement === false) throw new Error(`management API is disabled`);
      } else if (!this.exposedChannels("invoke").has(ch)) {
        throw new Error(`channel "${ch}" is not exposed to renderers`);
      }
      const caller = typeof req.caller === "string" && this.manager.has(req.caller) ? req.caller : "host";
      if (caller !== "host") this.permissions.assert(caller, "ipc", `invoke("${ch}")`);
      const value = await this.manager.ipc.invoke(ch, req.input, { caller, senderId });
      return { ok: true, value };
    } catch (e) {
      return { ok: false, error: serializeError(e) };
    }
  }

  handleSend(channel: string, payload: unknown, caller?: string, senderId?: number | string): void {
    if (typeof channel !== "string" || !this.exposedChannels("send").has(channel)) return;
    const who = typeof caller === "string" && this.manager.has(caller) ? caller : "host";
    if (who !== "host" && !this.permissions.has(who, "ipc")) return;
    this.manager.ipc.dispatch(channel, payload, { caller: who, senderId });
  }

  /* -------------------------------------------------------- management API */

  private registerManagementApi(): void {
    const ipc = this.manager.ipc;
    const h = (name: string, fn: (input: any) => unknown | Promise<unknown>) => ipc.handle(name, (i: any) => fn(i), "host");
    const list = () => this.manager.list();
    h(MGMT.list, () => list());
    h(MGMT.enable, async ({ id }) => (await this.manager.enable(id).catch((e) => this.logs.logger(id).error(errorMessage(e))), list()));
    h(MGMT.disable, async ({ id }) => (await this.manager.disable(id), list()));
    h(MGMT.reload, async ({ id }) => (await this.manager.reload(id), list()));
    h(MGMT.grant, ({ id, permission }) => (this.permissions.grant(id, permission), this.manager.info(id)));
    h(MGMT.revoke, ({ id, permission }) => (this.permissions.revoke(id, permission), this.manager.info(id)));
    h(MGMT.configGet, async ({ id }) => this.requireConfig(id).get());
    h(MGMT.configSet, async ({ id, patch }) => this.requireConfig(id).set(patch));
    h(MGMT.configReset, async ({ id }) => this.requireConfig(id).reset());
    h(MGMT.configSchema, ({ id }) => this.manager.getConfig(id)?.describe() ?? null);
    h(MGMT.logs, ({ id }) => this.logs.query(id ? { source: id } : {}).slice(-200));
    h(MGMT.diagnostics, ({ id }) => this.manager.diagnostics(id));
    h(MGMT.details, ({ id }) => this.details(id));
    h(MGMT.search, ({ query }) => this.installer.search(query));
    h(MGMT.updates, () => this.installer.updates());
    h(MGMT.install, async ({ entry }) => this.installAndLoad(entry));
    h(MGMT.update, async ({ entry }) => this.installAndLoad(entry));
    h(MGMT.uninstall, async ({ id }) => {
      await this.manager.unregister(id);
      await this.installer.uninstall(id);
      return list();
    });
    h(MGMT.rollback, async ({ id, version }) => {
      await this.manager.unregister(id);
      const r = await this.installer.rollback(id, version);
      await this.scan();
      await this.manager.activate(id).catch(() => undefined);
      return r;
    });
  }

  /** Store-page data for one plugin: icon, banner, screenshots, video and the README (Markdown). */
  async details(id: string): Promise<PluginDetails> {
    const m = this.manager.manifest(id);
    const root = this.manager.info(id).root;
    const url = this.options.assetUrl ?? ((pid, rel) => `fluxplugin://${pid}/${rel.replace(/^\.\//, "")}`);
    let readme: string | undefined;
    if (root) {
      const file = path.resolve(root, m.readme ?? "README.md");
      if (file.startsWith(path.resolve(root) + path.sep)) {
        try {
          const st = await fsp.stat(file);
          if (st.size <= 200_000) readme = await fsp.readFile(file, "utf8");
        } catch {
          /* no readme */
        }
      }
    }
    const author = typeof m.author === "string" ? m.author : m.author?.name;
    const repository = typeof m.repository === "string" ? m.repository : m.repository?.url;
    return {
      id, name: m.name, version: m.version, description: m.description, author, license: m.license, homepage: m.homepage, repository,
      categories: m.categories ?? [], keywords: m.keywords ?? [], links: m.links ?? {},
      iconUrl: m.icon ? url(id, m.icon) : undefined,
      bannerUrl: m.banner ? url(id, m.banner) : undefined,
      screenshotUrls: (m.screenshots ?? []).map((s) => url(id, s)),
      video: m.video ? { url: m.video, embedUrl: videoEmbedUrl(m.video) } : undefined,
      readme,
    };
  }

  private requireConfig(id: string) {
    const c = this.manager.getConfig(id);
    if (!c) throw new Error(`plugin "${id}" has no configuration (activate it first)`);
    return c;
  }

  private async installAndLoad(entry: Parameters<PluginInstaller["install"]>[0]) {
    const wasActive = this.manager.has(entry.id) && this.manager.info(entry.id).state === "ready";
    if (this.manager.has(entry.id)) await this.manager.unregister(entry.id);
    const r = await this.installer.install(entry);
    await this.scan();
    if (this.manager.has(entry.id) && (wasActive || !r.previousVersion)) await this.manager.activate(entry.id).catch(() => undefined);
    return r;
  }

  /** Channels used by transports. */
  static readonly channels = CHANNELS;
}
