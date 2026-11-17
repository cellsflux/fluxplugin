#!/usr/bin/env node
// Entry point of the `fluxplugin` command. It only checks that this copy of the package has been built, then starts the CLI.
// (When fluxplugin is installed from npm, dist/ is always there. With a local copy — `file:../fluxplugin` — it must be built first.)
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "..", "dist", "cli.js");

if (!existsSync(cli)) {
  console.error(
    [
      "fluxplugin: this copy of the package has not been built yet (dist/cli.js is missing).",
      "",
      `  Build it once:   cd ${path.resolve(here, "..")}`,
      "                   pnpm install && pnpm build        (or: npm install && npm run build)",
      "",
      "  Or install the published package instead:   npm install fluxplugin",
    ].join("\n"),
  );
  process.exit(1);
}

await import(pathToFileURL(cli).href);
