import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { run } from "fluxplugin/cli";
import { publishPlugin, parseGitHubRepo } from "../../src/cli/publish";
import { storeAdd, storeInit } from "../../src/cli/store";
import { packagePlugin } from "../../src/cli/package";
import { GitHubRegistry, HttpRegistry, PluginInstaller, createRegistries, createTarGz, readTarGz, DEFAULT_STORE } from "fluxplugin/main";
import { startFakeGitHub } from "../helpers/fake-github";

let tmp: string;
let cwd: string;
let gh: Awaited<ReturnType<typeof startFakeGitHub>>;
const logs: string[] = [];
const log = (m: string) => void logs.push(m);

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-store-"));
  cwd = process.cwd();
  process.chdir(tmp);
  gh = await startFakeGitHub();
  logs.length = 0;
});
afterEach(async () => {
  process.chdir(cwd);
  await gh.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Scaffolds a real plugin with the CLI and points its manifest at a (fake) GitHub repository. */
async function makePlugin(name = "pub-plug", repo = "acme/pub-plug", version = "1.0.0"): Promise<string> {
  expect(await run(["plugin", "new", name, "-t", "backend"])).toBe(0);
  const root = path.join(tmp, name);
  const mf = JSON.parse(await fs.readFile(path.join(root, "plugin.json"), "utf8"));
  mf.repository = `https://github.com/${repo}`;
  mf.version = version;
  await fs.writeFile(path.join(root, "plugin.json"), JSON.stringify(mf, null, 2));
  gh.addRepo(repo, 3);
  return root;
}
const opts = () => ({ token: "tok", apiBase: gh.url, log });

describe("publish → search → install (GitHub topic store)", () => {
  it("publishes a release with package + descriptor, tags the repo, and the store can find and install it", async () => {
    const root = await makePlugin();
    const r = await publishPlugin(root, opts());
    expect(r).toMatchObject({ repo: "acme/pub-plug", version: "1.0.0", id: "com.example.pub-plug" });
    expect(gh.repos.get("acme/pub-plug")!.topics).toContain("fluxplugin-plugin");
    const assets = gh.repos.get("acme/pub-plug")!.releases[0]!.assets.map((a) => a.name).sort();
    expect(assets).toEqual(["com.example.pub-plug-1.0.0.fluxplugin.json", "com.example.pub-plug-1.0.0.tgz"]);

    // the published package contains runtime files only: no sourcemaps, no TypeScript, no src/
    const tgz = gh.repos.get("acme/pub-plug")!.releases[0]!.assets.find((a) => a.name.endsWith(".tgz"))!.data;
    const names = (await readTarGz(tgz)).filter((e) => e.type === "file").map((e) => e.name.replace(/^package\//, ""));
    expect(names).toEqual(expect.arrayContaining(["plugin.json", "dist/main.mjs", "dist/renderer.js", "assets/icon.svg", "README.md"]));
    expect(names.filter((n) => /\.(map|tsx?)$/.test(n) || n.startsWith("src/"))).toEqual([]);
    const main = (await readTarGz(tgz)).find((e) => e.name.endsWith("dist/main.mjs"))!.data.toString();
    expect(main).not.toContain("sourceMappingURL");

    const store = new GitHubRegistry({ apiBase: gh.url, rawBase: gh.rawBase });
    const found = await store.search();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: "com.example.pub-plug", version: "1.0.0", stars: 3, homepage: "https://github.com/acme/pub-plug" });
    expect(found[0]!.permissions).toContain("ipc");

    const plugins = path.join(tmp, "installed");
    const inst = new PluginInstaller(plugins, path.join(tmp, "bk"), [store]);
    expect(await inst.install(found[0]!)).toMatchObject({ id: "com.example.pub-plug", version: "1.0.0" });
    const installed = (await fs.readdir(path.join(plugins, "com.example.pub-plug"), { recursive: true })) as string[];
    expect(installed.filter((f) => /\.(map|tsx?)$/.test(f) || f.startsWith("src"))).toEqual([]);
    expect(installed).toContain("plugin.json");
  });

  it("refuses to publish the same version twice, and says what to do", async () => {
    const root = await makePlugin();
    await publishPlugin(root, opts());
    await expect(publishPlugin(root, opts())).rejects.toThrow(/already published.*Bump "version"/);
  });

  it("guards: dry-run does no network, missing token / repo / metadata give actionable errors", async () => {
    const root = await makePlugin();
    await publishPlugin(root, { ...opts(), dryRun: true });
    expect(gh.state.requests).toEqual([]);
    expect(logs.join("\n")).toMatch(/\[dry run\] would create release v1.0.0/);
    await expect(publishPlugin(root, { apiBase: gh.url, log, token: undefined })).rejects.toThrow(/no GitHub token/);
    await expect(publishPlugin(root, { ...opts(), token: "wrong" })).rejects.toThrow(/401|cannot write/);
    const mf = JSON.parse(await fs.readFile(path.join(root, "plugin.json"), "utf8"));
    mf.repository = "https://github.com/YOUR_NAME/pub-plug";
    await fs.writeFile(path.join(root, "plugin.json"), JSON.stringify(mf));
    await expect(publishPlugin(root, { ...opts(), dryRun: true })).rejects.toThrow(/no GitHub repository/);
    delete mf.icon;
    mf.repository = "https://github.com/acme/pub-plug";
    await fs.writeFile(path.join(root, "plugin.json"), JSON.stringify(mf));
    await expect(publishPlugin(root, { ...opts(), dryRun: true })).rejects.toThrow(/"icon" is missing/);
  });

  it("a tampered release asset is rejected by the checksum; a package without checksum is refused", async () => {
    const root = await makePlugin();
    await publishPlugin(root, opts());
    const store = new GitHubRegistry({ apiBase: gh.url, rawBase: gh.rawBase });
    const [entry] = await store.search();
    const rel = gh.repos.get("acme/pub-plug")!.releases[0]!;
    rel.assets.find((a) => a.name.endsWith(".tgz"))!.data = Buffer.from("not the published bytes");
    await expect(store.fetch(entry!, path.join(tmp, "x1"))).rejects.toThrow(/does not match the published checksum/);
    await expect(store.fetch({ ...entry!, sha256: undefined }, path.join(tmp, "x2"))).rejects.toThrow(/no checksum/);
  });

  it("sources and sourcemaps in a careless/malicious package are pruned at install", async () => {
    const pkgDir = path.join(tmp, "evil");
    await fs.mkdir(path.join(pkgDir, "dist"), { recursive: true });
    await fs.mkdir(path.join(pkgDir, "src"), { recursive: true });
    await fs.writeFile(path.join(pkgDir, "plugin.json"), JSON.stringify({ id: "com.x.sloppy", name: "S", version: "1.0.0", main: "./dist/main.mjs" }));
    for (const [f, c] of [["dist/main.mjs", "export default {}"], ["dist/main.mjs.map", "{}"], ["src/main.ts", "secret"], ["dist/helper.ts", "x"], ["dist/types.d.ts", "export {}"]]) await fs.writeFile(path.join(pkgDir, f!), c!);
    const buf = await createTarGz(pkgDir);
    gh.addRepo("acme/sloppy");
    const repo = gh.repos.get("acme/sloppy")!;
    repo.topics = ["fluxplugin-plugin"];
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    repo.releases.push({ id: 99, tag: "v1.0.0", assets: [{ name: "com.x.sloppy-1.0.0.tgz", data: buf }, { name: "com.x.sloppy-1.0.0.fluxplugin.json", data: Buffer.from(JSON.stringify({ id: "com.x.sloppy", version: "1.0.0", file: "com.x.sloppy-1.0.0.tgz", sha256: sha })) }] });
    const store = new GitHubRegistry({ apiBase: gh.url });
    const inst = new PluginInstaller(path.join(tmp, "p"), path.join(tmp, "b"), [store]);
    await inst.install((await store.search())[0]!);
    const files = ((await fs.readdir(path.join(tmp, "p/com.x.sloppy"), { recursive: true })) as string[]).sort();
    expect(files).toEqual(["dist", "dist/main.mjs", "dist/types.d.ts", "plugin.json"]);
  });

  it("explains GitHub's rate limit, refuses non-https hosts, and the default store is the GitHub topic store", async () => {
    gh.state.rateLimited = true;
    await expect(new GitHubRegistry({ apiBase: gh.url }).search()).rejects.toThrow(/rate limit.*GITHUB_TOKEN/);
    await expect(new GitHubRegistry({ apiBase: "http://example.com" }).search()).rejects.toThrow(/non-https/);
    const [def] = createRegistries();
    expect(def!.name).toBe("github:topic/fluxplugin-plugin");
    expect(DEFAULT_STORE).toEqual({ type: "github", topic: "fluxplugin-plugin" });
  });

  it("CLI: `fluxplugin install <id>` / `search` use the stores from fluxplugin.config.json", async () => {
    await publishPlugin(await makePlugin(), opts());
    // an app folder whose config points at the fake GitHub through a catalog store served from raw files
    const app = path.join(tmp, "app");
    await fs.mkdir(app);
    const out = path.join(tmp, "store");
    await storeInit(out);
    const pkg = await packagePlugin(path.join(tmp, "pub-plug"), { out: path.join(tmp, "pkgs"), log });
    await storeAdd(pkg.file, out, `${gh.rawBase}/acme/store/HEAD/`);
    for (const f of await fs.readdir(out)) gh.raw.set(`acme/store/HEAD/${f}`, await fs.readFile(path.join(out, f)));
    await fs.writeFile(path.join(app, "fluxplugin.config.json"), JSON.stringify({ pluginsDir: "plugins", stores: [{ type: "http", url: `${gh.rawBase}/acme/store/HEAD/` }] }));
    process.chdir(app);
    expect(await run(["install", "com.example.pub-plug"])).toBe(0);
    await fs.access(path.join(app, "plugins/com.example.pub-plug/plugin.json"));
    expect(await run(["install", "com.example.nope"])).toBe(1);
    expect(await run(["search", "pub"])).toBe(0);
  });
});

describe("your own store (store init / add)", () => {
  it("builds an index.json that HTTP and GitHub-catalog stores can serve and install from", async () => {
    const root = await makePlugin("my-tool", "acme/my-tool", "2.1.0");
    const pkg = await packagePlugin(root, { out: path.join(tmp, "pkgs"), log });
    const store = path.join(tmp, "my-store");
    await storeInit(store);
    await expect(storeInit(store)).rejects.toThrow(/already exists/);
    const added = await storeAdd(pkg.file, store, "https://plugins.acme.com/");
    expect(added).toMatchObject({ id: "com.example.my-tool", version: "2.1.0", sha256: pkg.sha256 });
    const idx = JSON.parse(await fs.readFile(path.join(store, "index.json"), "utf8"));
    expect(idx.plugins[0]).toMatchObject({ id: "com.example.my-tool", url: "https://plugins.acme.com/com.example.my-tool-2.1.0.tgz", sha256: pkg.sha256 });

    // serve the folder and use it both as an "http" store and as a "github" catalog store
    await storeAdd(pkg.file, store); // relative urls (for hosting under any base)
    for (const f of await fs.readdir(store)) gh.raw.set(`acme/store/HEAD/${f}`, await fs.readFile(path.join(store, f)));
    const http = new HttpRegistry(`${gh.rawBase}/acme/store/HEAD/`);
    const catalog = new GitHubRegistry({ repo: "acme/store", rawBase: gh.rawBase, apiBase: gh.url });
    for (const reg of [http, catalog]) {
      const [entry] = (await reg.search("tool")).filter((e) => e.location.startsWith(gh.rawBase));
      expect(entry).toMatchObject({ id: "com.example.my-tool", version: "2.1.0" });
      const inst = new PluginInstaller(path.join(tmp, "plug-" + reg.name.slice(0, 4)), path.join(tmp, "bk-" + reg.name.slice(0, 4)), [reg]);
      if (reg === catalog) (entry as { sha256?: string }).sha256 = entry!.sha256;
      if (reg === http) await expect(inst.install(entry!)).resolves.toMatchObject({ id: "com.example.my-tool" });
      else await expect(catalog.fetch(entry!, path.join(tmp, "catalog-out"))).resolves.toMatchObject({ id: "com.example.my-tool" });
    }
  });

  it("store add refuses packages that contain sources or sourcemaps", async () => {
    const dir = path.join(tmp, "bad");
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify({ id: "com.x.bad", name: "B", version: "1.0.0", main: "./dist/m.js" }));
    await fs.writeFile(path.join(dir, "dist/m.js.map"), "{}");
    const f = path.join(tmp, "bad.tgz");
    await fs.writeFile(f, await createTarGz(dir));
    await expect(storeAdd(f, path.join(tmp, "s"))).rejects.toThrow(/sources\/sourcemaps/);
  });
});

describe("helpers", () => {
  it("parses GitHub repo references", () => {
    expect(parseGitHubRepo("https://github.com/acme/tool.git")).toBe("acme/tool");
    expect(parseGitHubRepo("git@github.com:acme/tool.git")).toBe("acme/tool");
    expect(parseGitHubRepo("acme/tool")).toBe("acme/tool");
    expect(parseGitHubRepo("https://gitlab.com/acme/tool")).toBeUndefined();
    expect(parseGitHubRepo(undefined)).toBeUndefined();
  });
});
