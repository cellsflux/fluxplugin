import { Breadcrumbs, CommandPalette, PluginRoutes, PluginSlot, TitleBar, useKeybindings } from "fluxplugin/react";
import { APP_NAME, SLOTS } from "../../shared/constants";
import { Sidebar } from "./Sidebar";

/** Whole window: custom title bar (menus, search, theme, notifications) → sidebar + routed content. */
export function AppShell() {
  useKeybindings(); // runs commands bound to keyboard shortcuts (Mod+Shift+R, ...)
  return (
    <div className="app">
      <TitleBar title={APP_NAME} logo={<PluginSlot name={SLOTS.brandBadges} />} searchPlaceholder="Search commands, pages…" />
      <div className="body">
        <Sidebar />
        <main className="main">
          <Breadcrumbs />
          <PluginRoutes />
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}
