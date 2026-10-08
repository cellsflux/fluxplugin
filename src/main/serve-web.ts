import path from "node:path";
import { promises as fs } from "node:fs";
import type { MainFramework } from "./framework.js";
import { attachHttp } from "./adapters.js";

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".map": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

/**
 * Runs the app in a plain browser: serves the built renderer (`distDir`) plus the framework wire protocol over HTTP/SSE.
 * Intended for development, headless E2E tests and demos; binds to loopback by default.
 */
export function serveWeb(fw: MainFramework, opts: { distDir: string; port?: number; host?: string }) {
  const dist = path.resolve(opts.distDir);
  return attachHttp(fw, {
    port: opts.port ?? 5173,
    host: opts.host,
    fallback: async (req, res) => {
      const rel = !req.url || req.url === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]!).replace(/^\/+/, "");
      const file = path.resolve(dist, rel);
      const type = TYPES[path.extname(file)];
      if (!type || !file.startsWith(dist + path.sep)) return false;
      try {
        res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
        res.end(await fs.readFile(file));
        return true;
      } catch {
        return false;
      }
    },
  });
}
