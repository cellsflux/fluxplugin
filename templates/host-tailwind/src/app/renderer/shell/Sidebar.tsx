import { Link, useMenu } from "fluxplugin/react";

const link = "block rounded-lg px-2.5 py-1.5 no-underline text-fg data-[active]:bg-accent data-[active]:text-white";

export function Sidebar() {
  const { items, run } = useMenu("sidebar");
  return (
    <aside className="side border-r border-border bg-surface p-4">
      <Link to="/" className={link}>Dashboard</Link>
      {items.map((i) => (
        <a key={i.id} className={link} href={"#" + i.path} onClick={(e) => (e.preventDefault(), run(i))}>{i.label}</a>
      ))}
      <Link to="/plugins" className={link}>Plugins</Link>
      <p className="mt-3 text-xs text-muted">Ctrl/Cmd+K: commands</p>
    </aside>
  );
}
