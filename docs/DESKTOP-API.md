# FluxAPI — desktop capabilities for the host and every plugin

```tsx
import { useFlux, useCamera, CameraPreview, useOpenedFile, openFile, useAlert, useUnsavedChanges, useBusy } from "fluxplugin/react";

const flux = useFlux("com.acme.notes");            // omit the id in host code. Permissions are checked per plugin in the main process.
await flux.notify({ title: "Saved", body: "note.md" });                       // "notifications"
const [file] = await flux.files.open({ filters: [{ name: "Markdown", extensions: ["md"] }] });   // "filesystem.read" — native dialog
const text = await flux.files.read(file);
const out = await flux.files.save({ defaultName: "copy.md" });                // "filesystem.write" — native dialog
if (out) await flux.files.write(out, text);
await flux.clipboard.writeText("hi");                                         // "clipboard"
await flux.shell.openExternal("https://example.com");                         // "shell" (http/https/mailto only)
const info = await flux.app.info();                                           // name, version, platform, locale
```
Plugins never receive raw paths: a **file ref** is created when the user picks a file (or the OS hands one over) and works **only for that plugin**.
Main-process plugins use `ctx.host.api<DesktopApi>("flux.desktop")`. Camera: `const cam = useCamera("com.acme.scan")` (permission "camera"), `await cam.start()`, `<CameraPreview stream={cam.stream}/>`, `cam.capture(video)` → Blob.
More: `flux.print()` / `flux.printToPDF()` (permission "window"), `flux.tray.set({ tooltip, items: [{ id, label }] })` + `useTrayClick(pluginId, id => …)` (needs `createElectronBackend(electron, { trayIcon })`),
global shortcuts `useShortcut(pluginId, "CommandOrControl+Shift+K", () => …)` (permission "shortcuts"; a shortcut belongs to one plugin, a second plugin asking for it gets `false`).
Enable it in the host: `new MainFramework({ desktop: { backend: createElectronBackend(electron) } })` (the generated app does). Not covered: power/idle monitoring, screen capture — add them the same way (a `DesktopBackend` method + a permission + a channel).

## Files opened by the OS (double-click, "Open with…", drop on the icon, second launch)
`attachFileOpen(fw, app)` (done in the generated app) announces each file. Plugins say how they want to receive it:
```ts
extensions: [{ point: "fileHandlers", contribution: { handlers: [
  { id: "md-editor", title: "Markdown editor", extensions: [".md"], mode: "route", route: "/editor" },      // page; file via useOpenedFile() / ?file=<id>
  { id: "md-preview", title: "Quick preview", extensions: [".md"], mode: "modal", component: PreviewModal },  // sheet: props { file, onClose }
  { id: "csv-import", title: "Import into Orders", extensions: [".csv"], mode: "import", import: async (file) => { … } },
] } }]
```
No handler → an alert; several → an **Open with…** sheet (can be remembered per extension); `openFile(ref, { choose: true })` from your own UI. To make the OS list your app for a file type, add
`fileAssociations` to `electron-builder.yml`; those files then arrive through the same path.

## Alerts, unsaved changes, running actions
`useAlert()` → `alert / confirm / choose` render **in-app sheets** (macOS look); the plugin manager no longer uses `window.alert/confirm`.
`useUnsavedChanges(dirty)` blocks leaving the screen (links, back button, menus) with "Discard your changes?"; `useBusy(running, "Exporting")` and the quit guard
list what would be lost when the window closes; with an update downloading the user can choose **Keep downloading in background** or **Quit anyway**.

## Translations in plugins
Plugins contribute `{ point: "i18n", contribution: { messages: [{ locale: "fr", messages: { save: "Enregistrer" } }] } }`. Keys of ordinary plugins are stored automatically as `<pluginId>:<key>`
(no collisions, no overriding the system); system plugins' keys are the shared vocabulary. In a plugin: `const t = usePluginT("com.acme.notes"); t("save", "Save")` looks up the plugin's own text,
then the system translations, then the fallback. `fr-CA` finds `fr`. READMEs in another language than the interface can be translated automatically (`translate` in `fluxplugin.config.json`:
LibreTranslate / Google / custom endpoint; off by default because the text is sent to the service; declare `"language"` in `plugin.json` for exact detection; the page shows "Translated automatically… Show original").
Everything the host exports (`fluxplugin`, `fluxplugin/react`: UI kit, hooks, FluxAPI, alerts, i18n) is available inside plugins without bundling it again.
