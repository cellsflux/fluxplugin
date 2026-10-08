import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "fluxplugin/cli";
import { MainFramework } from "fluxplugin/main";

describe("CLI → build → load in the real main framework", () => {
  it("scaffolds a backend plugin, builds it, loads it and calls its validated IPC endpoint", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-e2e-"));
    const cwd = process.cwd();
    try {
      process.chdir(tmp);
      expect(await run(["create", "plugins/hello-api", "-t", "backend"])).toBe(0);
      const root = path.join(tmp, "plugins/hello-api");
      expect(await run(["build", root])).toBe(0);
      expect(await run(["validate", root])).toBe(0);
      const fw = new MainFramework({ pluginDirs: [path.join(tmp, "plugins")], dataDir: path.join(tmp, "data") });
      await fw.start();
      expect(fw.manager.info("com.example.hello-api").state).toBe("ready");
      const ok = await fw.handleInvoke({ channel: "hello_api.hello", input: { name: "Ada" }, caller: "com.example.hello-api" });
      expect(ok).toMatchObject({ ok: true, value: { message: "Hello Ada from com.example.hello-api" } });
      const bad = await fw.handleInvoke({ channel: "hello_api.hello", input: { name: "" } });
      expect(bad).toMatchObject({ ok: false, error: { code: "FLUX_VALIDATION" } });
      expect(fw.bootstrap().preload["hello_api"]).toBeDefined();
      await fw.stop();
    } finally {
      process.chdir(cwd);
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
