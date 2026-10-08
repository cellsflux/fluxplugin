#!/usr/bin/env node
import { run } from "fluxplugin/cli";
// `npm create fluxplugin@latest my-app` → `fluxplugin init my-app`
process.exit(await run(["init", ...process.argv.slice(2)]));
