// Boot stub (becomes dist/boot.cjs, the package's "main"): loads the newest valid application payload.
// A downloaded update lives in <userData>/app-updates; if it cannot start twice in a row, the bundled version runs again.
import { app } from "electron";
import path from "node:path";
import { resolveBootTarget } from "fluxplugin/main";

const target = resolveBootTarget(path.join(app.getPath("userData"), "app-updates"), __dirname, app.getVersion());
// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.join(target.dir, "main.cjs"));
