import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { s } from "../core/index.js";
import { Icon } from "./icons.js";
import { usePluginFramework, useExtensionItems } from "./components.js";
import type { RendererFramework } from "./runtime.js";

export type ThemeMode = "light" | "dark" | "system";
export interface ThemeDefinition {
  id: string;
  label: string;
  /** Whether this theme is dark (drives `data-theme` and native overlay colours). */
  dark?: boolean;
  /** CSS custom properties, e.g. `{ "--flux-accent": "#e11d48", "--flux-bg": "#fff" }`. */
  tokens: Record<string, string>;
}
export interface SearchResult {
  id: string;
  title: string;
  subtitle?: string;
  group?: string;
  run: () => void | Promise<void>;
}
export interface SearchProvider {
  id: string;
  label: string;
  search: (query: string) => SearchResult[] | Promise<SearchResult[]>;
}

/** Declares the extension points used by the built-in theme and title-bar components. Call before `framework.start()`. */
export function declareHostPoints(framework: RendererFramework): void {
  const ep = framework.manager.extensionPoints;
  if (!ep.definition("theme")) {
    ep.declare({ name: "theme", contributions: { themes: s.object({ id: s.string(), label: s.string(), dark: s.boolean().optional(), tokens: s.record(s.string()) }) } });
  }
  if (!ep.definition("titlebar")) {
    ep.declare({ name: "titlebar", contributions: { searchProviders: s.object({ id: s.string(), label: s.string(), search: s.fn() }) } });
  }
}

interface ThemeCtx {
  mode: ThemeMode;
  setMode(m: ThemeMode): void;
  themeId: string | undefined;
  setThemeId(id: string | undefined): void;
  resolved: "light" | "dark";
  themes: ThemeDefinition[];
  toggle(): void;
}
const Ctx = createContext<ThemeCtx | null>(null);

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | undefined): void => {
  try {
    v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
};

/**
 * Light / dark / system modes plus themes contributed by plugins (extension point `theme`).
 * Applies `data-theme` and the theme's CSS variables on <html>, persists the choice, and reports the resolved
 * colours so the host can update the native window controls (`onResolved`).
 */
export function ThemeProvider({ children, storageKey = "fluxplugin.theme", onResolved }: { children: ReactNode; storageKey?: string; onResolved?: (r: { dark: boolean; bg: string; fg: string; surface: string }) => void }) {
  const themes = useExtensionItems<ThemeDefinition>("theme", "themes");
  const [mode, setModeState] = useState<ThemeMode>(() => (read(storageKey + ".mode") as ThemeMode) || "system");
  const [themeId, setThemeIdState] = useState<string | undefined>(() => read(storageKey + ".id") ?? undefined);
  const [systemDark, setSystemDark] = useState(() => typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const l = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", l);
    return () => mq.removeEventListener("change", l);
  }, []);
  const theme = themes.find((t) => t.id === themeId);
  const resolved: "light" | "dark" = theme ? (theme.dark ? "dark" : "light") : mode === "system" ? (systemDark ? "dark" : "light") : mode;

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", resolved);
    const applied = Object.entries(theme?.tokens ?? {}).filter(([k]) => /^--[\w-]+$/.test(k));
    for (const [k, v] of applied) root.style.setProperty(k, v);
    const cs = getComputedStyle(root);
    onResolved?.({ dark: resolved === "dark", bg: cs.getPropertyValue("--flux-bg").trim(), fg: cs.getPropertyValue("--flux-fg").trim(), surface: cs.getPropertyValue("--flux-surface").trim() });
    return () => applied.forEach(([k]) => root.style.removeProperty(k));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, theme]);

  const setMode = useCallback((m: ThemeMode) => (setModeState(m), setThemeIdState(undefined), write(storageKey + ".mode", m), write(storageKey + ".id", undefined)), [storageKey]);
  const setThemeId = useCallback((id: string | undefined) => (setThemeIdState(id), write(storageKey + ".id", id)), [storageKey]);
  const value = useMemo<ThemeCtx>(() => ({ mode, setMode, themeId, setThemeId, resolved, themes, toggle: () => setMode(resolved === "dark" ? "light" : "dark") }), [mode, setMode, themeId, setThemeId, resolved, themes]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useTheme must be used inside <ThemeProvider>");
  return c;
}

/** Sun/moon button; with plugin themes available it also offers a small picker. */
export function ThemeSwitcher(): React.ReactElement {
  const { resolved, toggle, themes, themeId, setThemeId, mode, setMode } = useTheme();
  usePluginFramework();
  return (
    <span className="flux-theme-switch">
      <button type="button" className="flux-tb-btn" onClick={toggle} title={`Theme: ${resolved} (click to switch)`} aria-label="Toggle theme" data-testid="theme-toggle">
        <Icon name={resolved === "dark" ? "moon" : "sun"} />
      </button>
      {themes.length > 0 && (
        <select className="flux-select" aria-label="Theme" value={themeId ?? `mode:${mode}`} onChange={(e) => (e.target.value.startsWith("mode:") ? setMode(e.target.value.slice(5) as ThemeMode) : setThemeId(e.target.value))}>
          <option value="mode:system">System</option>
          <option value="mode:light">Light</option>
          <option value="mode:dark">Dark</option>
          {themes.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      )}
    </span>
  );
}
