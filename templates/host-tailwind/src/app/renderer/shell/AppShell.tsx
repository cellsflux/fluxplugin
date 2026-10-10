import {
  Breadcrumbs,
  CommandPalette,
  PluginRoutes,
  PluginSlot,
  TitleBar,
  useKeybindings,
} from "fluxplugin/react";

import { APP_NAME, SLOTS } from "../../shared/constants";
import { Sidebar } from "./Sidebar";

/** App shell with a fixed sidebar and independently scrollable content. */
export function AppShell() {
  useKeybindings();

  return (
    <div className="app grid h-screen grid-rows-[40px_minmax(0,1fr)] overflow-hidden">
      {/* Title bar */}
      <header className="z-50 min-w-0">
        <TitleBar
          title={APP_NAME}
          logo={<PluginSlot name={SLOTS.brandBadges} />}
          searchPlaceholder="Search commands, pages…"
        />
      </header>

      {/* Application body */}
      <div className="body grid min-h-0 min-w-0 grid-cols-[220px_minmax(0,1fr)] overflow-hidden">
        {/* Fixed sidebar: never scrolls with the main content */}
        <aside className="h-full min-h-0 overflow-hidden border-r border-transparent">
          <Sidebar />
        </aside>

        {/* Only this area scrolls */}
        <main className="main min-h-0 min-w-0 overflow-y-auto overflow-x-hidden p-6">
          <div className="mx-auto max-w-3xl">
            <Breadcrumbs />

            <PluginRoutes />
          </div>
        </main>
      </div>

      {/* Command palette */}
      <CommandPalette />
    </div>
  );
}
