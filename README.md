# fluxplugin

Plugin architecture for **Electron + React + TypeScript**. Build an app that others can extend — pages, menus,
commands, UI slots, IPC, hooks, permissions, hot reload — and manage plugins with a CLI. One package, like `react`.

```bash
npm create fluxplugin@latest my-app      # or: npx fluxplugin init my-app
cd my-app && npm install
npm run dev:web        # browser mode, no Electron needed
npm run dev            # Electron, plugins hot-reload
npm run plugin:new orders -- -t backend   # scaffold a plugin in ./plugins
npx fluxplugin init my-app --tailwindcss  # …or preconfigure Tailwind
npm run build && npm start
```

## Package map (one install: `npm i fluxplugin`)
| import | runs in | contents |
|---|---|---|
| `fluxplugin` | main + renderer | `definePlugin`, `defineIPC`, `s` schemas, `PluginManager`, registries, types |
| `fluxplugin/main` | Electron main | `MainFramework`, discovery, signatures, installer/registries, `attachElectron`, `serveWeb` |
| `fluxplugin/preload` | preload | `exposeFluxBridge` (sandbox-safe) |
| `fluxplugin/react` | renderer | `PluginProvider`, `PluginSlot`, `PluginRoutes`, hooks, `StyleHost`, `CommandPalette` |
| `fluxplugin/manager-ui` | renderer | ready-made Plugin Manager screen |
| `fluxplugin/cli` | node | programmatic CLI (`run`, `buildHost`, scaffolds) |

CLI (`npx fluxplugin`): `init`, `dev [--web]`, `build`, `start`, `plugin new`, `validate`, `package [--sign-key]`,
`install`, `uninstall`, `enable`, `disable`, `list`, `keygen`, `tailwind`.

## A plugin in 20 lines
```ts
// src/main.ts                                   // src/renderer.tsx
import { definePlugin, defineIPC, s } from "fluxplugin";  import { definePlugin } from "fluxplugin";
export default definePlugin({                      import { usePluginIPC } from "fluxplugin/react";
  ipc: [defineIPC({ name: "orders.count",          const Page = () => { const { data, call } = usePluginIPC("orders.count");
    output: s.object({ n: s.number() }),             return <button onClick={() => call()}>{data?.n ?? "load"}</button>; };
    handler: () => ({ n: 3 }) })],                 export default definePlugin({ routes: [{ path: "/orders", component: Page,
  preload: { orders: { count: "orders.count" } },    meta: { title: "Orders", menu: { label: "Orders" } } }] });
});
```
## What you get out of the box
Custom **title bar + menu bar** that adapts to macOS / Windows / Linux · **search** (commands, pages, plugin providers) ·
**notifications** (bell + toasts) · **themes** (light/dark/system + plugin themes) · icons · command palette · plugin manager with a
store-style page per plugin (icon, screenshots, YouTube video, Markdown description) · plugins shipped as **JavaScript only** ·
optional **Tailwind v4** · permissions, signatures, rollback · a **plugin store** (GitHub by default, or your own) with `fluxplugin publish`.

## New in this version
macOS-style design (translucent materials, grouped lists, switches) · **Settings** screen with **Appearance** and **Language** plugins included ·
fully customizable fonts/size/spacing/accent/themes · collapsible **sidebar with icons and sub-menus** · plugin pages like an app store
(separate screen, screenshots, video, iOS-style Markdown) · images from any source · YouTube/Vimeo/Dailymotion/Loom/Streamable/HTML5 video ·
catalog stores (GitHub repo of plugin folders + one JSON, or any JSON link) · `fluxplugin dist` / `export` / `store build` / `package --all` ·
plugins as standalone projects with their own libraries (`npm create fluxplugin-plugin`).

## Docs
**Documentation website** (React + Vite, searchable): `website/` — `cd website && npm install && npm run dev` · deploy guide in `website/README.md`.

**[STORE](docs/STORE.md)** (develop → publish → install; your own store) · **[CUSTOMIZING](docs/CUSTOMIZING.md)** (add your own APIs, permissions, hooks, title/menu bar, search, notifications, themes, Tailwind) ·
[PLUGIN-AUTHORS](docs/PLUGIN-AUTHORS.md) · [TROUBLESHOOTING](docs/TROUBLESHOOTING.md) · [ARCHITECTURE](docs/ARCHITECTURE.md) · [SECURITY](docs/SECURITY.md) · [RELEASE](docs/RELEASE.md)

## What `fluxplugin init` generates
All application code lives in `src/app`, in layers (`shared` → `main` / `preload` / `renderer`):
```
src/app/
  shared/     constants.ts · types.ts            (depends on nothing)
  main/       index.ts (Electron) · web.ts (browser) · framework.ts · operations.ts · window.ts · paths.ts
  preload/    index.ts
  renderer/   index.tsx · bootstrap.ts · extension-points.ts · routes.ts · App.tsx
              providers/ · shell/ · pages/ · hooks/ · services/ · styles/
plugins/      loaded at startup
```

## Status — read this
* **Verified:** strict typecheck; ~170 automated tests; `publint` clean and `are-the-types-wrong` green (ESM/bundler); the packed tarball installed into a generated
  app (with Tailwind) → typecheck → build (host + 3 plugins) → run in a real browser: collapsing sidebar, language switch via the Language plugin, font/size/accent/theme
  via the Appearance plugin, plugin details as a separate screen with navigation, Markdown tables. Earlier rounds ran the app in real Electron 44 (Linux, Xvfb).
* **Not re-run in this round:** Electron after the latest UI changes, `fluxplugin dist` (electron-builder installers) and `fluxplugin export` end to end, Windows/macOS,
  playback of YouTube/Dailymotion/Loom (embed URLs and sandboxed iframes are asserted, not played), and `fluxplugin publish` against real github.com.
* **Not published** on npm — see `docs/RELEASE.md`. **Security:** plugin `main` code is not sandboxed (see `docs/SECURITY.md`).
* **Not done:** per-plugin process isolation, hosted marketplace service, native (OS) notifications, translations of permission titles (English fallback).
