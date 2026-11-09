import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MemoryStorageBackend, PermissionLockedError, PluginManager, SystemProtectedError, analyzeUpdate, dedupeEntries, definePlugin, paginate, planInstall, queryCatalog,
  type CatalogEntry,
} from "fluxplugin";
import { LocalRegistry, MainFramework, createLicense, generateSigningKeyPair, type PluginRegistry } from "fluxplugin/main";
import { generateNotes } from "../../src/cli/release-notes";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-v3-"));
});
afterEach(async () => void (await fs.rm(tmp, { recursive: true, force: true })));

const PERMS = ["ipc", "services", "events", "commands", "ui", "network"];
async function put(root: string, id: string, over: Record<string, unknown> = {}, main = "export default {};", files: Record<string, string> = {}) {
  const dir = path.join(root, id);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, "dist"), { recursive: true });
  await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify({ id, name: id, version: "1.0.0", main: "./dist/main.mjs", permissions: PERMS, ...over }));
  await fs.writeFile(path.join(dir, "dist/main.mjs"), main);
  for (const [f, c] of Object.entries(files)) await fs.writeFile(path.join(dir, f), c);
  return dir;
}
const mk = async (opts: Record<string, unknown> = {}, registries: PluginRegistry[] = []) => {
  const plugins = path.join(tmp, "plugins");
  await fs.mkdir(plugins, { recursive: true });
  const fw = new MainFramework({ pluginDirs: [plugins], dataDir: path.join(tmp, "data"), registries, ...opts });
  return { fw, plugins };
};
const call = async (fw: MainFramework, channel: string, input?: unknown, caller?: string) => fw.handleInvoke({ channel, input, caller });
const store = (name = "store") => path.join(tmp, name);

describe("1-3 · system plugins and protected permissions", () => {
  it("an ordinary plugin can be installed, disabled, enabled and uninstalled", async () => {
    await put(store(), "ord.p");
    const { fw } = await mk({}, [new LocalRegistry(store(), "s")]);
    await fw.start();
    expect(await call(fw, "flux.plugins.install", { id: "ord.p" })).toMatchObject({ ok: true });
    expect(fw.manager.info("ord.p")).toMatchObject({ state: "ready", isSystem: false });
    expect(await call(fw, "flux.plugins.disable", { id: "ord.p" })).toMatchObject({ ok: true });
    expect(fw.manager.info("ord.p").state).toBe("disabled");
    expect(await call(fw, "flux.plugins.enable", { id: "ord.p" })).toMatchObject({ ok: true });
    expect(await call(fw, "flux.plugins.uninstall", { id: "ord.p" })).toMatchObject({ ok: true });
    expect(fw.manager.has("ord.p")).toBe(false);
    await fw.stop();
  });

  it("a system plugin cannot be disabled or uninstalled — through the API or by calling the manager directly — and its permissions stay on", async () => {
    await put(path.join(tmp, "plugins"), "sys.core", { isSystem: true, requiredPermissions: ["ipc"] });
    const { fw } = await mk({ systemPlugins: ["sys.core"] });
    await fw.start();
    expect(fw.manager.info("sys.core")).toMatchObject({ isSystem: true, state: "ready" });
    for (const ch of ["flux.plugins.disable", "flux.plugins.uninstall"]) expect(await call(fw, ch, { id: "sys.core" })).toMatchObject({ ok: false, error: { code: "FLUX_SYSTEM_PROTECTED" } });
    await expect(fw.manager.disable("sys.core")).rejects.toBeInstanceOf(SystemProtectedError); // bypassing the UI/IPC does not help
    expect(() => fw.manager.assertRemovable("sys.core")).toThrow(/system plugin/);
    expect(() => fw.manager.permissions.revoke("sys.core", "ipc")).toThrow(PermissionLockedError);
    expect(await call(fw, "flux.plugins.revoke", { id: "sys.core", permission: "ipc" })).toMatchObject({ ok: false, error: { code: "FLUX_PERMISSION_LOCKED" } });
    expect(fw.manager.info("sys.core").permissions.locks?.["ipc"]?.kind).toBe("system");
    expect(fw.manager.info("sys.core").permissions.locks?.["network"]?.kind).toBeUndefined(); // only the required one is locked
    await fw.stop();
  });

  it("a plugin cannot promote itself: isSystem in a manifest is ignored unless the host trusts the id", async () => {
    await put(path.join(tmp, "plugins"), "evil.p", { isSystem: true, requiredPermissions: ["ipc"] });
    const { fw } = await mk({ systemPlugins: ["someone.else"] });
    await fw.start();
    expect(fw.manager.info("evil.p").isSystem).toBe(false);
    expect(fw.manager.info("evil.p").warnings.join()).toMatch(/not trust/);
    expect(await call(fw, "flux.plugins.disable", { id: "evil.p" })).toMatchObject({ ok: true });
    // a store download with the same claim is no different
    await put(store(), "evil.store", { isSystem: true });
    const { fw: fw2 } = await mk({ systemPlugins: [] }, [new LocalRegistry(store(), "s")]);
    await fw2.start();
    await call(fw2, "flux.plugins.install", { id: "evil.store" });
    expect(fw2.manager.info("evil.store").isSystem).toBe(false);
    await fw.stop();
    await fw2.stop();
  });

  it("management calls made on behalf of a plugin are refused", async () => {
    await put(path.join(tmp, "plugins"), "a.p");
    const { fw } = await mk();
    await fw.start();
    expect(await call(fw, "flux.plugins.disable", { id: "a.p" }, "a.p")).toMatchObject({ ok: false });
    await fw.stop();
  });

  it("a system plugin required by nothing else is protected, and a plugin a system plugin depends on cannot be disabled", async () => {
    await put(path.join(tmp, "plugins"), "lib.p");
    await put(path.join(tmp, "plugins"), "sys.ui", { isSystem: true, dependencies: { "lib.p": "^1.0.0" } });
    const { fw } = await mk({ systemPlugins: ["sys.ui"] });
    await fw.start();
    expect(await call(fw, "flux.plugins.disable", { id: "lib.p" })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/required by the system plugin/) } });
    await fw.stop();
  });
});

describe("11-12 · permissions in use are locked, then released", () => {
  it("a permission used by an enabled feature (or required, or needed by another permission) cannot be revoked", async () => {
    await put(path.join(tmp, "plugins"), "perm.p", {
      permissions: ["ipc", "network", "filesystem.read", "filesystem.write"],
      requiredPermissions: ["ipc"],
      features: [{ id: "sync", title: "Cloud sync", requires: ["network"] }, { id: "export", title: "Export", requires: ["filesystem.write"], default: false }],
    });
    const { fw } = await mk();
    await fw.start();
    const revoke = (permission: string) => call(fw, "flux.plugins.revoke", { id: "perm.p", permission });
    expect(await revoke("network")).toMatchObject({ ok: false, error: { code: "FLUX_PERMISSION_LOCKED", message: expect.stringMatching(/Cloud sync/) } });
    expect(await revoke("ipc")).toMatchObject({ ok: false, error: { message: expect.stringMatching(/cannot work without/) } });
    expect(await call(fw, "flux.plugins.feature", { id: "perm.p", feature: "export", enabled: true })).toMatchObject({ ok: true });
    expect(await revoke("filesystem.read")).toMatchObject({ ok: false, error: { message: expect.stringMatching(/filesystem\.write/) } }); // write needs read
    // switching the feature off releases the permission
    await call(fw, "flux.plugins.feature", { id: "perm.p", feature: "sync", enabled: false });
    expect(fw.manager.info("perm.p").permissions.locks?.["network"]).toBeUndefined();
    expect(await revoke("network")).toMatchObject({ ok: true });
    expect(fw.manager.permissions.has("perm.p", "network")).toBe(false);
    // and a feature cannot be switched on without the permissions it needs
    expect(await call(fw, "flux.plugins.feature", { id: "perm.p", feature: "sync", enabled: true })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/Grant the permission/) } });
    await fw.stop();
  });

  it("revoked permissions are enforced at runtime, not only recorded", async () => {
    const m = new PluginManager({ runtime: "main", storage: new MemoryStorageBackend() });
    m.register({ manifest: { id: "rt.p", name: "R", version: "1.0.0", main: "x", permissions: ["commands"] }, load: async () => ({ onActivate: (ctx) => void ctx.commands.register({ id: "rt.a", title: "a", execute: () => 1 }) }) });
    await m.activate("rt.p");
    m.permissions.revoke("rt.p", "commands");
    expect(() => m.contextOf("rt.p")!.commands.register({ id: "rt.b", title: "b", execute: () => 1 })).toThrow(/missing permission/);
  });
});

describe("1 · similar plugins: one owner per capability", () => {
  it("only the chosen provider's gated contributions are active; switching moves them", async () => {
    const mkDef = (label: string) => definePlugin({ extensions: [{ point: "lang", capability: "language", contribution: { languages: [{ code: label }] } }, { point: "lang", contribution: { other: [{ code: label + "-always" }] } }] });
    const m = new PluginManager({ runtime: "renderer", storage: new MemoryStorageBackend() });
    m.extensionPoints.declare({ name: "lang", contributions: { languages: null, other: null } });
    const reg = (id: string, system: boolean) => m.register({ system, manifest: { id, name: id, version: "1.0.0", renderer: "r", permissions: ["ui"], provides: ["language"] }, load: async () => mkDef(id) });
    reg("lang.sys", true);
    reg("lang.third", false);
    await m.startup();
    const codes = () => m.extensionPoints.items<{ code: string }>("lang", "languages").map((x) => x.code);
    expect(m.capabilities()[0]).toMatchObject({ capability: "language", owner: "lang.sys", conflict: true });
    expect(codes()).toEqual(["lang.sys"]); // the system provider wins by default
    expect(m.extensionPoints.items<{ code: string }>("lang", "other").length).toBe(2); // ungated parts of both still work
    await m.setCapabilityOwner("language", "lang.third");
    expect(codes()).toEqual(["lang.third"]);
    await expect(m.setCapabilityOwner("language", "nobody")).rejects.toThrow();
  });
});

describe("4-5 · version & change detection", () => {
  const snap = (over = {}) => ({ id: "a.b", version: "1.0.0", permissions: ["ipc"], dependencies: {}, files: { "dist/main.mjs": "h1", "plugin.json": "p1" }, ...over });
  const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({ id: "a.b", name: "A", version: "1.1.0", permissions: ["ipc"], location: "x", source: "s", ...over });

  it("offers an update for a newer version and asks for confirmation when permissions/dependencies change", () => {
    const a = analyzeUpdate(snap(), entry({ permissions: ["ipc", "network"], dependencies: { "lib.p": "^1.0.0" }, hashes: { "dist/main.mjs": "h2", "plugin.json": "p2", "dist/new.js": "n" } }));
    expect(a).toMatchObject({ status: "update", needsConfirmation: true, permissions: { added: ["network"] }, dependencies: { added: ["lib.p"] } });
    expect(a.files).toEqual({ added: ["dist/new.js"], removed: [], changed: ["dist/main.mjs", "plugin.json"] });
    expect(analyzeUpdate(snap(), entry({ version: "2.0.0" })).major).toBe(true);
  });
  it("does nothing when the version and the files are identical", () => {
    expect(analyzeUpdate(snap(), entry({ version: "1.0.0", hashes: { "dist/main.mjs": "h1", "plugin.json": "p1" } })).status).toBe("up-to-date");
  });
  it("flags — and never silently replaces — different files under the same version", () => {
    const a = analyzeUpdate(snap(), entry({ version: "1.0.0", hashes: { "dist/main.mjs": "TAMPERED", "plugin.json": "p1" } }));
    expect(a).toMatchObject({ status: "inconsistent" });
    expect(a.reasons[0]).toMatch(/differ/);
    expect(analyzeUpdate({ ...snap(), packageSha256: "aa" }, entry({ version: "1.0.0", sha256: "bb" })).status).toBe("inconsistent");
    expect(analyzeUpdate(snap(), entry({ version: "0.9.0" })).status).toBe("downgrade");
  });
  it("collects the release notes between the installed and the offered version", () => {
    const a = analyzeUpdate(snap(), entry({ version: "1.2.0", updates: [{ version: "1.2.0", notes: "B" }, { version: "1.1.0", notes: "A" }, { version: "1.0.0", notes: "old" }, { version: "1.3.0", notes: "future" }] }));
    expect(a.notes.map((n) => n.version)).toEqual(["1.2.0", "1.1.0"]);
  });

  it("an installed plugin shows an update through the API; unchanged ones do not", async () => {
    await put(store(), "up.p", { version: "1.0.0" });
    await put(store(), "same.p", { version: "1.0.0" });
    const { fw } = await mk({}, [new LocalRegistry(store(), "s")]);
    await fw.start();
    await call(fw, "flux.plugins.install", { id: "up.p" });
    await call(fw, "flux.plugins.install", { id: "same.p" });
    await put(store(), "up.p", { version: "1.1.0", permissions: [...PERMS, "clipboard"] });
    await fw.installer.catalog({ refresh: true });
    const r = (await call(fw, "flux.plugins.updates")) as { ok: true; value: CatalogEntry[] };
    expect(r.value.map((e) => e.id)).toEqual(["up.p"]); // same.p: nothing to update
    const an = (await call(fw, "flux.plugins.analyze", { id: "up.p" })) as { value: { status: string; permissions: { added: string[] }; needsConfirmation: boolean } };
    expect(an.value).toMatchObject({ status: "update", needsConfirmation: true, permissions: { added: ["clipboard"] } });
    await fw.stop();
  });
});

describe("6 · a failed update restores the previous version; user data survives", () => {
  it("rolls back when the new version cannot start, keeping the old files and the plugin's stored data", async () => {
    await put(store(), "upd.p", { version: "1.0.0" }, `export default { onActivate(ctx) { ctx.storage.set("k", 1); } };`);
    const { fw } = await mk({}, [new LocalRegistry(store(), "s")]);
    await fw.start();
    await call(fw, "flux.plugins.install", { id: "upd.p" });
    await fw.manager.contextOf("upd.p")!.storage.set("user-data", "keep me");
    await put(store(), "upd.p", { version: "2.0.0" }, `export default { onActivate() { throw new Error("v2 is broken"); } };`);
    await fw.installer.catalog({ refresh: true });
    const r = await call(fw, "flux.plugins.update", { id: "upd.p" });
    expect(r).toMatchObject({ ok: false, error: { message: expect.stringMatching(/rolled back.*v2 is broken/) } });
    expect(fw.manager.info("upd.p")).toMatchObject({ version: "1.0.0", state: "ready" });
    expect(JSON.parse(await fs.readFile(path.join(tmp, "plugins/upd.p/plugin.json"), "utf8")).version).toBe("1.0.0");
    expect(await fw.manager.contextOf("upd.p")!.storage.get("user-data")).toBe("keep me");
    await fw.stop();
  });
});

describe("8-10 · dependencies", () => {
  const e = (id: string, version: string, dependencies: Record<string, string> = {}, over: Partial<CatalogEntry> = {}): CatalogEntry => ({ id, name: id, version, permissions: [], dependencies, location: "x", source: "s", ...over });
  const ctx = (installed: [string, string][], catalog: CatalogEntry[]) => ({ installed: new Map(installed.map(([i, v]) => [i, { version: v }])), candidates: (id: string) => catalog.filter((c) => c.id === id) });

  it("does not reinstall compatible installed dependencies", () => {
    const plan = planInstall(e("app", "1.0.0", { lib: "^1.0.0" }), ctx([["lib", "1.4.0"]], [e("lib", "1.9.0")]));
    expect(plan.ok && plan.steps.map((s) => s.entry.id)).toEqual(["app"]);
  });
  it("adds missing and transitive dependencies, dependencies first, picking the best compatible version", () => {
    const cat = [e("a", "1.0.0", { b: "^1.0.0" }), e("b", "1.0.0"), e("b", "1.5.0", { c: "^2.0.0" }), e("b", "2.0.0"), e("c", "2.1.0")];
    const plan = planInstall(cat[0]!, ctx([], cat));
    expect(plan.steps.map((s) => `${s.entry.id}@${s.entry.version}`)).toEqual(["c@2.1.0", "b@1.5.0", "a@1.0.0"]);
    expect(plan.steps[0]!.reason).toBe("dependency");
  });
  it("reports circular, conflicting, unavailable and incompatible situations clearly", () => {
    const cyc = [e("x", "1.0.0", { y: "*" }), e("y", "1.0.0", { x: "*" })];
    expect(planInstall(cyc[0]!, ctx([], cyc)).problems[0]).toMatchObject({ code: "cycle", message: expect.stringMatching(/x → y → x/) });
    const cat = [e("root", "1.0.0", { p: "^1.0.0", q: "^1.0.0" }), e("p", "1.0.0", { shared: "^1.0.0" }), e("q", "1.0.0", { shared: "^2.0.0" }), e("shared", "1.0.0"), e("shared", "2.0.0")];
    expect(planInstall(cat[0]!, ctx([], cat)).problems.map((p) => p.code)).toContain("conflict");
    expect(planInstall(e("r", "1.0.0", { ghost: "*" }), ctx([], [])).problems[0]).toMatchObject({ code: "unavailable", message: expect.stringMatching(/not available/) });
    expect(planInstall(e("r", "1.0.0", { old: "^2.0.0" }), ctx([["old", "1.0.0"]], [e("old", "1.0.0")])).problems[0]?.code).toBe("conflict");
    expect(planInstall(e("r", "1.0.0", {}, { conflicts: ["other"] }), ctx([["other", "1.0.0"]], [])).problems[0]).toMatchObject({ code: "conflict", message: expect.stringMatching(/incompatible/) });
  });

  it("installs missing dependencies first as one transaction; refuses unavailable ones; never removes shared dependencies", async () => {
    await put(store(), "dep.lib", { version: "1.2.0" });
    await put(store(), "dep.app", { dependencies: { "dep.lib": "^1.0.0" } });
    await put(store(), "dep.broken", { dependencies: { "dep.lib": "^1.0.0" } }, `export default { onActivate() { throw new Error("boom"); } };`);
    await put(store(), "dep.ghost", { dependencies: { "not.there": "^1.0.0" } });
    const { fw } = await mk({}, [new LocalRegistry(store(), "s")]);
    await fw.start();
    const plan = (await call(fw, "flux.plugins.plan", { id: "dep.app" })) as { value: { ok: boolean; steps: { entry: { id: string }; reason: string }[] } };
    expect(plan.value.steps.map((s) => `${s.entry.id}:${s.reason}`)).toEqual(["dep.lib:dependency", "dep.app:requested"]);
    expect(await call(fw, "flux.plugins.install", { id: "dep.ghost" })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/not.there.*not available/) } });
    expect(fw.manager.has("dep.ghost")).toBe(false);
    // failure of the main plugin undoes the dependency too: nothing half-installed
    expect(await call(fw, "flux.plugins.install", { id: "dep.broken" })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/rolled back/) } });
    expect([fw.manager.has("dep.lib"), fw.manager.has("dep.broken")]).toEqual([false, false]);
    expect(await fs.readdir(path.join(tmp, "plugins"))).toEqual([]);
    expect(await call(fw, "flux.plugins.install", { id: "dep.app" })).toMatchObject({ ok: true });
    expect(fw.manager.info("dep.lib").state).toBe("ready");
    expect(fw.manager.info("dep.app").state).toBe("ready");
    // a dependency another plugin needs cannot be uninstalled; the dependent is untouched
    expect(await call(fw, "flux.plugins.uninstall", { id: "dep.lib" })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/required by "dep.app"/) } });
    // already installed → a second dependent does not reinstall it
    const before = (await fs.readFile(path.join(tmp, "plugins/dep.lib/.flux-install.json"), "utf8"));
    await put(store(), "dep.two", { dependencies: { "dep.lib": "^1.0.0" } });
    await fw.installer.catalog({ refresh: true });
    await call(fw, "flux.plugins.install", { id: "dep.two" });
    expect(await fs.readFile(path.join(tmp, "plugins/dep.lib/.flux-install.json"), "utf8")).toBe(before);
    await fw.stop();
  });
});

describe("7 · release notes", () => {
  it("generates updates/<version>.md from the detected changes and keeps what the developer wrote", async () => {
    const dir = await put(tmp, "notes.p", { permissions: ["ipc"], license: "MIT" }, "export default {};", {});
    const r1 = await generateNotes(dir);
    expect(r1).toMatchObject({ created: true, version: "1.0.0" });
    expect(await fs.readFile(path.join(dir, "updates/1.0.0.md"), "utf8")).toContain("First release");
    // 1.0.1: code changed, a file added, a permission added, a dependency added
    await fs.writeFile(path.join(dir, "dist/main.mjs"), "export default { changed: true };");
    await fs.writeFile(path.join(dir, "dist/extra.js"), "1");
    const mf = JSON.parse(await fs.readFile(path.join(dir, "plugin.json"), "utf8"));
    await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify({ ...mf, version: "1.0.1", permissions: ["ipc", "network"], dependencies: { "lib.p": "^1.0.0" } }));
    const r2 = await generateNotes(dir);
    const md = await fs.readFile(r2.file, "utf8");
    expect(md).toMatch(/Files added[\s\S]*`dist\/extra\.js`/);
    expect(md).toMatch(/Files changed[\s\S]*`dist\/main\.mjs`/);
    expect(md).toMatch(/\*\*new:\*\* `network`/);
    expect(md).toMatch(/added `lib\.p`/);
    // manual edits survive regeneration
    await fs.writeFile(r2.file, md.replace("<!-- Write", "Fixed the crash on startup.\n\n<!-- Write"));
    await fs.writeFile(path.join(dir, "dist/extra.js"), "2");
    await generateNotes(dir);
    const again = await fs.readFile(r2.file, "utf8");
    expect(again).toContain("Fixed the crash on startup.");
    expect(again.match(/auto:start/g)).toHaveLength(1);
    // the notes ship with the plugin and reach the details page
    const { fw } = await mk();
    await fs.cp(dir, path.join(tmp, "plugins/notes.p"), { recursive: true });
    await fw.start();
    const d = (await call(fw, "flux.plugins.details", { id: "notes.p" })) as { value: { releaseNotes: { version: string }[] } };
    expect(d.value.releaseNotes.map((n) => n.version)).toEqual(["1.0.1", "1.0.0"]);
    await fw.stop();
  });
});

describe("13-16 · store: no duplicates, pagination, errors", () => {
  const ent = (id: string, over: Partial<CatalogEntry> = {}): CatalogEntry => ({ id, name: id.toUpperCase(), version: "1.0.0", permissions: [], location: "x", source: "s1", ...over });

  it("one entry per plugin id across stores and versions; the first store is the reference; contradictions are reported, not merged", () => {
    const raw = [ent("a", { source: "s1" }), ent("a", { source: "s2" }), ent("a", { version: "1.2.0", source: "s2" }), ent("b", { name: "B1", source: "s1" }), ent("b", { name: "B2", source: "s2" }), ent("c", { source: "s3" }), ent("c", { source: "s3" })];
    const { entries, conflicts } = dedupeEntries(raw, ["s1", "s2", "s3"]);
    expect(entries.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(entries[0]).toMatchObject({ version: "1.2.0", versions: ["1.2.0", "1.0.0"], sources: ["s1", "s2"] });
    expect(entries[1]).toMatchObject({ name: "B1", conflict: ["name"] });
    expect(conflicts).toEqual([{ id: "b", version: "1.0.0", sources: ["s1", "s2"], fields: ["name"] }]);
  });

  it("the catalog served to the UI never repeats a plugin, even when several stores list it", async () => {
    for (const s of ["s1", "s2", "s3"]) for (const id of ["dup.a", "dup.b"]) await put(store(s), id);
    await put(store("s3"), "only.s3");
    const { fw } = await mk({}, ["s1", "s2", "s3"].map((s) => new LocalRegistry(store(s), s)));
    await fw.start();
    const r = (await call(fw, "flux.plugins.catalog", { pageSize: 50 })) as { value: { items: CatalogEntry[]; total: number; totalAll: number } };
    expect(r.value.items.map((i) => i.id).sort()).toEqual(["dup.a", "dup.b", "only.s3"]);
    expect(r.value.items.find((i) => i.id === "dup.a")?.sources).toEqual(["s1", "s2", "s3"]);
    // concurrent callers share one request
    let calls = 0;
    const counting: PluginRegistry = { name: "c", search: async () => (calls++, []), fetch: async () => { throw new Error("n/a"); } };
    const { fw: fw2 } = await mk({}, [counting]);
    await Promise.all([fw2.installer.catalog({ refresh: true }), fw2.installer.catalog(), fw2.installer.catalog()]);
    await fw2.installer.catalog();
    expect(calls).toBe(1);
    await fw.stop();
  });

  it("paginates 47 plugins by 5, 10 or 20 and keeps search and filters consistent with the pages", () => {
    const all = Array.from({ length: 47 }, (_, i) => ent(`p${String(i).padStart(2, "0")}`, { categories: i % 3 === 0 ? ["Tools"] : ["Fun"], pricing: i % 5 === 0 ? { model: "paid", amount: 5 } : undefined, keywords: i < 10 ? ["alpha"] : [] }));
    for (const [size, pages] of [[5, 10], [10, 5], [20, 3]] as const) {
      const first = queryCatalog(all, { pageSize: size });
      expect([first.pages, first.total, first.totalAll, first.items.length]).toEqual([pages, 47, 47, size]);
      expect(queryCatalog(all, { pageSize: size, page: pages }).items.length).toBe(47 - size * (pages - 1));
    }
    const seen = new Set<string>();
    for (let p = 1; p <= 5; p++) queryCatalog(all, { pageSize: 10, page: p }).items.forEach((i) => seen.add(i.id));
    expect(seen.size).toBe(47); // no item lost or repeated across pages
    const tools = queryCatalog(all, { category: "Tools", pageSize: 5 });
    expect([tools.total, tools.pages, tools.totalAll]).toEqual([16, 4, 47]); // total = matching filters, totalAll = whole catalog
    expect(queryCatalog(all, { q: "alpha", category: "Tools", pageSize: 5 }).total).toBe(4);
    expect(queryCatalog(all, { price: "paid", pageSize: 5 }).total).toBe(10);
    expect(queryCatalog(all, { q: "alpha", pageSize: 5, page: 99 }).page).toBe(2); // page clamped after filtering
    expect(queryCatalog(all, { q: "zzz" })).toMatchObject({ total: 0, pages: 1, items: [] });
    expect(paginate([], 3, 10).page).toBe(1);
  });

  it("shows connection errors without hiding the stores that work; fails clearly when every store fails", async () => {
    await put(store("ok"), "ok.p");
    const bad: PluginRegistry = { name: "bad", search: async () => { throw new Error("ENOTFOUND plugins.example.com"); }, fetch: async () => { throw new Error("x"); } };
    const { fw } = await mk({}, [bad, new LocalRegistry(store("ok"), "ok")]);
    await fw.start();
    const r = (await call(fw, "flux.plugins.catalog", {})) as { value: { items: CatalogEntry[]; errors: { source: string; message: string }[] } };
    expect(r.value.items.map((i) => i.id)).toEqual(["ok.p"]);
    expect(r.value.errors).toEqual([{ source: "bad", message: "ENOTFOUND plugins.example.com" }]);
    const { fw: fw2 } = await mk({}, [bad]);
    await fw2.start();
    expect(await call(fw2, "flux.plugins.search", {})).toMatchObject({ ok: false, error: { message: expect.stringMatching(/ENOTFOUND/) } });
    await fw.stop();
    await fw2.stop();
  });

  it("the server resolves what to install from its own catalog: a forged entry from the renderer is ignored", async () => {
    await put(store(), "real.p");
    const { fw } = await mk({}, [new LocalRegistry(store(), "s")]);
    await fw.start();
    expect(await fw.handleInvoke({ channel: "flux.plugins.install", input: { id: "evil.p", entry: { id: "evil.p", location: "https://evil.example/x.tgz", source: "s", version: "1.0.0" } } })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/not found in your stores/) } });
    await fw.stop();
  });
});

describe("paid and free plugins", () => {
  it("a paid plugin needs a valid license (signed by the author, for that plugin, not expired); free ones need nothing", async () => {
    const keys = generateSigningKeyPair();
    await put(store(), "paid.p", { pricing: { model: "paid", amount: 9.99, currency: "EUR", purchaseUrl: "https://shop.example/paid", publicKey: keys.publicKey } });
    await put(store(), "free.p", { pricing: { model: "free" } });
    const { fw } = await mk({}, [new LocalRegistry(store(), "s")]);
    await fw.start();
    expect(await call(fw, "flux.plugins.install", { id: "free.p" })).toMatchObject({ ok: true });
    expect(await call(fw, "flux.plugins.install", { id: "paid.p" })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/paid plugin.*license.*shop\.example/) } });
    const filtered = (await call(fw, "flux.plugins.catalog", { price: "paid" })) as { value: { items: CatalogEntry[] } };
    expect(filtered.value.items.map((i) => i.id)).toEqual(["paid.p"]);
    const wrongPlugin = createLicense(keys.privateKey, { plugin: "other.p" });
    const expired = createLicense(keys.privateKey, { plugin: "paid.p", expires: "2020-01-01" });
    const forged = createLicense(generateSigningKeyPair().privateKey, { plugin: "paid.p" });
    expect(await call(fw, "flux.plugins.license", { id: "free.p", token: wrongPlugin })).toMatchObject({ ok: false });
    for (const token of [wrongPlugin, expired, forged]) expect(await call(fw, "flux.plugins.license", { id: "paid.p", token })).toMatchObject({ ok: false });
    expect(fw.manager.has("paid.p")).toBe(false);
    // the author-signed license unlocks the install; the license is remembered across restarts
    await fs.cp(store("store") + "/paid.p", path.join(tmp, "plugins/paid.p"), { recursive: true });
    await fw.scan();
    expect(fw.manager.info("paid.p").state).not.toBe("ready");
    const good = createLicense(keys.privateKey, { plugin: "paid.p", holder: "Ada" });
    expect(await call(fw, "flux.plugins.license", { id: "paid.p", token: good })).toMatchObject({ ok: true });
    expect(fw.manager.info("paid.p").state).toBe("ready");
    await fw.stop();
    const { fw: again } = await mk({}, []);
    await again.start();
    expect(again.manager.info("paid.p").state).toBe("ready");
    await again.stop();
  });
});
