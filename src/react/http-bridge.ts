import type { Bootstrap, FluxBridge, InvokeResponse } from "../core/index.js";

export class HttpBridgeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "HttpBridgeError";
  }
}

/**
 * Bridge over HTTP + Server-Sent Events, for running the renderer in a plain browser against `attachHttp()`
 * (development, headless E2E tests, screenshots). In Electron the preload bridge is used instead.
 */
export function createHttpBridge(baseUrl = ""): FluxBridge {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  let source: EventSource | undefined;
  const ensureSource = (): void => {
    if (source || typeof EventSource === "undefined") return;
    source = new EventSource(`${baseUrl}/flux/events`);
    source.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { channel: string; payload: unknown };
        for (const l of [...(listeners.get(msg.channel) ?? [])]) l(msg.payload);
      } catch {
        /* ignore malformed messages */
      }
    };
  };
  const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    async invoke(channel, input, caller) {
      const res = (await (await post("/flux/invoke", { channel, input, caller })).json()) as InvokeResponse;
      if (!res.ok) throw new HttpBridgeError(res.error.message, res.error.code);
      return res.value;
    },
    send(channel, payload, caller) {
      void post("/flux/send", { channel, payload, caller });
    },
    on(channel, listener) {
      ensureSource();
      let set = listeners.get(channel);
      if (!set) listeners.set(channel, (set = new Set()));
      set.add(listener);
      return () => void set!.delete(listener);
    },
    async bootstrap() {
      return (await (await fetch(`${baseUrl}/flux/bootstrap`)).json()) as Bootstrap;
    },
  };
}
