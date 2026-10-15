import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { MenuRegistry, parseVideo } from "fluxplugin";
import { downloadFolder, entriesFromIndex, readAsset, HttpRegistry, type RegistryEntry } from "fluxplugin/main";
import { sanitizeFontFamily } from "fluxplugin/react";
import { storeBuild } from "../../src/cli/store";

describe("parseVideo: several players + HTML5", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "youtube", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "youtube", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://vimeo.com/76979871", "vimeo", "https://player.vimeo.com/video/76979871"],
    ["https://www.dailymotion.com/video/x7tgad0", "dailymotion", "https://www.dailymotion.com/embed/video/x7tgad0"],
    ["https://dai.ly/x7tgad0", "dailymotion", "https://www.dailymotion.com/embed/video/x7tgad0"],
    ["https://www.loom.com/share/abc123def456", "loom", "https://www.loom.com/embed/abc123def456"],
    ["https://streamable.com/abc12", "streamable", "https://streamable.com/e/abc12"],
  ])("%s → %s iframe", (url, kind, embed) => expect(parseVideo(url)).toMatchObject({ kind, embedUrl: embed }));

  it("uses the native HTML5 player for media files, remote or shipped inside the plugin", () => {
    expect(parseVideo("https://cdn.example.com/demo.mp4?x=1")).toMatchObject({ kind: "html5", src: "https://cdn.example.com/demo.mp4?x=1" });
    expect(parseVideo("https://cdn.example.com/a.webm")?.kind).toBe("html5");
    expect(parseVideo("./assets/tour.mov")).toMatchObject({ kind: "html5", src: "./assets/tour.mov" });
  });
  it("falls back to a link for unknown hosts and refuses unsafe input", () => {
    expect(parseVideo("https://example.com/watch/1")?.kind).toBe("link");
    expect(parseVideo("http://youtu.be/dQw4w9WgXcQ")).toBeUndefined();
    expect(parseVideo("javascript:alert(1)")).toBeUndefined();
    expect(parseVideo("./assets/readme.txt")).toBeUndefined();
    expect(parseVideo(undefined)).toBeUndefined();
  });
});

describe("menu tree (sub-menus)", () => {
  it("nests by `parent` and by `children`, orders, and tolerates unknown parents", () => {
    const m = new MenuRegistry();
    m.register({ id: "tools", location: "sidebar", label: "Tools", order: 5, children: [{ id: "own", label: "Own child", order: 1 }] }, "a");
    m.register({ id: "b", location: "sidebar", label: "B child", parent: "tools", order: 3 }, "b");
    m.register({ id: "a", location: "sidebar", label: "A child", parent: "tools", order: 2 }, "c");
    m.register({ id: "orphan", location: "sidebar", label: "Orphan", parent: "missing-plugin", order: 9 }, "d");
    m.register({ id: "top", location: "sidebar", label: "Top", order: 1 }, "e");
    const tree = m.tree("sidebar");
    expect(tree.map((n) => n.id)).toEqual(["top", "tools", "orphan"]);
    expect(tree[1]!.children!.map((c) => c.id)).toEqual(["own", "a", "b"]);
    expect(tree[0]!.children).toBeUndefined();
  });
});

describe("readAsset: Range support for <video> seeking", () => {
  it("serves full files, partial content, suffix ranges and rejects unsatisfiable ranges", async () => {
    const f = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "flux-range-")), "v.mp4");
    const data = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
    await fs.writeFile(f, data);
    const full = await readAsset(f, "video/mp4");
    expect([full.status, full.body.length, full.headers["accept-ranges"]]).toEqual([200, 1000, "bytes"]);
    const part = await readAsset(f, "video/mp4", "bytes=100-199");
    expect([part.status, part.headers["content-range"], part.body.equals(data.subarray(100, 200))]).toEqual([206, "bytes 100-199/1000", true]);
    expect((await readAsset(f, "video/mp4", "bytes=900-")).body.length).toBe(100);
    expect((await readAsset(f, "video/mp4", "bytes=-50")).body.equals(data.subarray(950))).toBe(true);
    expect((await readAsset(f, "video/mp4", "bytes=2000-3000")).status).toBe(416);
  });
});

describe("catalog entries and folder downloads", () => {
  const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
  it("resolves relative URLs in a catalog (object or bare array)", () => {
    const entry = { id: "a.b", version: "1.0.0", folder: "plugins/ab", files: ["plugin.json"], hashes: {}, icon: "plugins/ab/assets/i.svg", screenshots: ["plugins/ab/s.png"], video: "./assets/v.mp4" };
    const [e] = entriesFromIndex([entry], "https://raw.test/acme/store/main/", "x");
    expect(e).toMatchObject({ location: "https://raw.test/acme/store/main/plugins/ab/", iconUrl: "https://raw.test/acme/store/main/plugins/ab/assets/i.svg", folder: true });
    expect(e!.video).toBe("https://raw.test/acme/store/main/plugins/ab/assets/v.mp4");
    expect(entriesFromIndex({ plugins: [entry, { id: "no-location", version: "1" } as never] }, "https://x.test/", "x")).toHaveLength(1);
  });

  it("downloads a plugin folder and verifies every file; rejects tampering, missing hashes and path tricks", async () => {
    const files: Record<string, Buffer> = { "plugin.json": Buffer.from('{"id":"a.b"}'), "dist/main.mjs": Buffer.from("export default {}") };
    const hashes = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)]));
    const get = async (u: string) => {
      const rel = decodeURIComponent(u.replace("https://h.test/p/", ""));
      return rel in files ? new Response(new Uint8Array(files[rel]!)) : new Response("nope", { status: 404 });
    };
    const entry = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({ id: "a.b", name: "A", version: "1.0.0", permissions: [], location: "https://h.test/p/", source: "t", folder: true, files: Object.keys(files), hashes, ...over });
    const out = await fs.mkdtemp(path.join(os.tmpdir(), "flux-dl-"));
    await downloadFolder(entry(), path.join(out, "ok"), get as never);
    expect(await fs.readFile(path.join(out, "ok/dist/main.mjs"), "utf8")).toBe("export default {}");
    await expect(downloadFolder(entry({ hashes: { ...hashes, "dist/main.mjs": sha("other") } }), path.join(out, "t1"), get as never)).rejects.toThrow(/does not match the catalog checksum/);
    await expect(downloadFolder(entry({ hashes: undefined }), path.join(out, "t2"), get as never)).rejects.toThrow(/no file hashes/);
    await expect(downloadFolder(entry({ files: ["plugin.json", "../../evil.txt"], hashes: { ...hashes, "../../evil.txt": sha("x") } }), path.join(out, "t3"), get as never)).rejects.toThrow(/unsafe file path/);
    await expect(downloadFolder(entry({ files: ["dist/main.mjs"] }), path.join(out, "t4"), get as never)).rejects.toThrow(/plugin\.json/);
  });

  it("`store build` aggregates every plugin folder into one JSON (metadata, runtime files only, hashes); a JSON-link store serves it", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "flux-repo-"));
    const put = async (rel: string, c: string) => (await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true }), fs.writeFile(path.join(repo, rel), c));
    await put("plugins/weather/plugin.json", JSON.stringify({ id: "com.acme.weather", name: "Weather", version: "1.2.0", description: "Forecast", author: "Acme", license: "MIT", main: "./dist/main.mjs", icon: "./assets/icon.svg", screenshots: ["./assets/s1.png"], video: "./assets/tour.mp4", categories: ["Weather"], keywords: ["rain"], permissions: ["ipc"] }));
    for (const [f, c] of [["dist/main.mjs", "export default {}"], ["dist/main.mjs.map", "{}"], ["assets/icon.svg", "<svg/>"], ["assets/s1.png", "png"], ["assets/tour.mp4", "mp4"], ["README.md", "# Weather\n\nSunny."], ["src/main.ts", "secret"], ["package.json", "{}"]] as const) await put(`plugins/weather/${f}`, c);
    const r = await storeBuild(repo, { log: () => {} });
    expect(r.count).toBe(1);
    const catalog = JSON.parse(await fs.readFile(r.file, "utf8"));
    const p = catalog.plugins[0];
    expect(p).toMatchObject({ id: "com.acme.weather", folder: "plugins/weather/", icon: "plugins/weather/assets/icon.svg", video: "plugins/weather/assets/tour.mp4", readme: expect.stringContaining("Sunny") });
    expect(p.files.sort()).toEqual(["README.md", "assets/icon.svg", "assets/s1.png", "assets/tour.mp4", "dist/main.mjs", "plugin.json"]); // no src, no .map, no package.json
    expect(p.hashes["dist/main.mjs"]).toBe(sha("export default {}"));

    // a store defined by a plain link that returns the JSON (a file or an API)
    const served = new Map<string, Buffer>([["/api/plugins", Buffer.from(JSON.stringify(catalog.plugins))]]);
    for (const f of p.files as string[]) served.set(`/api/plugins/weather/${f}`, await fs.readFile(path.join(repo, "plugins/weather", f)));
    const fake = (async (u: string) => {
      const b = served.get(new URL(String(u)).pathname);
      return b ? new Response(new Uint8Array(b)) : new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const base = "https://api.acme.test/api/plugins";
    const store = new HttpRegistry(base, fake, {}, true);
    const [entry] = await store.search("rain");
    expect(entry).toMatchObject({ id: "com.acme.weather", folder: true });
    // folder URLs in this API point under the same host: patch location the way a real API would return absolute URLs
    const real = { ...entry!, location: "https://api.acme.test/api/plugins/weather/" };
    const dest = path.join(repo, "installed");
    const m = await store.fetch(real, dest);
    expect(m.id).toBe("com.acme.weather");
    expect(await fs.readFile(path.join(dest, "assets/tour.mp4"), "utf8")).toBe("mp4");
  });
});

describe("fonts", () => {
  it("sanitizes a user-typed font list: quotes families, strips anything that could break out of CSS", () => {
    expect(sanitizeFontFamily("Avenir Next, Helvetica Neue")).toBe('"Avenir Next", "Helvetica Neue"');
    expect(sanitizeFontFamily('Evil"; } body{display:none} /* ')).toBe('"Evil bodydisplaynone"');
    expect(sanitizeFontFamily("Fira Code, 'Cascadia Mono'")).toBe('"Fira Code", "Cascadia Mono"');
    expect(sanitizeFontFamily("  ,, ")).toBe("");
  });
});
