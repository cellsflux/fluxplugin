import { definePlugin } from "fluxplugin";
import type { ReactNode } from "react";

const Layout = ({ children }: { children: ReactNode }) => <section className="sp-layout"><header className="sp-head" data-testid="students-layout">Students workspace (plugin layout)</header>{children}</section>;
const Students = () => <div className="sp-card" data-testid="students-page"><h2>Students Pro</h2><p>Guarded route inside a plugin layout. Open the command palette (Ctrl/Cmd+K) to try “Students: New”.</p></div>;
const Badge = () => <span className="sp-badge" data-testid="students-badge">PRO</span>;

export default definePlugin({
  layouts: { "students-layout": Layout },
  routes: [{ path: "/students", component: Students, layout: "students-layout", guards: [() => true], meta: { title: "Students", breadcrumb: "Students", menu: { label: "Students", order: 5 } } }],
  components: [{ slot: "header.badges", component: Badge }],
  extensions: [{ point: "dashboard", contribution: { toolbar: [{ id: "new-student", label: "New student", command: "students.new" }] }, priority: 5 }],
  commands: [{ id: "students.new", title: "New student", category: "Students", keybinding: "Mod+Shift+N", execute: () => (location.hash = "#/students") }],
});
