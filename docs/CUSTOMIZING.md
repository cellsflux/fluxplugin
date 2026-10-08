# Customizing your app and its API

This guide shows, step by step, how to **extend what plugins can do** in your app: add your own APIs, custom
permissions, hooks, a custom title/menu bar, search, notifications, themes, icons and Tailwind.
Everything below lives in the `src/app/` folder that `fluxplugin init` generated.

```
src/app/shared/     names used by both processes            (constants.ts, types.ts)
src/app/main/       Electron side                           (framework.ts, operations.ts, window.ts, window-api.ts)
src/app/renderer/   React side                              (bootstrap.ts, extension-points.ts, menus.ts, shell/, pages/ …)
```

**The mental model.** Your app *offers* extension surfaces; plugins *contribute* to them; nothing is patched.

| You want plugins to… | You offer… | Plugin uses… |
|---|---|---|
| add a screen | nothing (routes are open) | `routes`, `meta.menu` |
| add a button/widget in your UI | a `<PluginSlot name="x" />` | `components: [{ slot: "x", component }]` |
| add *data* to a list (toolbar actions, tabs…) | an extension point + schema | `extensions: [{ point, contribution }]` |
| react to / change what your app does | a hook operation (`hooks.run`) or an event (`events.emit`) | `hooks`, `events` |
| call your app's features | a host API (`manager.provide`) | `ctx.host.api("name")` |
| talk to the main process | an IPC handler | `ipc`, `preload` |

---

## 1. Add your own API for the renderer (host operation)

A *host operation* is a function in the main process that your UI calls. Wrap it in a **hook** so plugins can validate,
change or veto it without touching your code.

**`src/app/shared/constants.ts`** — name it once:
```ts
export const CHANNELS = { createItem: "host.item.create", renameItem: "host.item.rename" } as const;
export const OPERATIONS = { createItem: "item.create", renameItem: "item.rename" } as const;
```

**`src/app/main/operations.ts`** — implement it (input is validated by the schema):
```ts
import { s } from "fluxplugin";
fw.manager.ipc.handle(
  CHANNELS.renameItem,
  (input: { id: string; name: string }) =>
    fw.manager.hooks.run(OPERATIONS.renameItem, input, (i) => db.rename(i.id, i.name)),   // ← plugins can hook here
  "host",
  { input: s.object({ id: s.string(), name: s.string({ min: 1 }) }) },
);
```

**`src/app/main/framework.ts`** — allow the renderer to call it (the renderer can call *only* allow-listed channels):
```ts
allowedRendererChannels: [CHANNELS.createItem, CHANNELS.renameItem],
```

**`src/app/renderer/services/items.ts`** — one place that knows the channel:
```ts
renameItem: (bridge, id, name) => bridge.invoke(CHANNELS.renameItem, { id, name }),
```

A plugin can now change your operation **without** editing your app:
```ts
// plugin main entry
export default definePlugin({
  hooks: [
    { name: "before.item.rename",    handler: (ctx) => { ctx.input = { ...ctx.input, name: ctx.input.name.trim() }; } },
    { name: "validate.item.rename",  handler: (ctx) => { if (ctx.input.name === "admin") ctx.cancel("reserved name"); } },
    { name: "transform.item.rename", handler: (ctx) => ({ ...ctx.result, renamedBy: "my-plugin" }) },
    { name: "after.item.rename",     handler: (ctx) => void audit(ctx.input) },   // errors here never break the operation
  ],
});
```
Hook kinds: `validate` → `before` → `around` (middleware) → *your function* → `transform` → `after`. Plus `filter.<name>`
for value pipelines (`await fw.manager.hooks.filter("menu.items", items)`). Plugins use `priority` to order themselves.

## 2. Give plugins controlled access to your app (host APIs + custom permissions)

Use this when a plugin needs *your* services (database, billing, files…), not just hooks.

```ts
// main/framework.ts
fw.manager.provide(
  "billing",                                              // name
  ({ pluginId }) => ({                                    // factory: called per plugin, so you know who is asking
    invoices: () => db.invoices.list({ requestedBy: pluginId }),
  }),
  "x.billing.read",                                       // permission required (custom permissions start with "x.")
);
```
```jsonc
// plugin.json
{ "permissions": ["x.billing.read"] }
```
```ts
// plugin code
const billing = ctx.host.api<{ invoices(): Promise<Invoice[]> }>("billing");
```
* Without the permission the call throws `PermissionDeniedError` and the plugin is rolled back.
* With `requireApproval: true` (framework.ts) users must approve each permission in **Plugins → Details**; they can revoke later, live.
* Built-in permissions: `ipc services events hooks commands routes menus ui styles storage notifications network filesystem.read filesystem.write database window clipboard shell`.
  *Only the framework's own APIs check them* — `network`, `filesystem.*` etc. are yours to enforce inside your host APIs.

## 3. Events, services and slots

```ts
fw.manager.events.emit("item.created", item, "host");                  // host → plugins (listener: ctx.events.on / `events: []`)
fw.manager.services.register("clock", { now: () => Date.now() }, "host"); // plugins: ctx.services.get("clock")
```
**Slots** (components) — declare by rendering one; plugins inject (`mode`: `before | after | replace | append | prepend`):
```tsx
<PluginSlot name="dashboard.after" props={{ userId }} />            // host
// plugin:  components: [{ slot: "dashboard.after", component: Widget, priority: 10 }]
```
**Extension points** (validated data) — declare in `renderer/extension-points.ts`, read with a hook:
```ts
framework.manager.extensionPoints.declare({ name: "reports", contributions: { exporters: s.object({ id: s.string(), label: s.string(), run: s.fn() }) } });
const exporters = useExtensionItems<Exporter>("reports", "exporters");   // host
// plugin:  extensions: [{ point: "reports", contribution: { exporters: [{ id: "pdf", label: "PDF", run }] } }]
```
Declare points **before** `framework.start()` (bootstrap.ts does). Bad contributions are rejected with a clear message.

---

## 4. The custom title bar & menu bar

`<TitleBar />` replaces Electron's native menu. It adapts to the OS:

| | macOS | Windows / Linux |
|---|---|---|
| native window buttons | traffic lights stay (`titleBarStyle: "hiddenInset"`), the bar leaves 82 px on the left | min/max/close stay on the right (`titleBarOverlay`), the bar leaves their width free via `env(titlebar-area-width)` |
| native menu | minimal one (so ⌘C/⌘V/⌘Q work) | none (`Menu.setApplicationMenu(null)`) |
| shortcut labels | `⌘⇧R` | `Ctrl+Shift+R` |
| overlay colour | n/a | follows the theme (`host.window.setTitleBarOverlay`) |

Layout: **[logo · title · menu bar] [search] [slot `titlebar.right` · theme · notifications 🔔]**.
All of it is in `renderer/shell/AppShell.tsx`; hide or replace parts:
```tsx
<TitleBar title="My App" logo={<img src={logo} />} show={{ search: false }} searchPlaceholder="Find anything…" />
```
or compose your own bar from the parts: `AppMenuBar`, `SearchBox`, `NotificationBell`, `ThemeSwitcher`, `PluginSlot`.

### Menus (File / Edit / View …)
Menus are data in `renderer/menus.ts`. Top-level entries have `children`; items run a **command** (shortcut shown automatically
from the command's `keybinding`) or open a **route**:
```ts
commands.register({ id: "file.new", title: "New project", category: "File", keybinding: "Mod+N", execute: newProject }, "host");
menus.register({ id: "app.file", location: "application", label: "File", order: 0, children: [
  { id: "app.file.new", label: "New project", command: "file.new" },
  { id: "app.file.sep", label: "", separator: true },
  { id: "app.file.settings", label: "Settings", path: "/settings" },
] }, "host");
```
A **plugin** adds a whole menu *or* items to yours (same `id` namespace; use `order` to place it):
```ts
definePlugin({ menus: [{ id: "p.menu", location: "application", label: "Reports", order: 30,
  children: [{ id: "p.menu.run", label: "Run report", command: "p.run" }] }] })
```
Other menu locations: `sidebar`, `toolbar`, `commandPalette`, `context`, `tray`, `settings` (read them with `useMenu("toolbar")`).
Use `when: () => boolean` to hide items dynamically.

### Search bar
The box searches **commands**, **sidebar pages** and anything plugins contribute:
```ts
// plugin
extensions: [{ point: "titlebar", contribution: { searchProviders: [{
  id: "tickets", label: "Tickets",
  search: async (q) => (await api.find(q)).map((t) => ({ id: t.id, title: t.title, subtitle: "ticket", run: () => (location.hash = "#/tickets/" + t.id) })),
}] } }]
```
`Ctrl/Cmd+F` focuses it, `↑ ↓ Enter` navigate. A provider that throws is ignored. Command palette: `Ctrl/Cmd+K`.

### Notifications (bell + toasts)
```ts
ctx.notifications.push({ title: "Export finished", body: "report.pdf", level: "success",       // plugin (permission "notifications")
  actions: [{ label: "Open", command: "reports.open", args: ["report.pdf"] }], timeoutMs: 8000 });   // 0 = bell only
framework.manager.notifications.push({ title: "Saved" });                                           // host
```
Plugins running in the **main process** can push too; they are forwarded to the window. Unread count, history, dismiss and
"clear all" are built in. These are *in-app* notifications; for OS-level ones call Electron's `Notification` from a host operation.

### Your own window operations
`main/window-api.ts` shows the pattern (BrowserWindow needed): register an IPC handler, add its channel to
`allowedRendererChannels`, call it from a `renderer/services/*.ts` file. Example: maximize, always-on-top, zoom.

---

## 5. Themes, colours and icons

Everything is styled with CSS variables, so one switch re-themes the app **and** plugins:

| Variable | Meaning | Variable | Meaning |
|---|---|---|---|
| `--flux-bg` | page background | `--flux-accent` | brand/selection colour |
| `--flux-fg` | text | `--flux-accent-fg` | text on accent |
| `--flux-surface` | bars, cards, panels | `--flux-muted` | secondary text |
| `--flux-border` | lines | `--flux-ok / -warn / -danger` | status colours |

Light / dark / system works out of the box (`<ThemeProvider>` in `providers/AppProviders.tsx`, button in the title bar,
choice persisted). **Plugins can ship themes**:
```ts
extensions: [{ point: "theme", contribution: { themes: [{
  id: "ocean", label: "Ocean", dark: true,
  tokens: { "--flux-bg": "#06202b", "--flux-surface": "#0a2c3a", "--flux-fg": "#e6f6ff", "--flux-border": "#14465a", "--flux-accent": "#22d3ee" },
}] } }]
```
They appear in the title-bar picker. In code: `const { resolved, mode, setMode, themeId, setThemeId, themes } = useTheme();`.

**Icons.** `<Icon name="search|bell|sun|moon|plug|settings|check|close|chevron|play|image|command" />` (24×24, `currentColor`) or
`<Icon d="M…svg path…" />` for your own. Plugins have their own icon: `"icon": "./assets/icon.svg"` in `plugin.json`
(shown in **Plugins**; png / svg / webp / jpg).

## 6. Tailwind

```bash
npx fluxplugin init my-app --tailwindcss          # app preconfigured with Tailwind v4
npx fluxplugin plugin new my-plugin --tailwindcss # plugin with its own compiled utilities
```
* `src/app/renderer/styles/tailwind.css` is compiled by `fluxplugin dev|build` into `dist/tailwind.css`.
* Theme colours are mapped, so utilities follow light/dark/plugin themes: `bg-bg bg-surface text-fg text-muted border-border bg-accent`.
* Dark variant: `dark:…` follows `data-theme="dark"`.
* The app scans `plugins/*/dist` so classes used by bundled plugins are generated.
* Plugins that users install **later** can't be scanned: create them with `--tailwindcss`, which ships a precompiled
  `dist/tailwind.css` (utilities only, no reset) listed in `manifest.styles`. Plugin CSS is added when the plugin activates and
  **removed when it is disabled**.
* Need `npm install -D tailwindcss @tailwindcss/cli` if you add Tailwind to an existing app (then create `tailwind.css`).

---

## 7. The plugin "store page" (image, description, video)

Each plugin gets a page in **Plugins → Details**, driven by `plugin.json` and its `README.md`:
```jsonc
{
  "icon": "./assets/icon.svg",
  "banner": "./assets/banner.png",
  "screenshots": ["./assets/shot-1.png", "./assets/shot-2.png"],
  "video": "https://www.youtube.com/watch?v=YOUR_ID",      // YouTube/Vimeo are embedded; other https links become a button
  "readme": "./README.md",                                  // long description in Markdown (default README.md)
  "categories": ["Productivity"], "keywords": ["reports"],
  "links": { "docs": "https://…", "support": "https://…" },
  "author": "Name", "license": "MIT"
}
```
The README supports headings, lists, tables, code blocks, quotes, **bold**, *italic*, `code`, and https links.
Raw HTML and images inside the README are **not** rendered (safety). Put images in `screenshots`/`banner`.
Your app's CSP must allow the video hosts: `frame-src https://www.youtube-nocookie.com https://player.vimeo.com`
(already in the generated `index.html`).

## 8. Distributed plugins are JavaScript only

Authors work in TypeScript (`src/`), but what is **installed and shipped** is only:
`plugin.json`, `dist/` (built JS/CSS), `assets/`, `README.md`, `LICENSE`, `CHANGELOG`. `fluxplugin package` and every install
through the Plugin Manager / registries copy *only* these files — never `src/`, `.ts/.tsx`, sourcemaps, `node_modules`, configs.
Add `--sign-key` to sign the package (ed25519) and set `trustedKeys` + `requireSignature` in `framework.ts` to refuse the rest.

## 9. Plugin stores (marketplace)

Where *Plugins → Available* looks is your choice: the default GitHub store, your own catalog (HTTP/GitHub/local), or code of your own.
Set it in `fluxplugin.config.json` → `"stores"`. Full guide — developing, publishing, running a store: **[STORE.md](STORE.md)**.
