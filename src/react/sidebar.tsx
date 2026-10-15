import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { MenuLocation, MenuNode } from "../core/index.js";
import { usePluginFramework } from "./components.js";
import { Icon } from "./icons.js";
import { useT } from "./i18n.js";
import { navigate, useLocation } from "./router.js";

interface SidebarCtx {
  collapsed: boolean;
  setCollapsed(v: boolean): void;
  toggle(): void;
  width: number;
}
const Ctx = createContext<SidebarCtx>({ collapsed: false, setCollapsed: () => {}, toggle: () => {}, width: 232 });

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* unavailable */
  }
};

/**
 * Owns the collapsed/expanded state (persisted) and publishes the width as the CSS variable `--flux-sidebar-w`,
 * which the shell's grid uses: `grid-cols-[var(--flux-sidebar-w,232px)_minmax(0,1fr)]`.
 */
export function SidebarProvider({ children, storageKey = "fluxplugin.sidebar", expandedWidth = 232, collapsedWidth = 68 }: { children: ReactNode; storageKey?: string; expandedWidth?: number; collapsedWidth?: number }): React.ReactElement {
  const [collapsed, setCollapsedState] = useState(() => read(storageKey) === "collapsed");
  const width = collapsed ? collapsedWidth : expandedWidth;
  useEffect(() => {
    document.documentElement.style.setProperty("--flux-sidebar-w", `${width}px`);
  }, [width]);
  const setCollapsed = useCallback((v: boolean) => (setCollapsedState(v), write(storageKey, v ? "collapsed" : "expanded")), [storageKey]);
  useEffect(() => {
    // `window.dispatchEvent(new Event("flux:toggle-sidebar"))` toggles it (used by the View menu / Mod+B command).
    const l = () => setCollapsed(!collapsed);
    window.addEventListener("flux:toggle-sidebar", l);
    return () => window.removeEventListener("flux:toggle-sidebar", l);
  }, [collapsed, setCollapsed]);
  const value = useMemo(() => ({ collapsed, setCollapsed, toggle: () => setCollapsed(!collapsed), width }), [collapsed, setCollapsed, width]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useSidebar = (): SidebarCtx => useContext(Ctx);

export interface SidebarEntry {
  id: string;
  label: string;
  path?: string;
  command?: string;
  /** Built-in icon name, an `{ d }` SVG path, or any React node. */
  icon?: unknown;
  badge?: string | number;
  children?: SidebarEntry[];
}

export function renderIcon(icon: unknown, size = 18): ReactNode {
  if (!icon) return <Icon name="grid" size={size} />;
  if (typeof icon === "string") return <Icon name={icon} size={size} />;
  if (React.isValidElement(icon)) return icon;
  if (typeof icon === "object" && icon && "d" in icon) return <Icon d={String((icon as { d: unknown }).d)} size={size} />;
  return <Icon name="grid" size={size} />;
}

const norm = (v: string) => v.replace(/^#/, "").split("?")[0]!.replace(/\/+$/, "") || "/";
const activeFor = (cur: string, path?: string): boolean => !!path && (norm(cur) === norm(path) || (norm(path) !== "/" && norm(cur).startsWith(norm(path) + "/")));
const hasActive = (cur: string, e: SidebarEntry): boolean => activeFor(cur, e.path) || !!e.children?.some((c) => hasActive(cur, c));
const fromNode = (n: MenuNode): SidebarEntry => ({ id: n.id, label: n.label, path: n.path, command: n.command, icon: n.icon, badge: n.badge, children: n.children?.map(fromNode) });

/**
 * Sidebar navigation: host entries (`top` / `bottom`) around the entries plugins add to the `sidebar` menu location.
 * Supports icons, sub-menus (nested `children` or `parent` ids), collapsing to an icon rail (sub-menus become hover flyouts),
 * and active highlighting. Labels of host entries can be translated through their `id` (`menu.<id>`).
 */
export function SidebarNav({ top = [], bottom = [], location = "sidebar", footer }: { top?: SidebarEntry[]; bottom?: SidebarEntry[]; location?: MenuLocation; footer?: ReactNode }): React.ReactElement {
  const fw = usePluginFramework();
  const t = useT();
  const { collapsed, toggle } = useSidebar();
  const cur = useLocation();
  const menus = fw.manager.menus;
  const [version, setVersion] = useState(menus.version);
  useEffect(() => menus.subscribe(() => setVersion(menus.version)), [menus]);
  const plugin = useMemo(() => menus.tree(location).map(fromNode), [menus, location, version]);
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(read("fluxplugin.sidebar.open") ?? "{}");
    } catch {
      return {};
    }
  });
  const setGroup = (id: string, v: boolean) => setOpen((o) => {
    const n = { ...o, [id]: v };
    write("fluxplugin.sidebar.open", JSON.stringify(n));
    return n;
  });
  const go = (e: SidebarEntry) => {
    if (e.command) void fw.manager.commands.execute(e.command).catch((err) => fw.manager.logs.logger("host").error(String(err)));
    else if (e.path) navigate(e.path);
  };
  const label = (e: SidebarEntry, host: boolean) => (host ? t(`menu.${e.id}`, e.label) : e.label);

  const item = (e: SidebarEntry, host: boolean, depth = 0): ReactNode => {
    const kids = e.children ?? [];
    const active = activeFor(cur, e.path);
    const expanded = kids.length > 0 && (open[e.id] ?? hasActive(cur, e));
    const text = label(e, host);
    return (
      <div key={e.id} className="flux-nav-group" data-depth={depth}>
        <a href={"#" + (e.path ?? "")} className="flux-nav" data-active={active || undefined} data-parent-active={(!active && hasActive(cur, e)) || undefined} aria-current={active ? "page" : undefined}
          title={collapsed ? text : undefined} data-testid={"nav-" + e.id}
          onClick={(ev) => {
            ev.preventDefault();
            if (kids.length && !collapsed) setGroup(e.id, !expanded);
            if (e.path || e.command) go(e);
            else if (kids.length && collapsed) go(kids[0]!);
          }}>
          <span className="flux-nav-icon">{renderIcon(e.icon, depth ? 14 : 18)}</span>
          {!collapsed && <span className="flux-nav-label">{text}</span>}
          {!collapsed && e.badge !== undefined && <span className="flux-nav-badge">{e.badge}</span>}
          {!collapsed && kids.length > 0 && <span className="flux-nav-chev" data-open={expanded || undefined}><Icon name="chevronRight" size={16} /></span>}
        </a>
        {!collapsed && expanded && <div className="flux-subnav">{kids.map((k) => item(k, host, depth + 1))}</div>}
        {collapsed && kids.length > 0 && (
          <div className="flux-flyout" role="menu">
            <div className="flux-flyout-title">{text}</div>
            {kids.map((k) => <a key={k.id} href={"#" + (k.path ?? "")} role="menuitem" className="flux-flyout-item" data-active={activeFor(cur, k.path) || undefined} onClick={(ev) => (ev.preventDefault(), go(k))}>{k.label}</a>)}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="flux-side side" data-collapsed={collapsed || undefined} aria-label="Sidebar">
      <nav className="flux-side-nav">
        {top.map((e) => item(e, true))}
        {plugin.length > 0 && <div className="flux-side-sep" />}
        {plugin.map((e) => item(e, false))}
      </nav>
      <div className="flux-side-bottom">
        {bottom.map((e) => item(e, true))}
        {footer && !collapsed && <div className="flux-side-footer">{footer}</div>}
        <button type="button" className="flux-nav flux-nav-toggle" onClick={toggle} title={collapsed ? t("sidebar.expand", "Expand sidebar") : t("sidebar.collapse", "Collapse sidebar")} aria-label={collapsed ? t("sidebar.expand", "Expand sidebar") : t("sidebar.collapse", "Collapse sidebar")} aria-expanded={!collapsed} data-testid="sidebar-toggle">
          <span className="flux-nav-icon"><Icon name="panel" size={18} /></span>
          {!collapsed && <span className="flux-nav-label">{t("sidebar.collapse", "Collapse sidebar")}</span>}
        </button>
      </div>
    </aside>
  );
}
