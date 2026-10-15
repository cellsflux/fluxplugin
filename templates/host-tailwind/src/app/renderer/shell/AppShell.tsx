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
          searchPlaceholder="Search commands, pages..."
        />
      </header>

      {/* Application body (the sidebar width follows --flux-sidebar-w: it collapses to an icon rail) */}
      <div className="body grid min-h-0 min-w-0 grid-cols-[var(--flux-sidebar-w,232px)_minmax(0,1fr)] overflow-hidden transition-[grid-template-columns] duration-200">
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
