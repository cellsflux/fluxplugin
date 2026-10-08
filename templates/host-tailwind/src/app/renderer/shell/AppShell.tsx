import { Breadcrumbs, CommandPalette, PluginRoutes, PluginSlot, TitleBar, useKeybindings } from "fluxplugin/react";
import { APP_NAME, SLOTS } from "../../shared/constants";
import { Sidebar } from "./Sidebar";

/** Same structure as the default template, styled with Tailwind utilities. */
export function AppShell() {
  useKeybindings();
  return (
    <div className="app grid min-h-screen grid-rows-[40px_1fr]">
      <TitleBar title={APP_NAME} logo={<PluginSlot name={SLOTS.brandBadges} />} searchPlaceholder="Search commands, pages…" />
      <div className="body grid min-h-0 grid-cols-[220px_1fr]">
        <Sidebar />
        <main className="main max-w-3xl overflow-auto p-6">
          <Breadcrumbs />
          <PluginRoutes />
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}
