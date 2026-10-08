import type { RendererFramework } from "fluxplugin/react";
import { DashboardPage } from "./pages/DashboardPage";
import { PluginsPage } from "./pages/PluginsPage";

/** The host's own pages (owner "host"). Plugins add theirs at runtime through the same registry. */
export function registerHostRoutes(framework: RendererFramework): void {
  framework.manager.routes.register({ path: "/", component: DashboardPage, meta: { title: "Dashboard" } }, "host");
  framework.manager.routes.register({ path: "/plugins", component: PluginsPage, meta: { title: "Plugins", breadcrumb: "Plugins" } }, "host");
}
