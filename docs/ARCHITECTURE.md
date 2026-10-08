# Architecture

**Single source of truth = main process.** `MainFramework` discovers/validates plugins, persists enabled state and permission
grants, owns IPC handlers. The renderer mirrors that via `flux:bootstrap` and runs renderer entries in its own `PluginManager`
(`runtime: "renderer"`). Same `fluxplugin` code runs on both sides.

## Lifecycle (per plugin)
`discovered → validated → loaded → initialized → activated → ready → deactivated → unloaded` (+ `disabled`, `error`).
Every phase has a timeout. A failure rolls back everything the plugin registered (ownership sweep), is logged, and never
reaches other plugins. 3 failures in 60 s auto-disable the plugin (persisted). Dependencies activate first and deactivate last;
cycles, missing deps and version mismatches block activation with a precise reason.

## Lazy activation
`activationEvents`: `onStartup`, `*`, `onCommand:<id>`, `onRoute:<pattern>`, `onEvent:<pattern>`, `onService:<name>`,
`onSlot:<name>`, `onIPC:<name>`. Statically declared `contributes.commands/menus` appear (as proxies) before the plugin loads.

## Extension surface (`PluginContext`)
events (typed, wildcard, priority, cancel) · hooks (`validate/before/around/transform/after/filter`) · commands (palette,
keybindings) · routes (params, lazy, layouts, guards, breadcrumbs, auto menu) · menus · UI slots (`before/after/replace/
append/prepend`) · declarative extension points (host-schema-validated data) · services · IPC (schema-validated, shared
contracts) · preload APIs (data-only, → `window.plugins.<ns>`) · storage · config (schema, defaults, migrations) · state ·
styles (removed on disable) · host APIs (`host.provide`, permission-gated).

## Why `window.plugins` is built in the renderer
`contextBridge` exposes objects once at preload time; plugins come and go at runtime. The preload exposes only `window.__fluxplugin`
(5 functions); the renderer builds the frozen `window.plugins` from the preload manifest on every change.

## Plugin bundles
`fluxplugin build` (esbuild) rewrites `react`, `@epf/*` imports to `globalThis.__FLUXPLUGIN_SHARED__` so there is exactly one
React/runtime instance. Hosts call `installSharedModules({...})` (see `examples/host/src/renderer.tsx`).
Renderer entries load via `fluxplugin://<id>/…` (Electron) or `/@plugins/<id>/…` (web mode); `main`/`plugin.json` are never served.
