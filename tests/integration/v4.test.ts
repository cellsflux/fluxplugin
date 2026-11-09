import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { API_CHANNELS, FILE_OPEN_EVENT, nextVersion, planAppUpdate, resolveFileHandlers, stableStringify, type FileHandlerDef, type UpdateManifest } from "fluxplugin";
import {
  AppUpdater, DesktopService, MainFramework, TranslationCache, confirmBoot, createTranslator, detectLanguage, filesFromArgv, generateSigningKeyPair,
  payloadVersion, resolveBootTarget, signUpdateManifest, translateMarkdown, verifyUpdateManifest, type DesktopBackend,
} from "fluxplugin/main";

let tmp: string;
/** An absolute path of the CURRENT OS under the temp folder. Never hard-code "/x" or "C:\\x": Windows turns "/x" into "C:\\x". */
const P = (...parts: string[]) => path.join(tmp, ...parts);
beforeEach(async () => void (tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-v4-"))));
afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(tmp, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ FluxAPI */

/** A Map keyed by resolved path: "a/../b" and "b" are the same file, on every OS. */
class PathMap extends Map<string, Buffer> {
  override get = (k: string) => super.get(path.resolve(k));
  override set = (k: string, v: Buffer) => super.set(path.resolve(k), v);
  override has = (k: string) => super.has(path.resolve(k));
}

function fakeBackend() {
  const files = new PathMap();
  const log: string[] = [];
  const be: DesktopBackend & { files: Map<string, Buffer>; log: string[]; openPick: string[]; savePick?: string; clip: string } = {
    files, log, openPick: [], clip: "",
    notify: (n) => void log.push("notify:" + n.title),
    showOpenDialog: async () => be.openPick,
    showSaveDialog: async () => be.savePick,
    readFile: async (p) => files.get(p) ?? Promise.reject(new Error("ENOENT")),
    writeFile: async (p, d) => void files.set(p, d),
    stat: async (p) => (files.has(p) ? { size: files.get(p)!.length, isFile: true } : Promise.reject(new Error("ENOENT"))),
    reveal: (p) => void log.push("reveal:" + p),
    readClipboard: () => be.clip,
    writeClipboard: (t) => void (be.clip = t),
    openExternal: async (u) => void log.push("open:" + u),
    appInfo: () => ({ name: "App", version: "1.0.0", platform: "test", locale: "en" }),
    registerShortcut: (a) => (log.push("sc:" + a), true),
    unregisterShortcut: (a) => void log.push("unsc:" + a),
    print: async (silent) => void log.push("print:" + silent),
    printToPDF: async () => Buffer.from("%PDF-fake"),
    setTray: (cfg) => void log.push("tray:" + (cfg ? cfg.items.map((i) => i.id).join(",") : "off")),
  };
  return be;
}

async function framework(be: DesktopBackend, plugins: Record<string, string[]> = {}, opts: Record<string, unknown> = {}) {
  const pdir = path.join(tmp, "plugins");
  for (const [id, perms] of Object.entries(plugins)) {
    const d = path.join(pdir, id);
    await fs.mkdir(path.join(d, "dist"), { recursive: true });
    await fs.writeFile(path.join(d, "plugin.json"), JSON.stringify({ id, name: id, version: "1.0.0", main: "./dist/main.mjs", permissions: ["ipc", ...perms] }));
    await fs.writeFile(path.join(d, "dist/main.mjs"), "export default {}");
  }
  await fs.mkdir(pdir, { recursive: true });
  const fw = new MainFramework({ pluginDirs: [pdir], dataDir: path.join(tmp, "data"), desktop: { backend: be }, ...opts });
  await fw.start();
  return fw;
}
const call = (fw: MainFramework, channel: string, input?: unknown, caller?: string) => fw.handleInvoke({ channel, input, caller });

describe("FluxAPI · files are capabilities, not paths", () => {
  it("a file picked in the native dialog is readable by that plugin only; other plugins and raw paths are refused", async () => {
    const be = fakeBackend();
    be.files.set(P("docs", "a.md"), Buffer.from("# hello"));
    be.openPick = [P("docs", "a.md")];
    const fw = await framework(be, { "a.p": ["filesystem.read"], "b.p": ["filesystem.read"], "c.p": [] });
    const open = (await call(fw, API_CHANNELS.open, {}, "a.p")) as { ok: true; value: { id: string; name: string; ext: string; mime: string; size: number }[] };
    const ref = open.value[0]!;
    expect(ref).toMatchObject({ name: "a.md", ext: "md", mime: "text/markdown", size: 7 });
    expect(await call(fw, API_CHANNELS.read, { ref }, "a.p")).toMatchObject({ ok: true, value: "# hello" });
    expect(await call(fw, API_CHANNELS.read, { ref, as: "base64" }, "a.p")).toMatchObject({ value: Buffer.from("# hello").toString("base64") });
    expect(await call(fw, API_CHANNELS.read, { ref }, "b.p")).toMatchObject({ ok: false, error: { message: expect.stringMatching(/not shared with this plugin/) } }); // same permission, not its file
    expect(await call(fw, API_CHANNELS.read, { ref: P("docs", "a.md") }, "a.p")).toMatchObject({ ok: false, error: { message: expect.stringMatching(/file dialogs/) } }); // no raw paths
    expect(await call(fw, API_CHANNELS.open, {}, "c.p")).toMatchObject({ ok: false, error: { code: "FLUX_PERMISSION_DENIED" } });
    expect(await call(fw, API_CHANNELS.read, { ref: P("docs", "a.md") }, undefined)).toMatchObject({ ok: true, value: "# hello" }); // the host may use paths
    await fw.stop();
  });

  it("save dialogs give write access; a read-only ref cannot be written; size caps and allowed roots apply", async () => {
    const be = fakeBackend();
    be.files.set(P("in.txt"), Buffer.from("x"));
    be.openPick = [P("in.txt")];
    be.savePick = P("out", "copy.txt");
    const fw = await framework(be, { "w.p": ["filesystem.read", "filesystem.write"] }, { desktop: { backend: be, maxBytes: 10, allowedRoots: [P("sandbox")] } });
    const [inRef] = ((await call(fw, API_CHANNELS.open, {}, "w.p")) as { value: { id: string }[] }).value;
    expect(await call(fw, API_CHANNELS.write, { ref: inRef, data: "no" }, "w.p")).toMatchObject({ ok: false, error: { message: expect.stringMatching(/does not allow write/) } });
    const out = ((await call(fw, API_CHANNELS.save, { defaultName: "copy.txt" }, "w.p")) as { value: { id: string; name: string } }).value;
    expect(out.name).toBe("copy.txt");
    expect(await call(fw, API_CHANNELS.write, { ref: out, data: "saved" }, "w.p")).toMatchObject({ ok: true });
    expect(be.files.get(P("out", "copy.txt"))!.toString()).toBe("saved");
    expect(await call(fw, API_CHANNELS.write, { ref: out, data: "this is longer than ten bytes" }, "w.p")).toMatchObject({ ok: false, error: { message: expect.stringMatching(/too large/) } });
    expect(await call(fw, API_CHANNELS.write, { ref: out, data: Buffer.from("bin").toString("base64"), as: "base64" }, "w.p")).toMatchObject({ ok: true });
    expect(be.files.get(P("out", "copy.txt"))!.toString()).toBe("bin");
    expect(await call(fw, API_CHANNELS.write, { ref: P("sandbox", "x.txt"), data: "ok" }, "w.p")).toMatchObject({ ok: true }); // allowed root
    expect(await call(fw, API_CHANNELS.write, { ref: P("sandbox", "..", "etc", "passwd"), data: "no" }, "w.p")).toMatchObject({ ok: false }); // traversal out of the root
    be.savePick = undefined;
    expect(((await call(fw, API_CHANNELS.save, {}, "w.p")) as { value: unknown }).value).toBeNull(); // cancelled dialog
    await fw.stop();
  });

  it("notifications, clipboard, links and app info check permissions; only http(s)/mailto links open", async () => {
    const be = fakeBackend();
    const fw = await framework(be, { "n.p": ["notifications", "clipboard", "shell"], "z.p": [] });
    expect(await call(fw, API_CHANNELS.notify, { title: "Done" }, "n.p")).toMatchObject({ ok: true });
    expect(be.log).toContain("notify:Done");
    expect(await call(fw, API_CHANNELS.notify, { title: "Spam" }, "z.p")).toMatchObject({ ok: false, error: { code: "FLUX_PERMISSION_DENIED" } });
    expect(await call(fw, API_CHANNELS.clipWrite, { text: "copied" }, "n.p")).toMatchObject({ ok: true });
    expect(await call(fw, API_CHANNELS.clipRead, undefined, "n.p")).toMatchObject({ ok: true, value: "copied" });
    expect(await call(fw, API_CHANNELS.clipRead, undefined, "z.p")).toMatchObject({ ok: false });
    for (const url of ["https://example.com", "http://example.com", "mailto:a@b.c"]) expect(await call(fw, API_CHANNELS.openExternal, { url }, "n.p")).toMatchObject({ ok: true });
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "ftp://x"]) expect(await call(fw, API_CHANNELS.openExternal, { url }, "n.p")).toMatchObject({ ok: false, error: { message: expect.stringMatching(/only http/) } });
    expect(await call(fw, API_CHANNELS.appInfo, undefined, "z.p")).toMatchObject({ ok: true, value: { name: "App", version: "1.0.0" } });
    await fw.stop();
  });

  it("main-process plugins reach FluxAPI through ctx.host.api with their own permissions", async () => {
    const be = fakeBackend();
    const fw = await framework(be, { "m.p": ["notifications"], "q.p": [] });
    const api = fw.manager.contextOf("m.p")!.host.api<import("fluxplugin").DesktopApi>("flux.desktop");
    await api.notify({ title: "from main plugin" });
    expect(be.log).toContain("notify:from main plugin");
    await expect(fw.manager.contextOf("q.p")!.host.api<import("fluxplugin").DesktopApi>("flux.desktop").notify({ title: "x" })).rejects.toThrow(/permission/i);
    await fw.stop();
  });

  it("files the OS opens are announced, queued for the UI, and only readable by a plugin after the host hands them over", async () => {
    const be = fakeBackend();
    be.files.set(P("Users", "me", "notes.md"), Buffer.from("note"));
    const fw = await framework(be, { "ed.p": ["filesystem.read"] });
    const bcast = vi.spyOn(fw, "broadcast");
    const ref = (await fw.desktop!.receive(P("Users", "me", "notes.md"), fw, "os"))!;
    expect(bcast).toHaveBeenCalledWith(FILE_OPEN_EVENT, { ref, source: "os" });
    expect(await fw.desktop!.receive(P("nope.md"), fw)).toBeUndefined(); // not a file
    expect(await call(fw, API_CHANNELS.read, { ref }, "ed.p")).toMatchObject({ ok: false }); // not handed over yet
    expect(await call(fw, API_CHANNELS.handOver, { id: ref.id, pluginId: "ed.p" }, "ed.p")).toMatchObject({ ok: false }); // a plugin cannot hand files to itself
    expect(await call(fw, API_CHANNELS.handOver, { id: ref.id, pluginId: "ed.p" })).toMatchObject({ ok: true });
    expect(await call(fw, API_CHANNELS.read, { ref }, "ed.p")).toMatchObject({ ok: true, value: "note" });
    expect(await call(fw, API_CHANNELS.pending, undefined, "ed.p")).toMatchObject({ value: [] }); // plugins never see the queue
    const pending = (await call(fw, API_CHANNELS.pending)) as { value: unknown[] };
    expect(pending.value).toHaveLength(1);
    expect(((await call(fw, API_CHANNELS.pending)) as { value: unknown[] }).value).toHaveLength(0); // taken once
    await fw.stop();
  });

  it("global shortcuts belong to one plugin, need the permission, reject odd accelerators; print/PDF/tray need 'window'", async () => {
    const be = fakeBackend();
    const fw = await framework(be, { "s1.p": ["shortcuts", "window"], "s2.p": ["shortcuts"], "s3.p": [] });
    const reg = (a: string, who: string) => call(fw, API_CHANNELS.shortcutRegister, { accelerator: a }, who);
    expect(await reg("CommandOrControl+K", "s1.p")).toMatchObject({ ok: true, value: true });
    expect(await reg("CommandOrControl+K", "s2.p")).toMatchObject({ ok: true, value: false }); // already owned
    await call(fw, API_CHANNELS.shortcutUnregister, { accelerator: "CommandOrControl+K" }, "s2.p"); // not the owner: no effect
    expect(be.log).not.toContain("unsc:CommandOrControl+K");
    await call(fw, API_CHANNELS.shortcutUnregister, { accelerator: "CommandOrControl+K" }, "s1.p");
    expect(be.log).toContain("unsc:CommandOrControl+K");
    expect(await reg("CommandOrControl+K", "s2.p")).toMatchObject({ value: true }); // free again
    expect(await reg("Alt+X", "s3.p")).toMatchObject({ ok: false, error: { code: "FLUX_PERMISSION_DENIED" } });
    expect(await reg("not an accelerator!!", "s1.p")).toMatchObject({ ok: false });
    expect(await call(fw, API_CHANNELS.print, { silent: true }, "s1.p")).toMatchObject({ ok: true });
    expect(be.log).toContain("print:true");
    expect(await call(fw, API_CHANNELS.printPdf, undefined, "s1.p")).toMatchObject({ ok: true, value: Buffer.from("%PDF-fake").toString("base64") });
    expect(await call(fw, API_CHANNELS.print, {}, "s2.p")).toMatchObject({ ok: false, error: { code: "FLUX_PERMISSION_DENIED" } });
    expect(await call(fw, API_CHANNELS.trayset, { tooltip: "t", items: [{ id: "open", label: "Open" }] }, "s1.p")).toMatchObject({ ok: true });
    expect(be.log).toContain("tray:open");
    const bare = await framework({ ...fakeBackend(), print: undefined, setTray: undefined, registerShortcut: undefined } as DesktopBackend, { "x.p": ["window", "shortcuts"] }, { dataDir: path.join(tmp, "d2") });
    expect(await call(bare, API_CHANNELS.print, {}, "x.p")).toMatchObject({ ok: false, error: { message: expect.stringMatching(/not available/) } });
    expect(await call(bare, API_CHANNELS.shortcutRegister, { accelerator: "Alt+X" }, "x.p")).toMatchObject({ ok: false, error: { message: expect.stringMatching(/not available/) } });
    await fw.stop();
    await bare.stop();
  });

  it("FluxAPI channels are exposed to the renderer only when `desktop` is configured", async () => {
    const withApi = await framework(fakeBackend());
    expect(await call(withApi, API_CHANNELS.appInfo)).toMatchObject({ ok: true });
    await withApi.stop();
    const without = new MainFramework({ pluginDirs: [path.join(tmp, "plugins")], dataDir: path.join(tmp, "data2") });
    await without.start();
    expect(await without.handleInvoke({ channel: API_CHANNELS.appInfo })).toMatchObject({ ok: false });
    await without.stop();
  });
});

describe("file handlers and OS arguments", () => {
  const h = (id: string, extra: Partial<FileHandlerDef>): FileHandlerDef => ({ id, title: id, extensions: [".md"], mode: "route", ...extra });
  it("matches by extension (dot or not, any case) or mime, best first: priority, then extension over mime/wildcard", () => {
    const handlers = [h("any", { extensions: ["*"] }), h("mime", { extensions: [".txt"], mimeTypes: ["text/markdown"] }), h("md", { extensions: ["MD"] }), h("hi", { extensions: [".md"], priority: 5 }), h("img", { extensions: ["png"] })];
    expect(resolveFileHandlers(handlers, { ext: "md", mime: "text/markdown" }).map((x) => x.id)).toEqual(["hi", "md", "any", "mime"]);
    expect(resolveFileHandlers(handlers, { ext: ".PNG", mime: "image/png" }).map((x) => x.id)).toEqual(["img", "any"]);
    expect(resolveFileHandlers([h("a", { extensions: ["pdf"] })], { ext: "docx", mime: "x" })).toEqual([]);
  });
  it("reads files from a command line: existing files only, no flags, no electron/node binaries", async () => {
    const f = path.join(tmp, "doc.md");
    await fs.writeFile(f, "x");
    expect(await filesFromArgv(["/usr/bin/electron", "--inspect=5858", f, "/missing.md", path.join(tmp), ""])).toEqual([f]);
  });
});

/* ------------------------------------------------------------ app updates */

const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
interface Server { files: Map<string, Buffer>; hits: string[] }
async function publish(version: string, payload: Record<string, string>, opts: { server?: Server; extra?: Partial<UpdateManifest>; key?: string } = {}) {
  const server = opts.server ?? { files: new Map<string, Buffer>(), hits: [] };
  const files: UpdateManifest["files"] = {};
  for (const [p, c] of Object.entries(payload)) {
    const buf = Buffer.from(c);
    server.files.set(`/blobs/${sha(buf)}`, buf);
    files[p] = { sha256: sha(buf), size: buf.length, url: `blobs/${sha(buf)}` };
  }
  let m: UpdateManifest = { version, publishedAt: "2026-01-01T00:00:00Z", notes: `# ${version}\n\nNotes`, files, ...opts.extra };
  if (opts.key) m = signUpdateManifest(m, opts.key);
  server.files.set("/latest.json", Buffer.from(JSON.stringify(m)));
  server.files.set("/releases.json", Buffer.from(JSON.stringify([{ version: "1.0.0", publishedAt: "a" }, { version: "1.2.0", publishedAt: "b", installers: { win: "https://x/setup.exe" } }, { version, publishedAt: "c" }, { version: "bad", publishedAt: "d" }])));
  return server;
}
const fetchOf = (s: Server): typeof fetch => (async (u: string) => {
  const p = new URL(String(u)).pathname;
  s.hits.push(p);
  const b = s.files.get(p);
  return b ? new Response(new Uint8Array(b)) : new Response("", { status: 404 });
}) as never;

async function installed(files: Record<string, string>) {
  const dir = path.join(tmp, "installed");
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await fs.writeFile(path.join(dir, p), c);
  }
  return dir;
}
const mkUpdater = (server: Server, payloadDir: string, o: Record<string, unknown> = {}) =>
  new AppUpdater({ source: { type: "http", url: "https://updates.test/" }, dir: path.join(tmp, "upd"), currentVersion: "1.0.0", payloadDir, fetchImpl: fetchOf(server), ...o });

describe("app updates · progressive download", () => {
  it("plans a delta: only changed/new files are downloaded, unchanged ones are reused, removed ones dropped", () => {
    const m = { version: "2.0.0", publishedAt: "", files: { a: { sha256: "A", size: 100, url: "" }, b: { sha256: "B2", size: 10, url: "" }, c: { sha256: "C", size: 5, url: "" } } };
    const p = planAppUpdate({ version: "1.0.0", files: { a: "A", b: "B1", old: "O" } }, m);
    expect(p).toMatchObject({ status: "update", reuse: ["a"], remove: ["old"], totalBytes: 15, savedBytes: 100 });
    expect(p.download.map((d) => d.path)).toEqual(["b", "c"]);
    expect(planAppUpdate({ version: "2.0.0", files: {} }, m).status).toBe("up-to-date");
    expect(planAppUpdate({ version: "3.0.0", files: {} }, m).status).toBe("downgrade");
    expect(nextVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(nextVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(nextVersion("1.2.3", "major")).toBe("2.0.0");
    expect(stableStringify({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[2,{"y":2,"z":1}]},"b":1}');
  });

  it("checks, downloads only what changed with progress, and stages a complete payload", async () => {
    const dir = await installed({ "main.cjs": "main v1", "renderer.js": "renderer v1", "keep.txt": "same" });
    const server = await publish("1.1.0", { "main.cjs": "main v2", "renderer.js": "renderer v1", "keep.txt": "same", "new.js": "brand new" });
    const states: string[] = [];
    const u = mkUpdater(server, dir, { onState: (s: { status: string }) => states.push(s.status) });
    const c = await u.check();
    expect(c).toMatchObject({ status: "available", latest: "1.1.0", notes: expect.stringContaining("Notes"), totalBytes: "main v2".length + "brand new".length, savedBytes: "renderer v1".length + "same".length });
    expect(await u.download()).toMatchObject({ status: "ready", progress: { filesDone: 2, filesTotal: 2 } });
    expect([...new Set(states)]).toEqual(["checking", "available", "downloading", "ready"]);
    const blobHits = server.hits.filter((h) => h.startsWith("/blobs/"));
    expect(blobHits).toHaveLength(2); // exactly the two changed files, nothing else
    const staged = path.join(tmp, "upd", "1.1.0");
    expect(await fs.readFile(path.join(staged, "main.cjs"), "utf8")).toBe("main v2");
    expect(await fs.readFile(path.join(staged, "keep.txt"), "utf8")).toBe("same"); // reused locally
    expect(await fs.readFile(path.join(staged, "new.js"), "utf8")).toBe("brand new");
    expect(JSON.parse(await fs.readFile(path.join(staged, "payload.json"), "utf8")).version).toBe("1.1.0");
    expect(payloadVersion(staged, "0.0.0")).toBe("1.1.0");
    expect(payloadVersion(dir, "1.0.0")).toBe("1.0.0");
    expect((await fs.readdir(path.join(tmp, "upd"))).some((n) => n.endsWith(".partial"))).toBe(false);
  });

  it("reports up-to-date, server errors and invalid manifests; refuses a file that does not match its checksum", async () => {
    const dir = await installed({ "main.cjs": "v1" });
    const same = await publish("1.0.0", { "main.cjs": "v1" });
    expect(await mkUpdater(same, dir).check()).toMatchObject({ status: "up-to-date", latest: "1.0.0" });
    expect(await mkUpdater({ files: new Map(), hits: [] }, dir).check()).toMatchObject({ status: "error", error: expect.stringMatching(/404/) });
    const bad: Server = { files: new Map([["/latest.json", Buffer.from('{"version":"x"}')]]), hits: [] };
    expect(await mkUpdater(bad, dir).check()).toMatchObject({ status: "error", error: expect.stringMatching(/not valid/) });
    const server = await publish("1.1.0", { "main.cjs": "v2" });
    const blob = [...server.files.keys()].find((k) => k.startsWith("/blobs/"))!;
    server.files.set(blob, Buffer.from("TAMPERED"));
    const u = mkUpdater(server, dir);
    await u.check();
    expect(await u.download()).toMatchObject({ status: "error", error: expect.stringMatching(/checksum/) });
    expect((await fs.readdir(path.join(tmp, "upd")).catch(() => [])).length).toBe(0); // nothing half-written is left
  });

  it("cancelling a download returns to 'available'; onceIdle runs only when no download is running (background quit)", async () => {
    const dir = await installed({ "a.js": "1" });
    const server = await publish("1.1.0", { "a.js": "2" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = (async (u: string) => (String(u).includes("/blobs/") ? (await gate, fetchOf(server)(u)) : fetchOf(server)(u))) as unknown as typeof fetch;
    const u = new AppUpdater({ source: { type: "http", url: "https://u.test/" }, dir: path.join(tmp, "upd"), currentVersion: "1.0.0", payloadDir: dir, fetchImpl: slow });
    await u.check();
    const running = u.download();
    await new Promise((r) => setTimeout(r, 10));
    expect(u.state.status).toBe("downloading");
    let quit = false;
    u.onceIdle(() => (quit = true));
    expect(quit).toBe(false);
    release();
    await running;
    expect(u.state.status).toBe("ready");
    expect(quit).toBe(true);
    // cancel path
    const u2 = new AppUpdater({ source: { type: "http", url: "https://u.test/" }, dir: path.join(tmp, "upd2"), currentVersion: "1.0.0", payloadDir: dir, fetchImpl: ((url: string, init?: RequestInit) => new Promise((_res, rej) => (String(url).includes("/blobs/") ? init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))) : fetchOf(server)(url).then(_res)))) as never });
    await u2.check();
    const d2 = u2.download();
    await new Promise((r) => setTimeout(r, 10));
    u2.cancel();
    expect(await d2).toMatchObject({ status: "available" });
  });

  it("lists the full history, newest first, with installers; ignores invalid versions", async () => {
    const server = await publish("1.1.0", { "a.js": "x" });
    const r = await mkUpdater(server, tmp).releases();
    expect(r.map((x) => x.version)).toEqual(["1.2.0", "1.1.0", "1.0.0"]);
    expect(r[0]!.installers).toEqual({ win: "https://x/setup.exe" });
  });

  it("resolves GitHub sources to the stable 'latest release' asset URLs", async () => {
    const hits: string[] = [];
    const u = new AppUpdater({ source: { type: "github", repo: "acme/app" }, dir: tmp, currentVersion: "1.0.0", payloadDir: tmp, fetchImpl: (async (url: string) => (hits.push(String(url)), new Response("", { status: 404 }))) as never });
    await u.check();
    expect(hits[0]).toBe("https://github.com/acme/app/releases/latest/download/latest.json");
  });
});

describe("app updates · safe start, rollback, signatures, minimum host", () => {
  const stage = async (dir: string, version: string) => {
    await fs.mkdir(path.join(dir, version), { recursive: true });
    await fs.writeFile(path.join(dir, version, "main.cjs"), "//");
    await fs.writeFile(path.join(dir, "current.json"), JSON.stringify({ version, dir: path.join(dir, version), boots: 0, confirmed: false }));
  };
  it("boots the downloaded version; confirmBoot keeps it; two unconfirmed starts roll back to the bundled version", async () => {
    const dir = path.join(tmp, "app-updates");
    await stage(dir, "1.1.0");
    expect(resolveBootTarget(dir, "/bundled", "1.0.0")).toMatchObject({ dir: path.join(dir, "1.1.0"), version: "1.1.0" });
    expect(resolveBootTarget(dir, "/bundled", "1.0.0").version).toBe("1.1.0");
    expect(resolveBootTarget(dir, "/bundled", "1.0.0")).toMatchObject({ dir: "/bundled", rolledBack: true });
    expect(JSON.parse(await fs.readFile(path.join(dir, "bad.json"), "utf8")).version).toBe("1.1.0");
    expect(resolveBootTarget(dir, "/bundled", "1.0.0")).toEqual({ dir: "/bundled" }); // pointer removed: stays on the bundled version
    await stage(dir, "1.2.0");
    resolveBootTarget(dir, "/bundled", "1.0.0");
    confirmBoot(dir); // the window showed: keep it
    for (let i = 0; i < 4; i++) expect(resolveBootTarget(dir, "/bundled", "1.0.0").version).toBe("1.2.0");
  });
  it("ignores a stale pointer (reinstalled newer app) and a payload without main.cjs", async () => {
    const dir = path.join(tmp, "au");
    await stage(dir, "1.1.0");
    expect(resolveBootTarget(dir, "/bundled", "2.0.0")).toEqual({ dir: "/bundled" });
    await stage(dir, "3.0.0");
    await fs.rm(path.join(dir, "3.0.0", "main.cjs"));
    expect(resolveBootTarget(dir, "/bundled", "1.0.0")).toEqual({ dir: "/bundled" });
    expect(resolveBootTarget(path.join(tmp, "nothing"), "/bundled")).toEqual({ dir: "/bundled" });
  });
  it("accepts only manifests signed by the expected key; a modified manifest or another key is refused", async () => {
    const k = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    const m = signUpdateManifest({ version: "2.0.0", publishedAt: "x", files: {} }, k.privateKey);
    expect(verifyUpdateManifest(m, k.publicKey)).toBe(true);
    expect(verifyUpdateManifest(m, other.publicKey)).toBe(false);
    expect(verifyUpdateManifest({ ...m, version: "9.9.9" }, k.publicKey)).toBe(false);
    expect(verifyUpdateManifest({ ...m, notes: "evil" }, k.publicKey)).toBe(false);
    expect(verifyUpdateManifest({ ...m, signature: undefined }, k.publicKey)).toBe(false);
    expect(verifyUpdateManifest(m, "garbage")).toBe(false);
    const dir = await installed({ "a.js": "1" });
    const signed = await publish("2.0.0", { "a.js": "2" }, { key: k.privateKey });
    expect(await mkUpdater(signed, dir, { publicKey: k.publicKey }).check()).toMatchObject({ status: "available" });
    expect(await mkUpdater(signed, dir, { publicKey: other.publicKey }).check()).toMatchObject({ status: "error", error: expect.stringMatching(/not signed by the expected key/) });
    const unsigned = await publish("2.0.0", { "a.js": "2" });
    expect(await mkUpdater(unsigned, dir, { publicKey: k.publicKey }).check()).toMatchObject({ status: "error" });
    expect(await mkUpdater(unsigned, dir).check()).toMatchObject({ status: "available" }); // no key configured: accepted (the publisher warns)
  });
  it("an update that needs a newer installer is flagged and cannot be downloaded", async () => {
    const dir = await installed({ "a.js": "1" });
    const server = await publish("2.0.0", { "a.js": "2" }, { extra: { minHost: "1.5.0" } });
    const old = mkUpdater(server, dir, { hostVersion: "1.2.0" });
    expect(await old.check()).toMatchObject({ status: "available", requiresInstaller: "1.5.0" });
    expect((await old.download()).status).toBe("available"); // nothing is downloaded
    expect(server.hits.some((h) => h.startsWith("/blobs/"))).toBe(false);
    expect((await mkUpdater(server, dir, { hostVersion: "1.5.0" }).check()).requiresInstaller).toBeUndefined();
  });
});

/* ------------------------------------------------------------ translations */

describe("README translation", () => {
  const fr = "Ce plugin est une extension pour votre application. Il vous permet de gérer les notes et de les exporter dans une liste pour la suite du travail avec vos amis.";
  const en = "This plugin is an extension for your application. It lets you manage the notes and export them to a list for the rest of the work with your friends.";
  it("detects the language from stop-words, and says nothing when unsure", () => {
    expect(detectLanguage(fr)).toBe("fr");
    expect(detectLanguage(en)).toBe("en");
    expect(detectLanguage("Das ist ein Test und die Sache ist nicht schwer für sie, mit den Dingen auf dem Tisch und ein bisschen mehr Text hier")).toBe("de");
    expect(detectLanguage("too short")).toBeUndefined();
    expect(detectLanguage("zxq vbn mlk poi uyt rew qaz wsx edc rfv tgb yhn ujm ik")).toBeUndefined();
  });
  it("is off unless enabled; builds the right request per engine; never sends the key in config", async () => {
    expect(createTranslator(undefined)).toBeUndefined();
    expect(createTranslator({ enabled: false, provider: "libretranslate" })).toBeUndefined();
    const calls: { url: string; body: any }[] = [];
    const f = (async (url: string, init: RequestInit) => (calls.push({ url, body: JSON.parse(String(init.body)) }), new Response(JSON.stringify({ translatedText: "T", text: "C", data: { translations: [{ translatedText: "G" }] } })))) as never;
    const libre = createTranslator({ enabled: true, provider: "libretranslate", url: "https://lt.example/", apiKeyEnv: "K" }, { K: "secret" }, f)!;
    expect(await libre.translate("Bonjour", "fr", "en")).toBe("T");
    expect(calls[0]).toMatchObject({ url: "https://lt.example/translate", body: { q: "Bonjour", source: "fr", target: "en", api_key: "secret" } });
    expect(() => createTranslator({ enabled: true, provider: "google", apiKeyEnv: "G" }, {}, f)).toThrow(/API key/);
    const g = createTranslator({ enabled: true, provider: "google", apiKeyEnv: "G" }, { G: "k&1" }, f)!;
    expect(await g.translate("Bonjour", undefined, "en")).toBe("G");
    expect(calls[1]!.url).toBe("https://translation.googleapis.com/language/translate/v2?key=k%261");
    const custom = createTranslator({ enabled: true, provider: "custom", url: "https://tr.example/api" }, {}, f)!;
    expect(await custom.translate("Salut", "fr", "de")).toBe("C");
    expect(calls[2]!.body).toEqual({ text: "Salut", from: "fr", to: "de" });
  });
  it("translates Markdown paragraph by paragraph, leaves code blocks alone and caches results", async () => {
    let n = 0;
    const tr = { name: "fake", translate: async (t: string) => (n++, `«${t}»`) };
    const cache = new TranslationCache(path.join(tmp, "cache.json"));
    const md = "# Titre\n\nPremier paragraphe.\n\n```ts\nconst x = 'ne pas traduire';\n```\n\nDernier paragraphe.\n\n---";
    const out = await translateMarkdown(md, "en", "fr", tr, cache);
    expect(out).toContain("«# Titre»");
    expect(out).toContain("«Premier paragraphe.»");
    expect(out).toContain("```ts\nconst x = 'ne pas traduire';\n```");
    expect(out).not.toContain("«const");
    expect(out).toContain("---"); // no letters: untouched
    expect(n).toBe(3);
    await translateMarkdown(md, "en", "fr", tr, cache);
    expect(n).toBe(3); // served from the cache
    expect(JSON.parse(await fs.readFile(path.join(tmp, "cache.json"), "utf8"))).toBeTypeOf("object");
  });
  it("the plugin manager serves the README in the interface language when a translator is configured", async () => {
    const pdir = path.join(tmp, "plugins", "readme.p");
    await fs.mkdir(path.join(pdir, "dist"), { recursive: true });
    await fs.writeFile(path.join(pdir, "plugin.json"), JSON.stringify({ id: "readme.p", name: "R", version: "1.0.0", main: "./dist/main.mjs", permissions: ["ipc"], readme: "./README.md" }));
    await fs.writeFile(path.join(pdir, "dist/main.mjs"), "export default {}");
    await fs.writeFile(path.join(pdir, "README.md"), fr);
    const fetched: unknown[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => (fetched.push(JSON.parse(String(init.body))), new Response(JSON.stringify({ text: "translated!" }))));
    const on = new MainFramework({ pluginDirs: [path.join(tmp, "plugins")], dataDir: path.join(tmp, "d"), translate: { enabled: true, provider: "custom", url: "https://tr.example/api" } });
    await on.start();
    expect(await call(on, "flux.plugins.readme", { id: "readme.p", locale: "en-GB" })).toMatchObject({ ok: true, value: { translated: true, text: "translated!", from: "fr", to: "en", provider: "tr.example" } });
    expect(await call(on, "flux.plugins.readme", { id: "readme.p", locale: "fr" })).toMatchObject({ value: { translated: false, text: fr } }); // already in that language
    expect(fetched).toHaveLength(1);
    const off = new MainFramework({ pluginDirs: [path.join(tmp, "plugins")], dataDir: path.join(tmp, "d2") });
    await off.start();
    expect(await call(off, "flux.plugins.readme", { id: "readme.p", locale: "en" })).toMatchObject({ value: { translated: false, from: "fr", reason: expect.stringMatching(/not enabled/) } });
    await on.stop();
    await off.stop();
  });
});
