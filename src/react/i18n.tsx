import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { s } from "../core/index.js";
import { useExtensionItems } from "./components.js";
import type { RendererFramework } from "./runtime.js";

export interface LanguageDef {
  code: string;
  label: string;
  nativeLabel?: string;
  rtl?: boolean;
}
export interface MessagesDef {
  locale: string;
  messages: Record<string, string>;
}

export type TFunction = (key: string, fallback?: string, params?: Record<string, string | number>) => string;

interface I18nCtx {
  locale: string;
  setLocale(code: string): void;
  languages: LanguageDef[];
  t: TFunction;
}

const interpolate = (text: string, params?: Record<string, string | number>): string => (params ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : text);
const fallbackCtx: I18nCtx = { locale: "en", setLocale: () => {}, languages: [{ code: "en", label: "English" }], t: (_k, fb, p) => interpolate(fb ?? _k, p) };
const Ctx = createContext<I18nCtx>(fallbackCtx);

/** Declares the extension points plugins use to add languages and translations. Called by `declareHostPoints`. */
export function declareI18nPoints(framework: RendererFramework): void {
  const ep = framework.manager.extensionPoints;
  if (ep.definition("i18n")) return;
  ep.declare({
    name: "i18n",
    contributions: {
      languages: s.object({ code: s.string(), label: s.string(), nativeLabel: s.string().optional(), rtl: s.boolean().optional() }),
      messages: s.object({ locale: s.string(), messages: s.record(s.string()) }),
    },
  });
}

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};

/**
 * Translations come from plugins (extension point `i18n`): `languages` lists what the user can pick, `messages` maps keys to text.
 * Components call `useT()("key", "English fallback")`, so an app without any language plugin simply shows the fallback.
 */
export function I18nProvider({ children, defaultLocale = "en", storageKey = "fluxplugin.locale" }: { children: ReactNode; defaultLocale?: string; storageKey?: string }): React.ReactElement {
  const extra = useExtensionItems<LanguageDef>("i18n", "languages");
  const bundles = useExtensionItems<MessagesDef>("i18n", "messages");
  const [locale, setLocaleState] = useState(() => read(storageKey) ?? (typeof navigator !== "undefined" ? navigator.language : defaultLocale));
  const languages = useMemo(() => {
    const map = new Map<string, LanguageDef>([[defaultLocale, { code: defaultLocale, label: "English", nativeLabel: "English" }]]);
    for (const l of extra) map.set(l.code, l);
    return [...map.values()];
  }, [extra, defaultLocale]);
  // fr-CA → fr when only "fr" is installed; unknown languages fall back to the default.
  const active = useMemo(() => {
    const codes = languages.map((l) => l.code);
    return codes.includes(locale) ? locale : (codes.find((c) => locale.toLowerCase().startsWith(c.toLowerCase() + "-")) ?? defaultLocale);
  }, [locale, languages, defaultLocale]);
  const table = useMemo(() => {
    const m = new Map<string, Record<string, string>>();
    for (const b of bundles) m.set(b.locale, { ...(m.get(b.locale) ?? {}), ...b.messages });
    return m;
  }, [bundles]);
  const t = useCallback<TFunction>((key, fb, params) => interpolate(table.get(active)?.[key] ?? table.get(active.split("-")[0]!)?.[key] ?? fb ?? key, params), [table, active]);
  const setLocale = useCallback((code: string) => {
    setLocaleState(code);
    try {
      localStorage.setItem(storageKey, code);
    } catch {
      /* storage unavailable */
    }
  }, [storageKey]);
  useEffect(() => {
    document.documentElement.lang = active;
    document.documentElement.dir = languages.find((l) => l.code === active)?.rtl ? "rtl" : "ltr";
  }, [active, languages]);
  const value = useMemo(() => ({ locale: active, setLocale, languages, t }), [active, setLocale, languages, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = (): I18nCtx => useContext(Ctx);
export const useT = (): TFunction => useContext(Ctx).t;
