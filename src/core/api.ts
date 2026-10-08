import type { PluginApis } from "./ipc.js";

/**
 * Typed access to `window.plugins.<namespace>` in renderer code. Augment `PluginApis` to describe the API:
 *
 * ```ts
 * declare module "fluxplugin" { interface PluginApis { analytics: { getStats(): Promise<Stats> } } }
 * const stats = await pluginApi("analytics").getStats();
 * ```
 */
export function pluginApi<K extends keyof PluginApis & string>(namespace: K): PluginApis[K] {
  const root = (globalThis as unknown as { plugins?: Record<string, unknown> }).plugins;
  const api = root?.[namespace];
  if (!api) throw new Error(`window.plugins.${namespace} is not available (plugin disabled, permission missing, or not exposed)`);
  return api as PluginApis[K];
}

export function hasPluginApi(namespace: string): boolean {
  return !!(globalThis as unknown as { plugins?: Record<string, unknown> }).plugins?.[namespace];
}
