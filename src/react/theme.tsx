import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { s } from "../core/index.js";
import { Icon } from "./icons.js";
import { useExtensionItems } from "./components.js";
import { declareI18nPoints, useT } from "./i18n.js";
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
export interface FontDefinition {
  id: string;
  label: string;
  /** CSS font-family stack. */
  stack: string;
  /** Optional @font-face CSS (use data: URLs or the plugin's asset URLs). */
  css?: string;
}
export interface SettingsSection {
  id: string;
  title: string;
  icon?: string;
  order?: number;
  component: React.ComponentType;
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

const isComponent = (v: unknown): boolean => typeof v === "function" || (typeof v === "object" && v !== null);

/** Declares the extension points used by the built-in components (theme, fonts, title bar, settings, i18n). Call before `framework.start()`. */
export function declareHostPoints(framework: RendererFramework): void {
  const ep = framework.manager.extensionPoints;
  if (!ep.definition("theme")) ep.declare({ name: "theme", contributions: { themes: s.object({ id: s.string(), label: s.string(), dark: s.boolean().optional(), tokens: s.record(s.string()) }) } });
  if (!ep.definition("font")) ep.declare({ name: "font", contributions: { fonts: s.object({ id: s.string(), label: s.string(), stack: s.string(), css: s.string().optional() }) } });
  if (!ep.definition("titlebar")) ep.declare({ name: "titlebar", contributions: { searchProviders: s.object({ id: s.string(), label: s.string(), search: s.fn() }) } });
  if (!ep.definition("settings")) {
    ep.declare({ name: "settings", contributions: { sections: s.object({ id: s.string(), title: s.string(), icon: s.string().optional(), order: s.number().optional(), component: s.custom<React.ComponentType>(isComponent, "expected a React component") }) } });
  }
  declareI18nPoints(framework);
}

/* ---------------------------------------------------------------- appearance */

export interface Appearance {
  /** Accent colour (any CSS colour); undefined = the theme's own. */
  accent?: string;
  fontId: string;
  /** Font family typed by the user (used before the chosen font). */
  customFont: string;
  /** Base text size in px (12–20). */
  fontSize: number;
  lineHeight: number;
  density: "comfortable" | "compact";
  translucency: boolean;
  radius: "sharp" | "default" | "round";
  reduceMotion: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = { fontId: "system", customFont: "", fontSize: 14, lineHeight: 1.5, density: "comfortable", translucency: true, radius: "default", reduceMotion: false };

export const BUILTIN_FONTS: FontDefinition[] = [
  { id: "system", label: "System (SF Pro)", stack: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable", "Segoe UI", system-ui, Roboto, "Helvetica Neue", sans-serif' },
  { id: "rounded", label: "Rounded", stack: 'ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI", system-ui, sans-serif' },
  { id: "serif", label: "Serif (New York)", stack: '"New York", "Iowan Old Style", "Palatino Linotype", Georgia, serif' },
  { id: "humanist", label: "Humanist", stack: 'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", sans-serif' },
  { id: "mono", label: "Monospace", stack: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace' },
];

const SAFE_FONT = /[^\w\s,.-]/g; // quotes are removed too: we add our own around each family
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

/** Turns a font name typed by the user into a safe CSS family list (quotes added, no CSS injection possible). */
export function sanitizeFontFamily(input: string): string {
  return input.split(",").map((f) => f.replace(SAFE_FONT, "").replace(/\s+/g, " ").trim()).filter(Boolean).map((f) => `"${f}"`).join(", ");
}

/* --------------------------------------------------------------------- theme */

interface ThemeCtx {
  mode: ThemeMode;
  setMode(m: ThemeMode): void;
  themeId: string | undefined;
  setThemeId(id: string | undefined): void;
  resolved: "light" | "dark";
  themes: ThemeDefinition[];
  toggle(): void;
  appearance: Appearance;
  setAppearance(patch: Partial<Appearance>): void;
  resetAppearance(): void;
  fonts: FontDefinition[];
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

function loadAppearance(key: string): Appearance {
  try {
    const raw = JSON.parse(read(key) ?? "{}") as Partial<Appearance>;
    return { ...DEFAULT_APPEARANCE, ...raw, fontSize: clamp(raw.fontSize ?? 14, 12, 20), lineHeight: clamp(raw.lineHeight ?? 1.5, 1.2, 2) };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/**
 * Light / dark / system modes, plugin themes, and the user's appearance preferences (accent, font, text size, density,
 * translucency, corner radius, motion). Everything is applied as CSS variables / data attributes on <html> and persisted.
 * `onResolved` reports the resolved colours so the host can colour the native window controls.
 */
export function ThemeProvider({ children, storageKey = "fluxplugin.theme", onResolved }: { children: ReactNode; storageKey?: string; onResolved?: (r: { dark: boolean; bg: string; fg: string; surface: string }) => void }) {
  const themes = useExtensionItems<ThemeDefinition>("theme", "themes");
  const pluginFonts = useExtensionItems<FontDefinition>("font", "fonts");
  const [mode, setModeState] = useState<ThemeMode>(() => (read(storageKey + ".mode") as ThemeMode) || "system");
  const [themeId, setThemeIdState] = useState<string | undefined>(() => read(storageKey + ".id") ?? undefined);
  const [appearance, setAppearanceState] = useState<Appearance>(() => loadAppearance(storageKey + ".appearance"));
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
  const fonts = useMemo(() => [...BUILTIN_FONTS, ...pluginFonts], [pluginFonts]);
  const font = fonts.find((f) => f.id === appearance.fontId) ?? BUILTIN_FONTS[0]!;

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", resolved);
    const applied = Object.entries(theme?.tokens ?? {}).filter(([k]) => /^--[\w-]+$/.test(k));
    for (const [k, v] of applied) root.style.setProperty(k, v);
    if (appearance.accent) root.style.setProperty("--flux-accent", appearance.accent);
    const cs = getComputedStyle(root);
    onResolved?.({ dark: resolved === "dark", bg: cs.getPropertyValue("--flux-bg").trim(), fg: cs.getPropertyValue("--flux-fg").trim(), surface: cs.getPropertyValue("--flux-surface").trim() });
    return () => {
      applied.forEach(([k]) => root.style.removeProperty(k));
      if (appearance.accent) root.style.removeProperty("--flux-accent");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, theme, appearance.accent]);

  useEffect(() => {
    const root = document.documentElement;
    const custom = sanitizeFontFamily(appearance.customFont);
    root.style.setProperty("--flux-font", custom ? `${custom}, ${font.stack}` : font.stack);
    root.style.setProperty("--flux-font-size", `${appearance.fontSize}px`);
    root.style.setProperty("--flux-line", String(appearance.lineHeight));
    root.setAttribute("data-density", appearance.density);
    root.setAttribute("data-translucency", appearance.translucency ? "on" : "off");
    root.setAttribute("data-radius", appearance.radius);
    root.setAttribute("data-motion", appearance.reduceMotion ? "reduced" : "full");
    let style: HTMLStyleElement | undefined;
    if (font.css) {
      style = document.createElement("style");
      style.setAttribute("data-flux-font", font.id);
      style.textContent = font.css;
      document.head.appendChild(style);
    }
    return () => style?.remove();
  }, [appearance, font]);

  const setMode = useCallback((m: ThemeMode) => (setModeState(m), setThemeIdState(undefined), write(storageKey + ".mode", m), write(storageKey + ".id", undefined)), [storageKey]);
  const setThemeId = useCallback((id: string | undefined) => (setThemeIdState(id), write(storageKey + ".id", id)), [storageKey]);
  const setAppearance = useCallback((patch: Partial<Appearance>) => setAppearanceState((cur) => {
    const next = { ...cur, ...patch };
    next.fontSize = clamp(next.fontSize, 12, 20);
    next.lineHeight = clamp(next.lineHeight, 1.2, 2);
    write(storageKey + ".appearance", JSON.stringify(next));
    return next;
  }), [storageKey]);
  const resetAppearance = useCallback(() => (setAppearanceState(DEFAULT_APPEARANCE), write(storageKey + ".appearance", undefined)), [storageKey]);
  const value = useMemo<ThemeCtx>(() => ({ mode, setMode, themeId, setThemeId, resolved, themes, toggle: () => setMode(resolved === "dark" ? "light" : "dark"), appearance, setAppearance, resetAppearance, fonts }),
    [mode, setMode, themeId, setThemeId, resolved, themes, appearance, setAppearance, resetAppearance, fonts]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useTheme must be used inside <ThemeProvider>");
  return c;
}
export const useAppearance = (): Pick<ThemeCtx, "appearance" | "setAppearance" | "resetAppearance" | "fonts"> => {
  const { appearance, setAppearance, resetAppearance, fonts } = useTheme();
  return { appearance, setAppearance, resetAppearance, fonts };
};

/** Sun/moon button; with plugin themes available it also offers a small picker. */
export function ThemeSwitcher(): React.ReactElement {
  const { resolved, toggle, themes, themeId, setThemeId, mode, setMode } = useTheme();
  const t = useT();
  return (
    <span className="flux-theme-switch">
      <button type="button" className="flux-tb-btn" onClick={toggle} title={t("theme.toggle", "Toggle appearance")} aria-label={t("theme.toggle", "Toggle appearance")} data-testid="theme-toggle">
        <Icon name={resolved === "dark" ? "moon" : "sun"} />
      </button>
      {themes.length > 0 && (
        <select className="flux-select" aria-label="Theme" value={themeId ?? `mode:${mode}`} onChange={(e) => (e.target.value.startsWith("mode:") ? setMode(e.target.value.slice(5) as ThemeMode) : setThemeId(e.target.value))}>
          <option value="mode:system">{t("theme.system", "System")}</option>
          <option value="mode:light">{t("theme.light", "Light")}</option>
          <option value="mode:dark">{t("theme.dark", "Dark")}</option>
          {themes.map((th) => <option key={th.id} value={th.id}>{th.label}</option>)}
        </select>
      )}
    </span>
  );
}
