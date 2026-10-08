// Browser entry: `fluxplugin dev --web` (no Electron needed).
import path from "node:path";
import { serveWeb } from "fluxplugin/main";
import { APP_NAME } from "../shared/constants";
import { createFramework } from "./framework";

const root = process.env["FLUXPLUGIN_PROJECT"] ?? process.cwd();
const fw = createFramework({
  pluginDirs: [path.join(root, "plugins")],
  dataDir: path.join(root, ".flux-data"),
  dev: true,
  assetUrl: (id, rel) => "/@plugins/" + id + "/" + rel.replace("./", ""),
});
await fw.start();
const srv = await serveWeb(fw, { distDir: path.join(root, "dist"), port: Number(process.env["PORT"] ?? 5173) });
console.log(APP_NAME + " -> http://127.0.0.1:" + srv.port);
