import { promises as fs } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const BLOCK = 512;

function header(name: string, size: number, mode: number, type: "0" | "5"): Buffer {
  const h = Buffer.alloc(BLOCK);
  if (Buffer.byteLength(name) > 100) throw new Error(`path too long for tar: ${name}`);
  h.write(name, 0, "utf8");
  h.write(mode.toString(8).padStart(7, "0") + "\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148); // checksum placeholder
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

async function walk(dir: string, base = ""): Promise<{ rel: string; abs: string; dir: boolean }[]> {
  const out: { rel: string; abs: string; dir: boolean }[] = [];
  for (const e of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const abs = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push({ rel, abs, dir: true });
      out.push(...(await walk(abs, rel)));
    } else if (e.isFile()) out.push({ rel, abs, dir: false });
  }
  return out;
}

/** Creates a .tgz (ustar) of a directory. Entries are placed under `package/` like npm does. */
export async function createTarGz(dir: string, prefix = "package"): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (const f of await walk(dir)) {
    const name = `${prefix}/${f.rel}${f.dir ? "/" : ""}`;
    if (f.dir) chunks.push(header(name, 0, 0o755, "5"));
    else {
      const data = await fs.readFile(f.abs);
      chunks.push(header(name, data.length, 0o644, "0"), data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return gzip(Buffer.concat(chunks));
}

export interface TarEntry {
  name: string;
  type: "file" | "dir";
  data: Buffer;
}

export async function readTarGz(buf: Buffer): Promise<TarEntry[]> {
  const tar = await gunzip(buf);
  const entries: TarEntry[] = [];
  let off = 0;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const name = h.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const size = parseInt(h.toString("utf8", 124, 135).replace(/\0.*$/, "").trim() || "0", 8);
    const type = String.fromCharCode(h[156] ?? 48);
    off += BLOCK;
    if (type === "0" || type === "\0") entries.push({ name, type: "file", data: Buffer.from(tar.subarray(off, off + size)) });
    else if (type === "5") entries.push({ name, type: "dir", data: Buffer.alloc(0) });
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

/** Extracts into `dest`, stripping the first path component. Rejects traversal and absolute paths. */
export async function extractTarGz(buf: Buffer, dest: string): Promise<void> {
  const root = path.resolve(dest);
  await fs.mkdir(root, { recursive: true });
  for (const e of await readTarGz(buf)) {
    const parts = e.name.split("/").filter(Boolean);
    parts.shift();
    if (!parts.length) continue;
    if (parts.some((p) => p === ".." || p.includes("\0")) || path.isAbsolute(e.name)) throw new Error(`unsafe path in archive: ${e.name}`);
    const target = path.resolve(root, ...parts);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`unsafe path in archive: ${e.name}`);
    if (e.type === "dir") await fs.mkdir(target, { recursive: true });
    else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, e.data);
    }
  }
}
