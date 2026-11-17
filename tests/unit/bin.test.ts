import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-bin-"));
  await fs.mkdir(path.join(tmp, "bin"), { recursive: true });
  await fs.copyFile(path.resolve(__dirname, "../../bin/fluxplugin.js"), path.join(tmp, "bin", "fluxplugin.js"));
  await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }));
});
afterEach(async () => void (await fs.rm(tmp, { recursive: true, force: true })));

const run = (...args: string[]) => spawnSync(process.execPath, [path.join(tmp, "bin", "fluxplugin.js"), ...args], { encoding: "utf8" });

describe("the `fluxplugin` command entry", () => {
  it("explains how to build when this copy of the package has no dist/ (instead of MODULE_NOT_FOUND)", () => {
    const r = run("plugin", "new", "x");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/has not been built yet/);
    expect(r.stderr).toMatch(/pnpm install && pnpm build/);
    expect(r.stderr).not.toMatch(/MODULE_NOT_FOUND/);
  });
  it("starts dist/cli.js with the same arguments once it exists", async () => {
    await fs.mkdir(path.join(tmp, "dist"));
    await fs.writeFile(path.join(tmp, "dist", "cli.js"), 'console.log("cli ran: " + process.argv.slice(2).join(" "));');
    const r = run("plugin", "new", "myplugin", "-t", "dashboard", "--tailwindcss");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("cli ran: plugin new myplugin -t dashboard --tailwindcss");
  });
});
