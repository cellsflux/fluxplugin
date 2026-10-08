import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { MenuItemDefinition, NotificationItem } from "../core/index.js";
import { Icon } from "./icons.js";
import { PluginSlot, useExtensionItems, usePluginFramework } from "./components.js";
import { formatShortcut, useOS } from "./os.js";
import { navigate } from "./router.js";
import { ThemeSwitcher, type SearchProvider, type SearchResult } from "./theme.js";

/* ------------------------------------------------------------------ menu bar */

type Entry = Omit<MenuItemDefinition, "location"> & { location?: MenuItemDefinition["location"] };

/** Application menu (File, Edit, View…) built from `menus` registered with `location: "application"`. Plugins add to it. */
export function AppMenuBar(): React.ReactElement | null {
  const fw = usePluginFramework();
  const os = useOS();
  const menus = fw.manager.menus;
  useSyncExternalStore(menus.subscribe, () => menus.version, () => menus.version);
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("mousedown", off);
    window.addEventListener("keydown", key);
    return () => (window.removeEventListener("mousedown", off), window.removeEventListener("keydown", key));
  }, []);
  const top = menus.items("application");
  if (!top.length) return null;
  const run = (item: Entry) => {
    setOpen(null);
    if (item.command) void fw.manager.commands.execute(item.command, ...(item.args ?? [])).catch((e) => fw.manager.logs.logger("host").error(String(e)));
    else if (item.path) navigate(item.path);
  };
  const shortcut = (item: Entry) => {
    const k = item.command ? fw.manager.commands.get(item.command)?.keybinding : undefined;
    return k ? formatShortcut(k, os) : "";
  };
  return (
    <div className="flux-menubar" role="menubar" ref={ref}>
      {top.map((m) => (
        <div key={m.id} className="flux-menu">
          <button type="button" role="menuitem" className={"flux-tb-btn" + (open === m.id ? " is-open" : "")} aria-haspopup={!!m.children?.length} aria-expanded={open === m.id}
            onClick={() => (m.children?.length ? setOpen(open === m.id ? null : m.id) : run(m))}
            onMouseEnter={() => open && m.children?.length && setOpen(m.id)}>
            {m.label}
          </button>
          {open === m.id && m.children && (
            <ul className="flux-dropdown" role="menu">
              {m.children.map((c) =>
                c.separator ? <li key={c.id} className="flux-sep" role="separator" /> : (
                  <li key={c.id} role="none">
                    <button type="button" role="menuitem" className="flux-dd-item" onClick={() => run(c)}>
                      <span>{c.label}</span>
                      <kbd>{shortcut(c)}</kbd>
                    </button>
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------- search */

/** Search box: commands, pages, and results from `titlebar.searchProviders` contributed by plugins. */
export function SearchBox({ placeholder = "Search…" }: { placeholder?: string }): React.ReactElement {
  const fw = usePluginFramework();
  const providers = useExtensionItems<SearchProvider>("titlebar", "searchProviders");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [idx, setIdx] = useState(0);
  const [focus, setFocus] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && !e.shiftKey && (e.preventDefault(), input.current?.focus());
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  useEffect(() => {
    const query = q.trim();
    if (!query) return setResults((prev) => (prev.length ? [] : prev));
    let live = true;
    (async () => {
      const lower = query.toLowerCase();
      const own: SearchResult[] = [
        ...fw.manager.commands.palette(query).slice(0, 5).map((c) => ({ id: "cmd:" + c.id, title: c.title, subtitle: c.category, group: "Commands", run: () => void fw.manager.commands.execute(c.id) })),
        ...fw.manager.menus.items("sidebar").filter((m) => m.path && m.label.toLowerCase().includes(lower)).map((m) => ({ id: "page:" + m.id, title: m.label, group: "Pages", run: () => navigate(m.path!) })),
      ];
      const extra = await Promise.all(providers.map(async (p) => { try { return ((await p.search(query)) ?? []).map((r) => ({ ...r, group: r.group ?? p.label })); } catch { return []; } }));
      if (live) (setResults([...own, ...extra.flat()].slice(0, 12)), setIdx(0));
    })();
    return () => { live = false; };
  }, [q, fw, providers]);
  const go = (r?: SearchResult) => { if (!r) return; setQ(""); input.current?.blur(); void r.run(); };
  return (
    <div className="flux-search" data-testid="searchbox">
      <Icon name="search" />
      <input ref={input} value={q} placeholder={placeholder} aria-label="Search" onChange={(e) => setQ(e.target.value)} onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 120)}
        onKeyDown={(e) => { if (e.key === "ArrowDown") (e.preventDefault(), setIdx((i) => Math.min(i + 1, results.length - 1))); else if (e.key === "ArrowUp") (e.preventDefault(), setIdx((i) => Math.max(i - 1, 0))); else if (e.key === "Enter") go(results[idx]); else if (e.key === "Escape") (setQ(""), input.current?.blur()); }} />
      {focus && q.trim() && (
        <ul className="flux-dropdown flux-search-results" role="listbox">
          {results.length === 0 && <li className="flux-empty">No results</li>}
          {results.map((r, i) => (
            <li key={r.id} role="option" aria-selected={i === idx}>
              {(i === 0 || results[i - 1]!.group !== r.group) && <div className="flux-group">{r.group}</div>}
              <button type="button" className={"flux-dd-item" + (i === idx ? " is-active" : "")} onMouseDown={(e) => (e.preventDefault(), go(r))}>
                <span>{r.title}</span>{r.subtitle && <small>{r.subtitle}</small>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- notifications */

function useNotifications() {
  const { manager } = usePluginFramework();
  const n = manager.notifications;
  useSyncExternalStore(n.subscribe, () => n.version, () => n.version);
  return n;
}

export function NotificationBell(): React.ReactElement {
  const fw = usePluginFramework();
  const center = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", off);
    return () => window.removeEventListener("mousedown", off);
  }, []);
  const unread = center.unread;
  return (
    <div className="flux-bell" ref={ref}>
      <button type="button" className="flux-tb-btn" aria-label="Notifications" data-testid="bell" onClick={() => (setOpen(!open), !open && center.markRead())}>
        <Icon name="bell" />
        {unread > 0 && <span className="flux-badge" data-testid="bell-count">{unread}</span>}
      </button>
      {open && (
        <div className="flux-dropdown flux-notif-panel" role="dialog" aria-label="Notifications">
          <div className="flux-notif-head"><strong>Notifications</strong><button type="button" className="flux-link" onClick={() => center.clear()}>Clear all</button></div>
          {center.list().length === 0 && <div className="flux-empty">You're all caught up</div>}
          {center.list().map((n: NotificationItem) => (
            <div key={n.id} className={"flux-notif flux-" + n.level}>
              <div className="flux-notif-main"><strong>{n.title}</strong>{n.body && <p>{n.body}</p>}<small>{n.owner} · {new Date(n.time).toLocaleTimeString()}</small></div>
              <div className="flux-notif-actions">
                {n.actions.map((a) => <button key={a.label} type="button" className="flux-link" onClick={() => void fw.manager.commands.execute(a.command, ...(a.args ?? []))}>{a.label}</button>)}
                <button type="button" className="flux-link" aria-label="Dismiss" onClick={() => center.dismiss(n.id)}><Icon name="close" size={12} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Transient toasts for new notifications (top-right, under the title bar). */
export function ToastHost(): React.ReactElement {
  const { manager } = usePluginFramework();
  const [toasts, setToasts] = useState<NotificationItem[]>([]);
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const show = (n: NotificationItem, remaining = n.timeoutMs): void => {
      if (n.timeoutMs <= 0 || remaining <= 0) return;
      setToasts((t) => [n, ...t.filter((x) => x.id !== n.id)].slice(0, 4));
      timers.push(setTimeout(() => setToasts((t) => t.filter((x) => x.id !== n.id)), remaining));
    };
    // Notifications emitted while the app was starting (before this component mounted) still deserve a toast.
    for (const n of [...manager.notifications.list()].reverse()) if (!n.read) show(n, n.timeoutMs - (Date.now() - n.time));
    const sub = manager.notifications.onPush((n) => show(n));
    return () => (sub.dispose(), timers.forEach(clearTimeout));
  }, [manager]);
  return (
    <div className="flux-toasts" aria-live="polite" data-testid="toasts">
      {toasts.map((n) => <div key={n.id} className={"flux-toast flux-" + n.level} role="status"><strong>{n.title}</strong>{n.body && <span> {n.body}</span>}</div>)}
    </div>
  );
}

/* ------------------------------------------------------------------ title bar */

export interface TitleBarProps {
  title?: string;
  logo?: ReactNode;
  searchPlaceholder?: string;
  /** Hide parts you do not need. */
  show?: { menu?: boolean; search?: boolean; notifications?: boolean; theme?: boolean };
}

/**
 * Custom window title bar that adapts to the OS: macOS keeps the native traffic lights (space is reserved on the left),
 * Windows/Linux keep native window buttons through the window-controls overlay (space reserved on the right).
 * Layout: [logo · title · menu bar] [search] [slot titlebar.right · theme · notifications].
 */
export function TitleBar({ title, logo, searchPlaceholder, show }: TitleBarProps): React.ReactElement {
  const os = useOS();
  const electron = typeof window !== "undefined" && !!(window as unknown as { __fluxplugin?: unknown }).__fluxplugin;
  const s = { menu: true, search: true, notifications: true, theme: true, ...show };
  const brand = useMemo(() => <div className="flux-brand">{logo}{title && <span>{title}</span>}</div>, [logo, title]);
  return (
    <header className="flux-titlebar" data-os={os} data-electron={electron || undefined} data-testid="titlebar">
      <div className="flux-tb-left">{brand}{s.menu && <AppMenuBar />}<PluginSlot name="titlebar.left" /></div>
      <div className="flux-tb-center">{s.search && <SearchBox placeholder={searchPlaceholder} />}</div>
      <div className="flux-tb-right"><PluginSlot name="titlebar.right" />{s.theme && <ThemeSwitcher />}{s.notifications && <NotificationBell />}</div>
    </header>
  );
}
