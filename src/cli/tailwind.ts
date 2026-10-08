import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Finds `@tailwindcss/cli` (Tailwind v4) from the given folders (a plugin folder usually has no node_modules: the app's is used). */
export function resolveTailwindCli(startDirs: string[]): string | undefined {
  for (const dir of startDirs) {
    try {
      const pj = createRequire(path.join(dir, "package.json")).resolve("@tailwindcss/cli/package.json");
      const pkg = JSON.parse(readFileSync(pj, "utf8")) as { bin?: string | Record<string, string> };
      const rel = typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin ?? {})[0];
      if (rel) return path.join(path.dirname(pj), rel);
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/** Compiles a Tailwind entry CSS to `output`. With `watch` it keeps running and returns a function that stops it. */
export function compileTailwind(opts: { cwd: string; input: string; output: string; watch?: boolean; searchFrom?: string[] }, log: (m: string) => void = console.log): () => void {
  const cli = resolveTailwindCli([opts.cwd, ...(opts.searchFrom ?? []), process.cwd()]);
  if (!cli || !existsSync(cli)) throw new Error('Tailwind is not installed: run "npm install -D tailwindcss @tailwindcss/cli"');
  const args = [cli, "-i", opts.input, "-o", opts.output];
  if (!opts.watch) {
    const r = spawnSync(process.execPath, args, { cwd: opts.cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`tailwind failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ")}`);
    log(`tailwind → ${path.relative(opts.cwd, opts.output)}`);
    return () => {};
  }
  const child = spawn(process.execPath, [...args, "--watch=always"], { cwd: opts.cwd, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr?.on("data", (d: Buffer) => /error/i.test(String(d)) && log("tailwind: " + String(d).trim()));
  log(`tailwind watching ${path.relative(opts.cwd, opts.input)}`);
  return () => void child.kill();
}
