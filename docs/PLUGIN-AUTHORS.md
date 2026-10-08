# Plugin authors

## 1. Create
```bash
npx fluxplugin plugin new my-plugin -t dashboard      # basic | dashboard | backend     (add --tailwindcss for Tailwind)
cd plugins/my-plugin
```
You get `plugin.json`, `src/main.ts`, `src/renderer.tsx`, `src/styles/index.css`, `assets/icon.svg` and a detailed `README.md`.

## 2. Develop (TypeScript)
`npx fluxplugin dev` in the app rebuilds on save and the running app reloads your plugin. Imports come from the host,
so there is one React and one runtime: `import { definePlugin, defineIPC, s } from "fluxplugin"` and
`import { usePluginIPC, usePluginState } from "fluxplugin/react"`.

Rules: register everything through `ctx` or the declarative fields (it is cleaned up automatically on disable);
clear timers in `ctx.lifecycle.onDeactivate`; declare **every** permission you use; use `activationEvents`
(`onStartup`, `onCommand:id`, `onRoute:/x`, `onService:x`, `onSlot:x`, `onIPC:x`, `onEvent:x`) to load lazily.

## 3. Describe it (the plugin page)
Fill `plugin.json` and `README.md` — users see them in **Plugins → Details**:
`icon`, `banner`, `screenshots`, `video` (YouTube/Vimeo), `categories`, `keywords`, `links`, `author`, `license`, and a Markdown
README (what it does, how to use it, permissions and why, changelog). See [CUSTOMIZING §7](CUSTOMIZING.md).

## 4. Ship (JavaScript only)
```bash
npx fluxplugin validate .
npx fluxplugin package . --out dist-packages --sign-key epf-signing.private.key
# → com.acme.my-plugin-1.0.0.tgz   contains: plugin.json, dist/, assets/, README.md, LICENSE  — never src/ or .ts files
```
To **publish to the store** (GitHub): `npx fluxplugin publish` — see [STORE.md](STORE.md).
Install: Plugin Manager (*Available*), `npx fluxplugin install <id>`, `install file.tgz`. Updates keep the previous version for rollback.

## 5. What you can do
Pages (`routes`, lazy, guards, layouts) · sidebar/menu-bar entries (`menus`) · commands & shortcuts · dashboard/any **slot**
components · **extension points** (toolbar actions, search providers, themes) · hooks on host operations · events · services ·
main-process IPC + `window.plugins.<ns>` · notifications · settings with auto-generated forms (`config`) · storage · styles.
How the host *offers* these: [CUSTOMIZING](CUSTOMIZING.md). Typed `window.plugins`:
`declare module "fluxplugin" { interface PluginApis { stats: { get(): Promise<Stats> } } }` then `pluginApi("stats").get()`.
