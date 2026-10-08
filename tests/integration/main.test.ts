import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FsStorageBackend,
  HttpRegistry,
  LocalRegistry,
  MainFramework,
  PluginInstaller,
  attachElectron,
  attachHttp,
  computeIntegrity,
  createTarGz,
  discoverPlugins,
  extractTarGz,
  generateSigningKeyPair,
  readTarGz,
  resolvePluginAsset,
  signManifest,
} from "fluxplugin/main";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const ALL = ["commands", "ipc", "services", "events", "routes", "ui", "menus", "hooks", "styles"];

async function writePlugin(dir: string, id: string, opts: { version?: string; main?: string; extra?: Record<string, unknown>; files?: Record<string, string> } = {}) {
  const root = path.join(dir, id);
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  const manifest = { id, name: id, version: opts.version ?? "1.0.0", main: "./dist/main.mjs", renderer: "./dist/renderer.js", styles: ["./dist/style.css"], permissions: ALL, engines: { "fluxplugin": "^1.0.0" }, ...opts.extra };
  await fs.writeFile(path.join(root, "plugin.json"), JSON.stringify(manifest, null, 2));
  await fs.writeFile(
    path.join(root, "dist/main.mjs"),
    opts.main ??
      `export default {
        ipc: [{ name: "${id}.ping", contract: {name:"${id}.ping"}, handler: async (_i, ctx) => ({ pong: true, by: ctx.pluginId }) }],
        preload: { demo: { ping: "${id}.ping" } },
        services: { "${id}.svc": { hello: () => "hi" } }
      };`,
  );
  await fs.writeFile(path.join(root, "dist/renderer.js"), "export default {};");
  await fs.writeFile(path.join(root, "dist/style.css"), ".a{}");
  for (const [f, c] of Object.entries(opts.files ?? {})) await fs.writeFile(path.join(root, f), c);
  return root;
}

describe("tar.gz", () => {
  it("round-trips a directory and strips the package/ prefix on extract", async () => {
    const src = await writePlugin(tmp, "t.one");
    const buf = await createTarGz(src);
    const names = (await readTarGz(buf)).map((e) => e.name);
    expect(names).toContain("package/plugin.json");
    const out = path.join(tmp, "out");
    await extractTarGz(buf, out);
    expect(JSON.parse(await fs.readFile(path.join(out, "plugin.json"), "utf8")).id).toBe("t.one");
    expect(await fs.readFile(path.join(out, "dist/style.css"), "utf8")).toBe(".a{}");
  });

  it("rejects archives that try to escape the destination", async () => {
    const zlib = await import("node:zlib");
    const evil = (name: string) => {
      const h = Buffer.alloc(512);
      h.write(name, 0);
      h.write("0000644\0", 100);
      h.write("00000000005\0", 124);
      h.write("        ", 148);
      h.write("0", 156);
      h.write("ustar\0", 257);
      let sum = 0;
      for (const b of h) sum += b;
      h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
      return zlib.gzipSync(Buffer.concat([h, Buffer.from("hello".padEnd(512, "\0")), Buffer.alloc(1024)]));
    };
    await expect(extractTarGz(evil("package/../../escape.txt"), path.join(tmp, "o"))).rejects.toThrow(/unsafe path/);
    expect(await fs.stat(path.join(tmp, "escape.txt")).catch(() => null)).toBeNull();
  });
});

describe("storage backend", () => {
  it("persists atomically per namespace and survives re-instantiation", async () => {
    const dir = path.join(tmp, "s");
    const a = new FsStorageBackend(dir);
    await a.write("com.x/../evil", { k: 1 });
    expect(await new FsStorageBackend(dir).read("com.x/../evil")).toEqual({ k: 1 });
    expect((await fs.readdir(dir)).every((f) => !f.includes("/") && f.endsWith(".json"))).toBe(true);
    expect(await a.read("none")).toEqual({});
  });
});

describe("discovery & security", () => {
  it("discovers valid plugins and reports unreadable ones without throwing", async () => {
    await writePlugin(tmp, "d.ok");
    await fs.mkdir(path.join(tmp, "broken"));
    await fs.writeFile(path.join(tmp, "broken/plugin.json"), "{ not json");
    const found = await discoverPlugins(tmp);
    expect(found.map((f) => path.basename(f.root))).toEqual(["broken", "d.ok"]);
    expect(found[0]!.problem).toMatch(/cannot read/);
    expect(found[1]!.problem).toBeUndefined();
  });

  it("detects tampering through integrity hashes", async () => {
    const root = await writePlugin(tmp, "i.p");
    const m = JSON.parse(await fs.readFile(path.join(root, "plugin.json"), "utf8"));
    m.integrity = await computeIntegrity(root, m);
    await fs.writeFile(path.join(root, "plugin.json"), JSON.stringify(m));
    expect((await discoverPlugins(tmp))[0]!.problem).toBeUndefined();
    await fs.appendFile(path.join(root, "dist/main.mjs"), "\n// injected");
    expect((await discoverPlugins(tmp))[0]!.problem).toMatch(/does not match/);
  });

  it("verifies ed25519 signatures and enforces trusted keys", async () => {
    const keys = generateSigningKeyPair();
    const root = await writePlugin(tmp, "sig.p");
    const raw = JSON.parse(await fs.readFile(path.join(root, "plugin.json"), "utf8"));
    raw.integrity = await computeIntegrity(root, raw);
    await fs.writeFile(path.join(root, "plugin.json"), JSON.stringify(signManifest(raw, keys.privateKey)));
    expect((await discoverPlugins(tmp, { requireSignature: true, trustedKeys: [keys.publicKey] }))[0]!.problem).toBeUndefined();
    expect((await discoverPlugins(tmp, { requireSignature: true, trustedKeys: ["someone-else"] }))[0]!.problem).toMatch(/untrusted/);
    // tampering with the manifest invalidates the signature
    const signed = JSON.parse(await fs.readFile(path.join(root, "plugin.json"), "utf8"));
    signed.permissions = [...signed.permissions, "shell"];
    await fs.writeFile(path.join(root, "plugin.json"), JSON.stringify(signed));
    expect((await discoverPlugins(tmp, { requireSignature: true, trustedKeys: [keys.publicKey] }))[0]!.problem).toMatch(/signature is invalid/);
  });

  it("requireSignature rejects unsigned plugins", async () => {
    await writePlugin(tmp, "u.p");
    expect((await discoverPlugins(tmp, { requireSignature: true }))[0]!.problem).toMatch(/integrity hashes are required|not signed/);
  });
});

describe("installer: install / update / rollback / uninstall", () => {
  it("installs from a local registry, updates keeping a backup, and rolls back", async () => {
    const repo = path.join(tmp, "repo");
    const plugins = path.join(tmp, "plugins");
    await writePlugin(repo, "r.p", { version: "1.0.0" });
    const reg = new LocalRegistry(repo);
    const inst = new PluginInstaller(plugins, path.join(tmp, "bk"), [reg]);

    const [entry] = await inst.search("r.p");
    expect(entry!.version).toBe("1.0.0");
    expect(await inst.install(entry!)).toMatchObject({ id: "r.p", version: "1.0.0", previousVersion: undefined });

    await fs.rm(path.join(repo, "r.p"), { recursive: true });
    await writePlugin(repo, "r.p", { version: "1.1.0" });
    const updates = await inst.updates();
    expect(updates.map((u) => u.version)).toEqual(["1.1.0"]);
    expect(await inst.install(updates[0]!)).toMatchObject({ version: "1.1.0", previousVersion: "1.0.0" });
    expect((await inst.installed())[0]!.version).toBe("1.1.0");
    expect(await inst.versions("r.p")).toEqual(["1.0.0"]);

    expect(await inst.rollback("r.p")).toMatchObject({ version: "1.0.0", previousVersion: "1.1.0" });
    expect((await inst.installed())[0]!.version).toBe("1.0.0");
    await expect(inst.rollback("r.p", "9.9.9")).rejects.toThrow(/no backup/);

    await inst.uninstall("r.p");
    expect(await inst.installed()).toEqual([]);
  });

  it("HTTP registry downloads a tgz and verifies its checksum", async () => {
    const src = await writePlugin(tmp, "h.p");
    const buf = await createTarGz(src);
    const sha = (await import("node:crypto")).createHash("sha256").update(buf).digest("hex");
    const fake = (async (u: string | URL) => {
      const url = String(u);
      if (url.endsWith("index.json")) return new Response(JSON.stringify({ plugins: [{ id: "h.p", name: "H", version: "1.0.0", url: "h.p-1.0.0.tgz", sha256: sha }] }));
      return new Response(new Uint8Array(buf));
    }) as unknown as typeof fetch;
    const reg = new HttpRegistry("https://registry.example/plugins", fake);
    const inst = new PluginInstaller(path.join(tmp, "plugins"), path.join(tmp, "bk"), [reg]);
    const [entry] = await inst.search();
    await inst.install(entry!);
    expect((await inst.installed())[0]!.id).toBe("h.p");
    await expect(inst.install({ ...entry!, sha256: "00".repeat(32) })).rejects.toThrow(/checksum/);
  });
});

describe("MainFramework", () => {
  const mkFw = async (extra: Record<string, unknown> = {}) => {
    const plugins = path.join(tmp, "plugins");
    await fs.mkdir(plugins, { recursive: true });
    return { plugins, make: () => new MainFramework({ pluginDirs: [plugins], dataDir: path.join(tmp, "data"), assetUrl: (id, rel) => `/@plugins/${id}/${rel.replace(/^\.\//, "")}`, ...extra }) };
  };

  it("loads plugins from disk, serves bootstrap, and isolates a broken plugin", async () => {
    const { plugins, make } = await mkFw();
    await writePlugin(plugins, "a.good");
    await writePlugin(plugins, "b.bad", { main: "throw new Error('syntax boom');" });
    await fs.mkdir(path.join(plugins, "c.invalid"));
    await fs.writeFile(path.join(plugins, "c.invalid/plugin.json"), JSON.stringify({ id: "c.invalid", name: "x", version: "nope" }));
    const fw = make();
    await fw.start();
    const byId = Object.fromEntries(fw.manager.list().map((p) => [p.id, p]));
    expect(byId["a.good"]!.state).toBe("ready");
    expect(byId["b.bad"]!.state).toBe("error");
    expect(byId["c.invalid"]!.state).toBe("error");
    const boot = fw.bootstrap();
    expect(boot.plugins.find((p) => p.id === "a.good")).toMatchObject({ rendererUrl: "/@plugins/a.good/dist/renderer.js", styleUrls: ["/@plugins/a.good/dist/style.css"], enabled: true });
    expect(boot.plugins.find((p) => p.id === "c.invalid")!.rendererUrl).toBeUndefined();
    expect(boot.preload["demo"]).toBeDefined();
    await fw.stop();
  });

  it("renderer policy: only exposed channels are callable; management is gated", async () => {
    const { plugins, make } = await mkFw();
    await writePlugin(plugins, "a.good", {
      main: `export default { ipc: [
        { name: "a.good.public", contract: {name:"a.good.public"}, handler: () => "ok" },
        { name: "a.good.secret", contract: {name:"a.good.secret"}, handler: () => "nope" } ],
        preload: { api: { pub: "a.good.public" } } };`,
    });
    const fw = make();
    await fw.start();
    expect(await fw.handleInvoke({ channel: "a.good.public" })).toEqual({ ok: true, value: "ok" });
    const denied = await fw.handleInvoke({ channel: "a.good.secret" });
    expect(denied).toMatchObject({ ok: false, error: { message: expect.stringMatching(/not exposed/) } });
    expect(await fw.handleInvoke({ channel: "flux.plugins.list" })).toMatchObject({ ok: true });
    expect(await fw.handleInvoke({ channel: 42 as never })).toMatchObject({ ok: false });
    await fw.stop();

    const { make: make2 } = await mkFw({ allowManagement: false });
    const fw2 = make2();
    await fw2.start();
    expect(await fw2.handleInvoke({ channel: "flux.plugins.list" })).toMatchObject({ ok: false });
    await fw2.stop();
  });

  it("management API: disable/enable persist across restarts; permission approval flow", async () => {
    const { plugins, make } = await mkFw({ requireApproval: true });
    await writePlugin(plugins, "m.p", { extra: { permissions: ["ipc", "services", "events"] } });
    let fw = make();
    await fw.start();
    // nothing granted → activation fails until the user approves
    expect(fw.manager.info("m.p").state).toBe("error");
    for (const permission of ["ipc", "services", "events"]) await fw.handleInvoke({ channel: "flux.plugins.grant", input: { id: "m.p", permission } });
    const en = await fw.handleInvoke({ channel: "flux.plugins.enable", input: { id: "m.p" } });
    expect(en.ok).toBe(true);
    expect(fw.manager.info("m.p").state).toBe("ready");
    await fw.stop();

    fw = make(); // restart: grants were persisted
    await fw.start();
    expect(fw.manager.info("m.p").state).toBe("ready");
    await fw.handleInvoke({ channel: "flux.plugins.disable", input: { id: "m.p" } });
    await fw.stop();
    fw = make();
    await fw.start();
    expect(fw.manager.info("m.p").state).toBe("disabled");
    await fw.stop();
  });

  it("config management round-trip through IPC", async () => {
    const { plugins, make } = await mkFw();
    await writePlugin(plugins, "cfg.p", {
      main: `import { s } from "${path.resolve("packages/core/src/index.ts").replace(/\\/g, "/")}";
             export default { config: { schema: s.object({ n: s.number().default(1) }) } };`,
    }).catch(() => undefined);
    // Importing TS from a .mjs is not possible under plain node; use a hand-rolled schema instead.
    await fs.writeFile(
      path.join(plugins, "cfg.p/dist/main.mjs"),
      `const schema = { kind: "object", parse: (i) => ({ ok: true, value: { n: 1, ...(i||{}) } }), describe: () => ({ type: "object", properties: { n: { type: "number", default: 1 } }, required: [] }), optional(){return this}, default(){return this} };
       export default { config: { schema } };`,
    );
    const fw = make();
    await fw.start();
    expect(await fw.handleInvoke({ channel: "flux.plugins.config.get", input: { id: "cfg.p" } })).toEqual({ ok: true, value: { n: 1 } });
    expect(await fw.handleInvoke({ channel: "flux.plugins.config.set", input: { id: "cfg.p", patch: { n: 5 } } })).toEqual({ ok: true, value: { n: 5 } });
    expect(await fw.handleInvoke({ channel: "flux.plugins.config.schema", input: { id: "cfg.p" } })).toMatchObject({ ok: true, value: { properties: { n: { default: 1 } } } });
    await fw.stop();
  });

  it("serves plugin assets safely (no manifest, main entry or traversal)", async () => {
    const { plugins, make } = await mkFw();
    await writePlugin(plugins, "as.p");
    await fs.writeFile(path.join(tmp, "secret.txt"), "top secret");
    const fw = make();
    await fw.start();
    expect(await resolvePluginAsset(fw, "fluxplugin://as.p/dist/renderer.js")).toMatchObject({ mime: "text/javascript" });
    expect(await resolvePluginAsset(fw, "fluxplugin://as.p/dist/main.mjs")).toBeNull();
    expect(await resolvePluginAsset(fw, "fluxplugin://as.p/plugin.json")).toBeNull();
    expect(await resolvePluginAsset(fw, "fluxplugin://as.p/..%2F..%2Fsecret.txt")).toBeNull();
    expect(await resolvePluginAsset(fw, "fluxplugin://unknown/dist/renderer.js")).toBeNull();
    await fw.stop();
  });

  it("hot reload picks up changes on disk", async () => {
    const { plugins, make } = await mkFw({ hotReload: true });
    const root = await writePlugin(plugins, "hr.p", { main: `export default { services: { "hr.v": { v: 1 } } };` });
    const fw = make();
    await fw.start();
    expect(fw.manager.services.resolve<{ v: number }>("hr.v")!.v).toBe(1);
    await fs.writeFile(path.join(root, "dist/main.mjs"), `export default { services: { "hr.v": { v: 2 } } };`);
    for (let i = 0; i < 40 && fw.manager.services.resolve<{ v: number }>("hr.v")?.v !== 2; i++) await new Promise((r) => setTimeout(r, 50));
    expect(fw.manager.services.resolve<{ v: number }>("hr.v")!.v).toBe(2);
    await fw.stop();
  });

  it("Electron adapter wires ipcMain / webContents without importing electron", async () => {
    const { plugins, make } = await mkFw();
    await writePlugin(plugins, "el.p");
    const fw = make();
    await fw.start();
    const handlers = new Map<string, (...a: any[]) => any>();
    const sent: any[] = [];
    const wc = { id: 7, isDestroyed: () => false, send: (...a: unknown[]) => void sent.push(a) };
    const detach = attachElectron(fw, {
      ipcMain: { handle: (c, l) => void handlers.set(c, l), on: (c, l) => void handlers.set("on:" + c, l), removeHandler: (c) => void handlers.delete(c), removeListener: () => {} },
      webContents: { getAllWebContents: () => [wc] },
    });
    const r = await handlers.get("flux:invoke")!({ sender: { id: 7 } }, { channel: "el.p.ping" });
    expect(r).toEqual({ ok: true, value: { pong: true, by: "el.p" } });
    expect((await handlers.get("flux:bootstrap")!({ sender: { id: 7 } })).plugins).toHaveLength(1);
    fw.broadcast("x.y", { a: 1 });
    expect(sent).toContainEqual(["flux:event", { channel: "x.y", payload: { a: 1 } }]);
    detach();
    expect(handlers.has("flux:invoke")).toBe(false);
    await fw.stop();
  });

  it("HTTP adapter: invoke, bootstrap, assets and server-sent events", async () => {
    const { plugins, make } = await mkFw();
    await writePlugin(plugins, "ht.p");
    const fw = make();
    await fw.start();
    const srv = await attachHttp(fw);
    const base = `http://127.0.0.1:${srv.port}`;
    const boot = (await (await fetch(`${base}/flux/bootstrap`)).json()) as { plugins: unknown[] };
    expect(boot.plugins).toHaveLength(1);
    const inv = await (await fetch(`${base}/flux/invoke`, { method: "POST", body: JSON.stringify({ channel: "ht.p.ping" }) })).json();
    expect(inv).toEqual({ ok: true, value: { pong: true, by: "ht.p" } });
    expect((await fetch(`${base}/@plugins/ht.p/dist/renderer.js`)).status).toBe(200);
    expect((await fetch(`${base}/@plugins/ht.p/dist/main.mjs`)).status).toBe(404);

    const res = await fetch(`${base}/flux/events`);
    const reader = res.body!.getReader();
    await reader.read(); // ": connected"
    fw.broadcast("hello.world", { n: 1 });
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('"channel":"hello.world"');
    await reader.cancel();
    await srv.close();
    await fw.stop();
  });
});
