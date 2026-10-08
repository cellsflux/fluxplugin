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

## Docs
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
* **Verified:** ~140 automated tests and strict typecheck; the packed tarball installed into freshly generated apps (default and
  `--tailwindcss`) → build → run; the generated app run in **real Electron 44** (Linux/Xvfb) *with Electron's install script blocked*
  (auto-download works): custom title bar, plugin menus, search, notifications, theme, plugin page (icon/README), no Node leak
  into the page; a Playwright E2E in a browser with 3 plugins.
* **Store:** publish → search → install is tested end to end against an in-process imitation of the GitHub API (release, asset upload,
  topics, checksum, tampering, rate limit, pruning of `.map`/`.ts`), the GitHub search request shape was confirmed against the real API
  (read-only, HTTP 200), and installing from a custom HTTP store was run through the app's UI. **`fluxplugin publish` itself has not been run
  against real github.com** (no credentials here): try it with `--dry-run` first, then on a throw-away repository.
* **Not verified:** Windows and macOS runs (only Linux was available — the OS-specific branches follow Electron's documented API:
  `hiddenInset` on macOS, `titleBarOverlay` on Windows/Linux); installers/auto-update (electron-builder/forge not set up);
  YouTube playback itself (no internet video in the test environment — the embed URL and sandboxed iframe are asserted).
* **Not published** on npm — see `docs/RELEASE.md`. **Security:** plugin `main` code is not sandboxed (see `docs/SECURITY.md`).
* **Not done:** per-plugin process isolation, hosted marketplace (only `PluginRegistry` + local/HTTP), OS-level (native) notifications.
