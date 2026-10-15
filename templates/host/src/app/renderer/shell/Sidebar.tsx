import { SidebarNav, type SidebarEntry } from "fluxplugin/react";

// Host entries. Plugins add theirs between the two groups (routes with meta.menu, or menus.register({ location: "sidebar" })),
// including sub-menus: `meta.menu.parent` or `children`. Labels are translated through `menu.<id>`.
const top: SidebarEntry[] = [{ id: "dashboard", label: "Dashboard", path: "/", icon: "home" }];
const bottom: SidebarEntry[] = [
  { id: "plugins", label: "Plugins", path: "/plugins", icon: "plug" },
  { id: "settings", label: "Settings", path: "/settings", icon: "settings" },
];

export function Sidebar() {
  return <SidebarNav top={top} bottom={bottom} footer={<span>Ctrl/Cmd+K: commands</span>} />;
}
