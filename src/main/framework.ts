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
  API_CHANNELS,
  type CatalogQuery,
  type InstallPlan,
  compareVersions,
  isValidVersion,
  queryCatalog,
  type PluginDetails,
  parseVideo,
  type InvokeRequest,
  type InvokeResponse,
  type Permission,
  type PluginManagerOptions,
  type RendererPluginDescriptor,
} from "../core/index.js";
import { discoverPlugins, readPluginDir, type DiscoverOptions } from "./discover.js";
import { FsStorageBackend, JsonStateFile } from "./fs-storage.js";
import { PluginInstaller, type PluginRegistry, type RegistryEntry } from "./registry.js";
import { createRegistries, type StoreSpec } from "./stores.js";
import { verifyLicenseToken } from "./security.js";
import { AppUpdater, type UpdateSource } from "./updater.js";
import { TranslationCache, createTranslator, detectLanguage, translateMarkdown, type TranslateConfig, type Translator } from "./translate.js";
import { DesktopService, registerDesktopApi, type DesktopBackend, type DesktopOptions } from "./desktop.js";

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
  /**
   * Plugin ids the host trusts as **system plugins** (cannot be disabled or uninstalled, protected permissions). A plugin must also
   * claim `"isSystem": true` in its manifest — a claim alone, e.g. from a store download, is ignored.
   */
  systemPlugins?: string[];
  /** Public keys (base64 SPKI): a manifest that claims `isSystem` and is validly signed by one of them is trusted as well. */
  systemKeys?: string[];
  /** FluxAPI: native notifications, file dialogs/read/write, clipboard, links, app info, and files opened by the OS. */
  desktop?: { backend: DesktopBackend } & DesktopOptions;
  /** Automatic translation of plugin READMEs that are not in the interface language (off unless `enabled`). */
  translate?: TranslateConfig;
  /** Application updates (progressive, from any static server or GitHub releases). */
  updates?: {
    source: UpdateSource;
    /** `<userData>/app-updates` */
    dir: string;
    currentVersion: string;
    payloadDir: string;
    /** Installed application version (for `minHost`) and the update signing public key. */
    hostVersion?: string;
    publicKey?: string;
    checkOnStart?: boolean;
    intervalHours?: number;
    autoDownload?: boolean;
    /** Relaunch the application (e.g. `app.relaunch(); app.exit(0)`). */
    restart?: () => void;
  };
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
  private licenses: Record<string, string> = {};
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
      isSystemPlugin: (m) => m.isSystem === true && ((options.systemPlugins ?? []).includes(m.id) || (!!m.signature && (options.systemKeys ?? []).includes(m.signature.publicKey))),
      policyStore: { load: async () => (await this.state.readAll()).policy, save: (policy) => this.state.update({ policy }) },
      activationGuard: (m) => this.licenseProblem(m),
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
    if (options.updates) {
      const u = options.updates;
      this.updater = new AppUpdater({ source: u.source, dir: u.dir, currentVersion: u.currentVersion, payloadDir: u.payloadDir, hostVersion: u.hostVersion, publicKey: u.publicKey, onState: (s) => this.broadcast("flux.update.state", s) });
      const up = this.updater;
      const ipc = this.manager.ipc;
      ipc.handle("flux.update.state", () => up.state, "host", {});
      ipc.handle("flux.update.check", async () => { const s = await up.check(); if (s.status === "available" && u.autoDownload) void up.download(); return s; }, "host", {});
      ipc.handle("flux.update.download", () => (void up.download(), up.state), "host", {});
      ipc.handle("flux.update.cancel", () => (up.cancel(), up.state), "host", {});
      ipc.handle("flux.update.releases", () => up.releases(), "host", {});
      ipc.handle("flux.update.restart", () => { up.apply(); u.restart?.(); return true; }, "host", {});
    }
    this.translator = createTranslator(options.translate);
    this.translations = new TranslationCache(path.join(options.dataDir, "translations.json"));
    this.registerManagementApi();
    if (options.desktop) {
      this.desktop = new DesktopService(options.desktop.backend, this.permissions, options.desktop);
      registerDesktopApi(this, this.desktop);
    }
  }
  /** Application updater (present when `updates` is configured). */
  updater?: AppUpdater;
  private updateTimers: ReturnType<typeof setTimeout>[] = [];
  private translator?: Translator;
  private translations!: TranslationCache;
  /** FluxAPI service (present when `desktop` is configured). */
  desktop?: DesktopService;

  /* --------------------------------------------------------- start / stop */

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const approved = (await this.state.readAll()).approved;
    // Plugin bundles built by `fluxplugin build` import fluxplugin / fluxplugin from the host (single instance).
    const g = globalThis as unknown as { __FLUXPLUGIN_SHARED__?: Record<string, unknown> };
    g.__FLUXPLUGIN_SHARED__ = { ...(g.__FLUXPLUGIN_SHARED__ ?? {}), "fluxplugin": core };
    this.permissions.restore(approved as Record<string, Permission[]>);
    this.licenses = (await this.state.readAll()).licenses;
    await this.manager.init();
    await this.scan();
    await this.manager.startup();
    const u = this.options.updates;
    if (this.updater && u) {
      const check = () => void this.updater!.check().then((s) => s.status === "available" && u.autoDownload && void this.updater!.download());
      if (u.checkOnStart !== false) this.updateTimers.push(setTimeout(check, 3000));
      if (u.intervalHours) this.updateTimers.push(setInterval(check, u.intervalHours * 3_600_000) as never);
    }
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
    for (const timer of this.updateTimers) clearTimeout(timer);
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
        isSystem: info.isSystem,
        state: info.state,
      };
    });
    return { frameworkVersion: this.options.frameworkVersion ?? FRAMEWORK_VERSION, plugins, preload: this.manager.preload.manifest(), revision: this.revision, policy: this.manager.getPolicy() };
  }

  /* --------------------------------------------------- renderer-facing IPC */

  private exposedChannels(kind: "invoke" | "send"): Set<string> {
    const out = new Set<string>(this.options.allowedRendererChannels ?? []);
    if (this.desktop) for (const c of Object.values(API_CHANNELS)) out.add(c);
    if (this.updater) for (const c of ["state", "check", "download", "cancel", "releases", "restart"]) out.add(`flux.update.${c}`);
    out.add("flux.app.confirmClose").add("flux.app.closeAck");
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
      if (mgmt && caller !== "host") throw new Error("plugins cannot call the management API");
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
    h(MGMT.readme, async ({ id, locale }) => {
      const text = (await this.details(id)).readme ?? "";
      const to = String(locale || "en").split("-")[0]!.toLowerCase();
      const from = (this.manager.manifest(id).language ?? detectLanguage(text))?.split("-")[0]?.toLowerCase();
      if (!text || !from || from === to) return { text, translated: false, from };
      if (!this.translator) return { text, translated: false, from, reason: "automatic translation is not enabled" };
      try {
        return { text: await translateMarkdown(text, to, from, this.translator, this.translations), translated: true, from, to, provider: this.translator.name };
      } catch (e) {
        return { text, translated: false, from, reason: errorMessage(e) };
      }
    });
    const installedMap = () => new Map(this.manager.list().map((p) => [p.id, { version: p.version, conflicts: p.conflicts }]));
    const annotate = (e: RegistryEntry): RegistryEntry => {
      const v = this.manager.has(e.id) ? this.manager.info(e.id).version : undefined;
      return { ...e, installedVersion: v, updateAvailable: !!v && isValidVersion(v) && isValidVersion(e.version) && compareVersions(e.version, v) > 0 };
    };
    const entryById = async (id: string, version?: string): Promise<RegistryEntry> => {
      const snap = await this.installer.catalog();
      const e = version ? snap.all.find((x) => x.id === id && x.version === version) : snap.entries.find((x) => x.id === id);
      if (!e) throw new Error(`"${id}" was not found in your stores`); // entries always come from the server-side catalog, never from the renderer
      return e;
    };
    h(MGMT.search, async ({ query }) => (await this.installer.search(query)).map(annotate));
    h(MGMT.catalog, async (q: CatalogQuery & { refresh?: boolean }) => {
      const snap = await this.installer.catalog({ refresh: q?.refresh });
      return { ...queryCatalog(snap.entries.map(annotate), q ?? {}), errors: snap.errors, conflicts: snap.conflicts, fetchedAt: snap.fetchedAt };
    });
    h(MGMT.updates, async () => (await this.installer.catalog()).entries.map(annotate).filter((e) => e.updateAvailable));
    h(MGMT.analyze, async ({ id }) => {
      const info = this.manager.info(id);
      return info.root ? await this.installer.analyze(await entryById(id), info.root) : undefined;
    });
    h(MGMT.plan, async ({ id }) => this.planFor(await entryById(id), installedMap()));
    h(MGMT.install, async ({ id, version }) => this.installWithPlan(await entryById(id, version), installedMap()));
    h(MGMT.update, async ({ id, version }) => this.installWithPlan(await entryById(id, version), installedMap()));
    h(MGMT.installPlan, async ({ id, version }) => this.installWithPlan(await entryById(id, version), installedMap()));
    h(MGMT.feature, async ({ id, feature, enabled }) => (await this.manager.setFeature(id, feature, !!enabled), this.manager.info(id)));
    h(MGMT.capabilities, () => this.manager.capabilities());
    h(MGMT.capability, async ({ capability, id }) => (await this.manager.setCapabilityOwner(capability, id), this.manager.capabilities()));
    h(MGMT.license, async ({ id, token }) => {
      const pricing = this.manager.has(id) ? this.manager.manifest(id).pricing : (await entryById(id)).pricing;
      if (token) {
        const v = verifyLicenseToken(pricing?.publicKey, String(token), id);
        if (!v.ok) throw new Error(v.reason);
        this.licenses = { ...this.licenses, [id]: String(token) };
      } else delete this.licenses[id];
      await this.state.update({ licenses: this.licenses });
      if (token && this.manager.has(id)) await this.manager.activate(id).catch(() => undefined);
      return this.manager.has(id) ? this.manager.info(id) : { id, licensed: !!token };
    });
    h(MGMT.uninstall, async ({ id }) => {
      this.manager.assertRemovable(id); // system plugins and plugins others depend on are refused here, in the main process
      const root = this.manager.info(id).root;
      if (root && !path.resolve(root).startsWith(path.resolve(this.installer.dir) + path.sep)) throw new Error("this plugin ships with the application and cannot be uninstalled");
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
      video: (() => {
        const v = parseVideo(m.video);
        // a video shipped inside the plugin is served through the plugin asset URL
        return v?.kind === "html5" && v.src?.startsWith("./") ? { ...v, src: url(id, v.src) } : v;
      })(),
      readme,
      assetBase: url(id, "./"),
      isSystem: this.manager.isSystem(id),
      pricing: m.pricing,
      releaseNotes: root ? await this.releaseNotes(root) : undefined,
    };
  }

  private requireConfig(id: string) {
    const c = this.manager.getConfig(id);
    if (!c) throw new Error(`plugin "${id}" has no configuration (activate it first)`);
    return c;
  }

  /** updates/<version>.md of an installed plugin, newest first. */
  private async releaseNotes(root: string): Promise<{ version: string; notes: string }[]> {
    const dir = path.join(root, "updates");
    const out: { version: string; notes: string }[] = [];
    for (const f of (await fsp.readdir(dir).catch(() => [])).slice(0, 60)) {
      const v = f.replace(/\.md$/i, "");
      if (!/\.md$/i.test(f) || !isValidVersion(v)) continue;
      const file = path.join(dir, f);
      if ((await fsp.stat(file)).size <= 100_000) out.push({ version: v, notes: await fsp.readFile(file, "utf8") });
    }
    return out.sort((a, b) => compareVersions(b.version, a.version));
  }

  private licenseProblem(m: { id: string; name: string; pricing?: RegistryEntry["pricing"] }): string | undefined {
    if (!m.pricing || m.pricing.model === "free") return undefined;
    const token = this.licenses[m.id];
    if (!token) return `"${m.name}" is a paid plugin: a license is required`;
    const v = verifyLicenseToken(m.pricing.publicKey, token, m.id);
    return v.ok ? undefined : `license problem: ${v.reason}`;
  }

  /** Dependencies, conflicts and licenses for installing `entry` — computed here, never trusted from the UI. */
  async planFor(entry: RegistryEntry, installed: Map<string, { version: string; conflicts?: string[] }>): Promise<InstallPlan> {
    const plan = await this.installer.plan(entry, installed);
    for (const s of plan.steps) {
      const p = s.entry.pricing;
      if (p && p.model !== "free" && this.licenseProblem({ id: s.entry.id, name: s.entry.name, pricing: p })) {
        plan.problems.push({ code: "license", plugin: s.entry.id, message: `"${s.entry.name}" is a paid plugin: enter a license key first${p.purchaseUrl ? ` (buy it at ${p.purchaseUrl})` : ""}` });
      }
    }
    return { ...plan, ok: plan.problems.length === 0 };
  }

  /**
   * Installs `entry` with every missing dependency as ONE transaction: files are swapped in only after everything was downloaded and
   * verified; if any file step or any activation fails, all touched plugins go back to their previous version.
   */
  async installWithPlan(entry: RegistryEntry, installed: Map<string, { version: string; conflicts?: string[] }>) {
    const plan = await this.planFor(entry, installed);
    if (!plan.ok) throw new Error(`cannot install "${entry.name}": ${plan.problems.map((p) => p.message).join("; ")}`);
    const steps = plan.steps;
    const before = steps.map((s) => ({ id: s.entry.id, was: this.manager.has(s.entry.id) ? this.manager.info(s.entry.id) : undefined }));
    for (const b of before) if (b.was?.isSystem && b.was.root && !path.resolve(b.was.root).startsWith(path.resolve(this.installer.dir) + path.sep)) throw new Error(`"${b.id}" is a system plugin shipped with the application and is updated with it`);
    for (const b of before) if (this.manager.has(b.id)) await this.manager.unregister(b.id);
    let results;
    try {
      results = await this.installer.installMany(steps.map((s) => s.entry));
    } catch (e) {
      await this.scan(); // files were restored by the installer: bring the previous versions back
      for (const b of before) if (b.was?.state === "ready") await this.manager.activate(b.id).catch(() => undefined);
      throw e;
    }
    await this.scan();
    try {
      for (const s of steps) {
        const was = before.find((b) => b.id === s.entry.id)?.was;
        if (this.manager.has(s.entry.id) && (!was || was.state === "ready")) await this.manager.activate(s.entry.id);
      }
    } catch (e) {
      for (const r of [...results].reverse()) {
        await this.manager.unregister(r.id).catch(() => undefined);
        if (r.previousVersion) await this.installer.rollback(r.id, r.previousVersion).catch(() => undefined);
        else await this.installer.uninstall(r.id).catch(() => undefined);
      }
      await this.scan();
      for (const b of before) if (b.was?.state === "ready") await this.manager.activate(b.id).catch(() => undefined);
      throw new Error(`installation was rolled back: ${(e as Error).message}`);
    }
    return results[results.length - 1]!;
  }

  /** Channels used by transports. */
  static readonly channels = CHANNELS;
}
