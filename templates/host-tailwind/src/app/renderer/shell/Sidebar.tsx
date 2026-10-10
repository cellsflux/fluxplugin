import { Link, useMenu } from "fluxplugin/react";
import { useEffect, useState } from "react";

const link =
  "block rounded-lg px-2.5 py-1.5 no-underline text-fg data-[active]:bg-accent data-[active]:text-white";

export function Sidebar() {
  const { items, run } = useMenu("sidebar");
  const [activePath, setActivePath] = useState(() => {
    const hash = window.location.hash.slice(1);
    return hash || window.location.pathname;
  });

  useEffect(() => {
    const updateActivePath = () => {
      setActivePath(window.location.hash.slice(1) || window.location.pathname);
    };

    window.addEventListener("hashchange", updateActivePath);
    window.addEventListener("popstate", updateActivePath);

    return () => {
      window.removeEventListener("hashchange", updateActivePath);
      window.removeEventListener("popstate", updateActivePath);
    };
  }, []);

  const isActive = (path: string) => {
    const normalize = (value: string) =>
      value.replace(/^#/, "").replace(/\/+$/, "") || "/";

    return normalize(activePath) === normalize(path);
  };

  return (
    <aside className="side h-full overflow-hidden border-r border-border bg-surface p-4">
      <nav className="flex flex-col gap-1">
        <Link
          to="/"
          data-active={isActive("/") ? "" : undefined}
          aria-current={isActive("/") ? "page" : undefined}
          className={link}
        >
          Dashboard
        </Link>

        {items.map((i) => (
          <a
            key={i.id}
            className={link}
            data-active={isActive(i.path!) ? "" : undefined}
            aria-current={isActive(i.path!) ? "page" : undefined}
            href={"#" + i.path}
            onClick={(e) => {
              e.preventDefault();
              setActivePath(i.path!);
              run(i);
            }}
          >
            {i.label}
          </a>
        ))}

        <Link
          to="/plugins"
          data-active={isActive("/plugins") ? "" : undefined}
          aria-current={isActive("/plugins") ? "page" : undefined}
          className={link}
        >
          Plugins
        </Link>
      </nav>

      <p className="mt-3 text-xs text-muted">Ctrl/Cmd+K: commands</p>
    </aside>
  );
}
