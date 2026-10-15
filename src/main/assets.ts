import { promises as fs } from "node:fs";

export const MIME: Record<string, string> = {
  ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".map": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".avif": "image/avif", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg", ".ogg": "video/ogg", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav",
};

export interface AssetResponse {
  status: 200 | 206 | 416;
  headers: Record<string, string>;
  body: Buffer;
}

/** Serves a file, honouring `Range` so <video> can seek. Reads only the requested slice. */
export async function readAsset(file: string, mime: string, range?: string | null): Promise<AssetResponse> {
  const { size } = await fs.stat(file);
  const base = { "content-type": mime, "accept-ranges": "bytes", "access-control-allow-origin": "*", "cache-control": "no-store" };
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (!m || (m[1] === "" && m[2] === "")) return { status: 200, headers: { ...base, "content-length": String(size) }, body: await fs.readFile(file) };
  let start = m[1] === "" ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  let end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start > end || start >= size) return { status: 416, headers: { ...base, "content-range": `bytes */${size}` }, body: Buffer.alloc(0) };
  const fh = await fs.open(file, "r");
  try {
    const len = end - start + 1;
    const body = Buffer.alloc(len);
    await fh.read(body, 0, len, start);
    return { status: 206, headers: { ...base, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(len) }, body };
  } finally {
    await fh.close();
  }
}
