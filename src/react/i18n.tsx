import React, { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { s } from "../core/index.js";
import { useExtensionItems, useExtensionItemsWithOwner, usePluginFramework } from "./components.js";
import { I18nContext, PSEUDO, decorate, interpolate, type LanguageDef, type MessagesDef, type TFunction } from "./i18n-core.js";
import type { RendererFramework } from "./runtime.js";

export * from "./i18n-core.js";

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
  const fw = usePluginFramework();
  const bundles = useExtensionItemsWithOwner<MessagesDef>("i18n", "messages");
  const [locale, setLocaleState] = useState(() => read(storageKey) ?? (typeof navigator !== "undefined" ? navigator.language : defaultLocale));
  const languages = useMemo(() => {
    const map = new Map<string, LanguageDef>([[defaultLocale, { code: defaultLocale, label: "English", nativeLabel: "English" }]]);
    for (const l of extra) map.set(l.code, l);
    return [...map.values()];
  }, [extra, defaultLocale]);
  // fr-CA → fr when only "fr" is installed; unknown languages fall back to the default.
  const active = useMemo(() => {
    const codes = languages.map((l) => l.code);
    if (locale === PSEUDO) return PSEUDO;
    return codes.includes(locale) ? locale : (codes.find((c) => locale.toLowerCase().startsWith(c.toLowerCase() + "-")) ?? defaultLocale);
  }, [locale, languages, defaultLocale]);
  // System plugins (and the host) provide the shared vocabulary under plain keys. Any other plugin's keys are stored under
  // "<pluginId>:<key>" automatically, so plugins can never overwrite the system translations or each other.
  const table = useMemo(() => {
    const m = new Map<string, Record<string, string>>();
    for (const { owner, value: b } of bundles) {
      const shared = owner === "host" || fw.manager.isSystem(owner);
      const cur = m.get(b.locale) ?? {};
      for (const [k, v] of Object.entries(b.messages)) cur[shared ? k : `${owner}:${k}`] = v;
      m.set(b.locale, cur);
    }
    return m;
  }, [bundles, fw]);
  // fr-CA finds "fr" automatically, so a plugin only has to ship its base language to match the system language.
  const lookup = useCallback((key: string) => table.get(active)?.[key] ?? table.get(active.split("-")[0]!)?.[key], [table, active]);
  const t = useCallback<TFunction>((key, fb, params) => decorate(interpolate(lookup(key) ?? fb ?? key, params), active), [lookup, active]);
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
  const value = useMemo(() => ({ locale: active, setLocale, languages, t, lookup }), [active, setLocale, languages, t, lookup]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
