import type { RendererFramework } from "fluxplugin/react";

/**
 * The host's own application menu (the bar in the title bar). Plugins add entries to the same registry, either as
 * new top-level menus or as extra children — see docs/CUSTOMIZING.md. Shortcuts shown come from the commands' keybinding.
 */
export function registerHostMenus(framework: RendererFramework): void {
  const { menus, commands } = framework.manager;
  commands.register({ id: "host.palette", title: "Command palette", category: "View", keybinding: "Mod+K", execute: () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true })) }, "host");
  commands.register({ id: "host.reload", title: "Reload window", category: "View", keybinding: "Mod+R", execute: () => location.reload() }, "host");
  commands.register({ id: "host.goHome", title: "Go to dashboard", category: "Go", execute: () => (location.hash = "#/") }, "host");
  commands.register({ id: "host.goPlugins", title: "Manage plugins", category: "Go", execute: () => (location.hash = "#/plugins") }, "host");
  commands.register({ id: "host.sidebar", title: "Toggle sidebar", category: "View", keybinding: "Mod+B", execute: () => window.dispatchEvent(new Event("flux:toggle-sidebar")) }, "host");
  commands.register({ id: "host.goSettings", title: "Settings", category: "Go", keybinding: "Mod+,", execute: () => (location.hash = "#/settings") }, "host");
  commands.register({ id: "host.docs", title: "Documentation", category: "Help", execute: () => void window.open("https://www.npmjs.com/package/fluxplugin", "_blank") }, "host");

  menus.register({ id: "app.go", location: "application", label: "Go", order: 10, children: [
    { id: "app.go.home", label: "Dashboard", command: "host.goHome" },
    { id: "app.go.plugins", label: "Plugins", command: "host.goPlugins" },
    { id: "app.go.settings", label: "Settings", command: "host.goSettings" },
  ] }, "host");
  menus.register({ id: "app.view", location: "application", label: "View", order: 20, children: [
    { id: "app.view.palette", label: "Command palette", command: "host.palette" },
    { id: "app.view.sidebar", label: "Toggle sidebar", command: "host.sidebar" },
    { id: "app.view.sep", label: "", separator: true },
    { id: "app.view.reload", label: "Reload", command: "host.reload" },
  ] }, "host");
  menus.register({ id: "app.help", location: "application", label: "Help", order: 90, children: [{ id: "app.help.docs", label: "Documentation", command: "host.docs" }] }, "host");
}
