#!/usr/bin/env node
import { run } from "fluxplugin/cli";
// `npm create fluxplugin-plugin my-plugin` → `fluxplugin plugin new my-plugin --standalone`
process.exit(await run(["plugin", "new", ...process.argv.slice(2), "--standalone"]));
