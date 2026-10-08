# Troubleshooting

## "Electron failed to install correctly"
Your package manager blocked Electron's `postinstall` script (npm 11.16+/12 and pnpm 10 do this by default), so the binary was never
downloaded. **`fluxplugin dev|start` now downloads it automatically.** To make installs clean:
* the generated `package.json` already contains `"allowScripts": { "electron": true, "esbuild": true }` (npm) and
  `"pnpm": { "onlyBuiltDependencies": ["electron", "esbuild"] }` (pnpm);
* with an older project add those, or run `npx fluxplugin doctor`, or `node node_modules/electron/install.js`.
* behind a proxy / in a restricted network: set `ELECTRON_MIRROR`.
* Do **not** run `npm audit fix --force` on an app: it upgrades Electron across major versions on its own.

## `fluxplugin doctor`
Checks Node ≥ 20, the Electron binary (and repairs it), esbuild, the Tailwind CLI and the `allowScripts` setting.

## Linux: "Running as root without --no-sandbox" / SUID sandbox
`fluxplugin dev` detects it and starts Electron with `--no-sandbox`, telling you how to fix it properly:
`sudo chown root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`.

## A plugin is "disabled" and I did not disable it
A plugin that crashes 3 times within a minute (activation or rendering) is disabled **and the state is saved**. Open
**Plugins → Details → Logs** to see why, fix it, then **Enable**.

## Debugging Electron
`FLUXPLUGIN_ELECTRON_ARGS="--remote-debugging-port=9222" npm run dev` then open `http://127.0.0.1:9222` in Chrome. In dev, `F12` toggles DevTools.

## Plugin changes don't show
`fluxplugin dev` rebuilds the host and every plugin in `plugins/` on save; plugins reload in the running app. If you work in a plugin
folder outside the app, run `fluxplugin dev` there. Host changes in `src/app/main` need an app restart.

## Store problems
* **"GitHub rate limit reached"** — anonymous search is limited to 60 requests/hour. Set `GITHUB_TOKEN` (any token) for the app/CLI.
* **My published plugin isn't found** — GitHub topics can take a few minutes; check the repo has the topic `fluxplugin-plugin`, is **public**,
  and the latest release contains both the `.tgz` and the `.fluxplugin.json` files (`fluxplugin publish` creates them).
* **"version X is already published"** — bump `version` in `plugin.json`; releases are immutable.
* **"downloaded package does not match the published checksum"** — the file changed after publishing; publish a new version.
