import { SettingsPage, type RendererFramework } from "fluxplugin/react";
import { registerPluginManagerRoutes } from "fluxplugin/manager-ui";
import { DashboardPage } from "./pages/DashboardPage";

/** The host's own pages (owner "host"). Plugins add theirs at runtime through the same registry. */
export function registerHostRoutes(framework: RendererFramework): void {
  const routes = framework.manager.routes;
  routes.register({ path: "/", component: DashboardPage, meta: { title: "Dashboard" } }, "host");
  // Plugin manager: list → /plugins/:id (installed) → /plugins/store/:id (store listing). Each opens in its own screen.
  registerPluginManagerRoutes(framework);
  // Settings: sections come from the host and from plugins (Appearance, Language…).
  routes.register({ path: "/settings", component: SettingsPage, meta: { title: "Settings", breadcrumb: "Settings" } }, "host");
  routes.register({ path: "/settings/:section", component: SettingsPage, meta: { breadcrumb: (p) => p["section"] ?? "" } }, "host");
}
