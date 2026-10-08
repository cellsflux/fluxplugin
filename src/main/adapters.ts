import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { CHANNELS, type InvokeRequest } from "../core/index.js";
import type { MainFramework } from "./framework.js";

/* ------------------------------------------------------------- Electron */

/** Minimal structural types so this package never imports `electron` (works with any Electron version). */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: { sender: { id: number } }, ...args: any[]) => unknown,
  ): void;
  on(
    channel: string,
    listener: (event: { sender: { id: number } }, ...args: any[]) => void,
  ): void;
  removeHandler(channel: string): void;
  removeListener(channel: string, listener: (...args: any[]) => void): void;
}
export interface WebContentsLike {
  id: number;
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
}
export interface ElectronLike {
  ipcMain: IpcMainLike;
  webContents: { getAllWebContents(): WebContentsLike[] };
}

/**
 * Connects the framework to Electron's ipcMain. Call after `app.whenReady()`.
 * Returns a detach function.
 */
export function attachElectron(
  fw: MainFramework,
  electron: ElectronLike,
): () => void {
  const { ipcMain, webContents } = electron;
  ipcMain.handle(CHANNELS.invoke, (e, req: InvokeRequest) =>
    fw.handleInvoke(req, e.sender.id),
  );
  ipcMain.handle(CHANNELS.bootstrap, () => fw.bootstrap());
  const onSend = (
    e: { sender: { id: number } },
    msg: { channel: string; payload?: unknown; caller?: string },
  ) => fw.handleSend(msg?.channel, msg?.payload, msg?.caller, e.sender.id);
  ipcMain.on(CHANNELS.send, onSend);
  const off = fw.onBroadcast((channel, payload, target) => {
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue;
      if (target !== undefined && wc.id !== target) continue;
      wc.send(CHANNELS.event, { channel, payload });
    }
  });
  return () => {
    ipcMain.removeHandler(CHANNELS.invoke);
    ipcMain.removeHandler(CHANNELS.bootstrap);
    ipcMain.removeListener(CHANNELS.send, onSend as never);
    off();
  };
}

/** Privileged scheme definition. Must be passed to `protocol.registerSchemesAsPrivileged` *before* `app.ready`. */
export const PLUGIN_SCHEME = {
  scheme: "fluxplugin",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
} as const;

const MIME: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/**
 * Resolves `fluxplugin://<id>/<path>` to a file inside the plugin's directory. Rejects traversal and anything that
 * is not an asset (the manifest and main entry are never served).
 */
export async function resolvePluginAsset(
  fw: MainFramework,
  url: string,
): Promise<{ file: string; mime: string } | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const id = decodeURIComponent(u.hostname);
  if (!fw.manager.has(id)) return null;
  const root = fw.manager.info(id).root;
  if (!root) return null;
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, "");
  const file = path.resolve(root, rel);
  if (!file.startsWith(path.resolve(root) + path.sep)) return null;
  const m = fw.manager.manifest(id);
  const main = m.main ? path.resolve(root, m.main) : undefined;
  if (file === main || path.basename(file) === "plugin.json") return null;
  const ext = path.extname(file).toLowerCase();
  if (!(ext in MIME)) return null;
  try {
    await fs.access(file);
  } catch {
    return null;
  }
  return { file, mime: MIME[ext]! };
}

/** Registers the `fluxplugin://` handler on an Electron `protocol` object (`protocol.handle`, Electron >= 25). */
export function registerPluginProtocol(
  fw: MainFramework,
  protocol: {
    handle(
      scheme: string,
      handler: (req: { url: string }) => Promise<Response> | Response,
    ): void;
  },
): void {
  protocol.handle(PLUGIN_SCHEME.scheme, async (req) => {
    const r = await resolvePluginAsset(fw, req.url);
    if (!r) return new Response("Not found", { status: 404 });
    return new Response(await fs.readFile(r.file), {
      headers: { "content-type": r.mime, "access-control-allow-origin": "*" },
    });
  });
}

/* ----------------------------------------------------------------- HTTP */

export interface HttpAdapterOptions {
  port?: number;
  host?: string;
  /** URL prefix under which plugin assets are served. Default `/@plugins`. */
  assetPrefix?: string;
  /** Extra request handler (e.g. serve the Vite build). Return true when handled. */
  fallback?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => boolean | Promise<boolean>;
}

/**
 * Serves the same wire protocol over HTTP (POST /flux/invoke, POST /flux/send, GET /flux/bootstrap, SSE /flux/events,
 * GET /@plugins/<id>/<file>). Used for browser-based development, headless E2E tests and screenshots.
 * Bind to loopback only: there is no authentication, exactly like the Electron-only bridge it replaces.
 */
export function attachHttp(
  fw: MainFramework,
  opts: HttpAdapterOptions = {},
): Promise<{ server: http.Server; port: number; close(): Promise<void> }> {
  const prefix = opts.assetPrefix ?? "/@plugins";
  const clients = new Set<http.ServerResponse>();
  const off = fw.onBroadcast((channel, payload) => {
    const data = `data: ${JSON.stringify({ channel, payload })}\n\n`;
    for (const c of clients) c.write(data);
  });
  const readJson = (req: http.IncomingMessage): Promise<any> =>
    new Promise((resolve, reject) => {
      let s = "";
      req.on("data", (d) => {
        s += d;
        if (s.length > 5_000_000) reject(new Error("body too large"));
      });
      req.on("end", () => {
        try {
          resolve(s ? JSON.parse(s) : {});
        } catch (e) {
          reject(e);
        }
      });
    });
  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/flux/bootstrap")
        return json(res, 200, fw.bootstrap());
      if (url.pathname === "/flux/invoke" && req.method === "POST")
        return json(
          res,
          200,
          await fw.handleInvoke(await readJson(req), "http"),
        );
      if (url.pathname === "/flux/send" && req.method === "POST") {
        const m = await readJson(req);
        fw.handleSend(m.channel, m.payload, m.caller, "http");
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/flux/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(": connected\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (url.pathname.startsWith(prefix + "/")) {
        const rest = url.pathname.slice(prefix.length + 1);
        const slash = rest.indexOf("/");
        const id = decodeURIComponent(rest.slice(0, slash));
        const r = await resolvePluginAsset(
          fw,
          `fluxplugin://${encodeURIComponent(id)}/${rest.slice(slash + 1)}`,
        );
        if (!r) return json(res, 404, { error: "not found" });
        res.writeHead(200, {
          "content-type": r.mime,
          "cache-control": "no-store",
        });
        return res.end(await fs.readFile(r.file));
      }
      if (opts.fallback && (await opts.fallback(req, res))) return;
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((r) => {
            off();
            for (const c of clients) c.end();
            server.close(() => r());
          }),
      });
    });
  });
}

/* ------------------------------------------------------------- loopback */

/**
 * In-process bridge connecting a renderer runtime directly to a `MainFramework` (no IPC, no serialization
 * except a JSON round trip to mimic structured cloning). Used by integration tests and storybook-like setups.
 */
export function createLoopbackBridge(
  fw: MainFramework,
): import("../core/index.js").FluxBridge {
  const clone = <T>(v: T): T =>
    v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  fw.onBroadcast((channel, payload) => {
    for (const l of [...(listeners.get(channel) ?? [])]) l(clone(payload));
  });
  return {
    async invoke(channel, input, caller) {
      const res = await fw.handleInvoke(
        { channel, input: clone(input), caller },
        "loopback",
      );
      if (!res.ok)
        throw Object.assign(new Error(res.error.message), {
          code: res.error.code,
          payload: res.error,
        });
      return clone(res.value);
    },
    send: (channel, payload, caller) =>
      fw.handleSend(channel, clone(payload), caller, "loopback"),
    on(channel, l) {
      let set = listeners.get(channel);
      if (!set) listeners.set(channel, (set = new Set()));
      set.add(l);
      return () => void set!.delete(l);
    },
    async bootstrap() {
      return clone(fw.bootstrap());
    },
  };
}
