import { Link, useMenu } from "fluxplugin/react";

export function Sidebar() {
  const { items, run } = useMenu("sidebar"); // entries added by plugins (routes with meta.menu, or menus.register)
  return (
    <aside className="side">
      <Link to="/">Dashboard</Link>
      {items.map((i) => (
        <a key={i.id} href={"#" + i.path} onClick={(e) => (e.preventDefault(), run(i))}>
          {i.label}
        </a>
      ))}
      <Link to="/plugins">Plugins</Link>
      <p className="hint">Ctrl/Cmd+K: commands</p>
    </aside>
  );
}
