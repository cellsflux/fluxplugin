import { Breadcrumbs, CommandPalette, PluginRoutes, PluginSlot, TitleBar, useKeybindings } from "fluxplugin/react";
import { APP_NAME, SLOTS } from "../../shared/constants";
import { Sidebar } from "./Sidebar";

/** App shell with a fixed sidebar and independently scrollable content. */
export function AppShell() {
  useKeybindings();

  return (
    <div className="app">
      {/* Title bar */}
      <header className="app-titlebar">
        <TitleBar title={APP_NAME} logo={<PluginSlot name={SLOTS.brandBadges} />} searchPlaceholder="Search commands, pages…" />
      </header>

      {/* Application body */}
      <div className="body">
        {/* Fixed sidebar: never scrolls with the main content (collapses to an icon rail) */}
        <aside className="app-side">
          <Sidebar />
        </aside>

        {/* Only this area scrolls */}
        <main className="main">
          <div className="main-inner">
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
