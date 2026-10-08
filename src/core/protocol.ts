import type { PluginInfo } from "./plugin.js";
import type { PluginManifest, Permission } from "./manifest.js";
import type { IpcErrorPayload, PreloadApiSpec } from "./ipc.js";

/** Electron IPC channel names used by the framework (all prefixed to avoid clashing with host channels). */
export const CHANNELS = {
  invoke: "flux:invoke",
  send: "flux:send",
  event: "flux:event",
  bootstrap: "flux:bootstrap",
} as const;

export interface RendererPluginDescriptor {
  id: string;
  manifest: PluginManifest;
  enabled: boolean;
  /** URL the renderer imports for this plugin's renderer entry (undefined when it has none). */
  rendererUrl?: string;
  /** URLs of CSS files declared in the manifest `styles`. */
  styleUrls: string[];
  granted: Permission[];
  state: PluginInfo["state"];
}

export interface Bootstrap {
  frameworkVersion: string;
  plugins: RendererPluginDescriptor[];
  preload: Record<string, PreloadApiSpec>;
  /** Monotonic counter bumped whenever the plugin set / state changes. */
  revision: number;
}

export interface InvokeRequest {
  channel: string;
  input?: unknown;
  /** Plugin on whose behalf the renderer calls (used for permission checks). */
  caller?: string;
}
export type InvokeResponse = { ok: true; value: unknown } | { ok: false; error: IpcErrorPayload };

export interface EventMessage {
  channel: string;
  payload: unknown;
}

/** The only surface the preload exposes to renderer code (`window.__fluxplugin`). Everything is plain data + functions. */
export interface FluxBridge {
  invoke(channel: string, input?: unknown, caller?: string): Promise<unknown>;
  send(channel: string, payload?: unknown, caller?: string): void;
  on(channel: string, listener: (payload: unknown) => void): () => void;
  bootstrap(): Promise<Bootstrap>;
}

/** Management channels served by the main framework to the host UI (`flux.plugins.*`). */
export const MGMT = {
  list: "flux.plugins.list",
  enable: "flux.plugins.enable",
  disable: "flux.plugins.disable",
  reload: "flux.plugins.reload",
  grant: "flux.plugins.grant",
  revoke: "flux.plugins.revoke",
  uninstall: "flux.plugins.uninstall",
  install: "flux.plugins.install",
  update: "flux.plugins.update",
  rollback: "flux.plugins.rollback",
  search: "flux.plugins.search",
  updates: "flux.plugins.updates",
  configGet: "flux.plugins.config.get",
  configSet: "flux.plugins.config.set",
  configReset: "flux.plugins.config.reset",
  configSchema: "flux.plugins.config.schema",
  logs: "flux.plugins.logs",
  diagnostics: "flux.plugins.diagnostics",
  details: "flux.plugins.details",
  changed: "flux.plugins.changed",
} as const;

/** Serializable description of a plugin offered by a registry (marketplace entry). */
export interface RegistryEntryLike {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  permissions: string[];
  location: string;
  source: string;
  sha256?: string;
  homepage?: string;
  stars?: number;
  icon?: string;
}

/** Everything a UI needs to render a plugin "store page": icon, banner, screenshots, video, long description. */
export interface PluginDetails {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  homepage?: string;
  repository?: string;
  categories: string[];
  keywords: string[];
  links: Record<string, string>;
  iconUrl?: string;
  bannerUrl?: string;
  screenshotUrls: string[];
  video?: { url: string; embedUrl?: string };
  /** Markdown source of the long description (rendered by the UI without raw HTML). */
  readme?: string;
}
