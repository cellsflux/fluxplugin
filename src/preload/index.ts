import { CHANNELS, type Bootstrap, type FluxBridge, type EventMessage, type InvokeRequest, type InvokeResponse, type IpcErrorPayload } from "../core/index.js";

/** Structural types for Electron's `contextBridge` / `ipcRenderer` — no `electron` import, works in sandboxed preloads. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: any[]) => void): unknown;
  removeListener(channel: string, listener: (...args: any[]) => void): unknown;
}
export interface ContextBridgeLike {
  exposeInMainWorld(key: string, api: unknown): void;
}

export class IpcCallError extends Error {
  constructor(public readonly payload: IpcErrorPayload) {
    super(payload.message);
    this.name = "IpcCallError";
  }
  get code(): string {
    return this.payload.code;
  }
}

/**
 * Creates the bridge object. It is deliberately tiny and generic: it knows nothing about plugins.
 * Per-plugin APIs (`window.plugins.analytics.getStats()`) are generated *in the renderer* from the preload
 * manifest (see `fluxplugin/react` → `installWindowPlugins`), so plugins can be enabled/disabled at runtime —
 * `contextBridge` can only expose objects once, at preload time.
 *
 * Nothing from Node, `ipcRenderer` itself, or `event` objects ever reaches the page: only the five functions below.
 */
export function createBridge(ipcRenderer: IpcRendererLike): FluxBridge {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  ipcRenderer.on(CHANNELS.event, (_e, msg: EventMessage) => {
    if (!msg || typeof msg.channel !== "string") return;
    for (const l of [...(listeners.get(msg.channel) ?? [])]) {
      try {
        l(msg.payload);
      } catch {
        /* isolate listener failures */
      }
    }
  });
  return {
    async invoke(channel, input, caller) {
      const req: InvokeRequest = { channel: String(channel), input, caller };
      const res = (await ipcRenderer.invoke(CHANNELS.invoke, req)) as InvokeResponse;
      if (!res.ok) throw new IpcCallError(res.error);
      return res.value;
    },
    send(channel, payload, caller) {
      ipcRenderer.send(CHANNELS.send, { channel: String(channel), payload, caller });
    },
    on(channel, listener) {
      let set = listeners.get(channel);
      if (!set) listeners.set(channel, (set = new Set()));
      set.add(listener);
      return () => void set!.delete(listener);
    },
    bootstrap: () => ipcRenderer.invoke(CHANNELS.bootstrap) as Promise<Bootstrap>,
  };
}

/** Call from your preload script: `exposeFluxBridge(contextBridge, ipcRenderer)`. */
export function exposeFluxBridge(contextBridge: ContextBridgeLike, ipcRenderer: IpcRendererLike, key = "__fluxplugin"): FluxBridge {
  const bridge = createBridge(ipcRenderer);
  contextBridge.exposeInMainWorld(key, bridge);
  return bridge;
}
