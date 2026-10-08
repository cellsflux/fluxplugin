import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "fluxplugin/cli";

describe("fluxplugin init / plugin new", () => {
  it("scaffolds an app, refuses a non-empty dir, and creates plugins inside ./plugins", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-init-"));
    const cwd = process.cwd();
    try {
      process.chdir(tmp);
      expect(await run(["init", "my-app"])).toBe(0);
      const app = path.join(tmp, "my-app");
      for (const f of ["package.json", "fluxplugin.config.json", "src/app/shared/constants.ts", "src/app/main/index.ts", "src/app/main/web.ts", "src/app/main/framework.ts", "src/app/preload/index.ts", "src/app/renderer/index.tsx", "src/app/renderer/bootstrap.ts", "src/app/renderer/shell/AppShell.tsx", "src/app/renderer/pages/DashboardPage.tsx", "src/app/renderer/index.html", "src/app/main/window.ts", "src/app/main/window-api.ts", "src/app/renderer/menus.ts", "plugins/hello/plugin.json", "plugins/hello/assets/icon.svg", "plugins/hello/README.md"])
        await fs.access(path.join(app, f));
      const pkg = JSON.parse(await fs.readFile(path.join(app, "package.json"), "utf8"));
      expect(pkg.dependencies.fluxplugin).toMatch(/^\^?\d|^file:/);
      expect(pkg.scripts.dev).toBe("fluxplugin dev");
      expect(pkg.allowScripts).toEqual({ electron: true, esbuild: true }); // npm 12 blocks Electron's postinstall otherwise
      expect(pkg.devDependencies.electron).toMatch(/^\^\d+\./);
      expect(pkg.devDependencies.tailwindcss).toBeUndefined();
      // only src/app (plus nothing else) holds source code
      expect((await fs.readdir(path.join(app, "src"))).sort()).toEqual(["app"]);
      expect(await run(["init", "my-app"])).toBe(1); // not empty
      // --tailwindcss: preconfigures Tailwind v4 (deps, entry css, classes in the shell, css link)
      expect(await run(["init", "tw-app", "--tailwindcss"])).toBe(0);
      const tw = path.join(tmp, "tw-app");
      expect(JSON.parse(await fs.readFile(path.join(tw, "package.json"), "utf8")).devDependencies["@tailwindcss/cli"]).toMatch(/^\^4/);
      expect(await fs.readFile(path.join(tw, "src/app/renderer/styles/tailwind.css"), "utf8")).toContain('@import "tailwindcss"');
      expect(await fs.readFile(path.join(tw, "src/app/renderer/index.html"), "utf8")).toContain("tailwind.css");
      expect(await fs.readFile(path.join(tw, "src/app/renderer/shell/Sidebar.tsx"), "utf8")).toContain("bg-surface");
      process.chdir(app);
      expect(await run(["plugin", "new", "orders", "-t", "backend"])).toBe(0);
      await fs.access(path.join(app, "plugins/orders/plugin.json"));
      // `build` needs installed dependencies; it is exercised against a real `npm install` in docs/RELEASE.md.
    } finally {
      process.chdir(cwd);
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
