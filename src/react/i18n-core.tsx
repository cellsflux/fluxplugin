import React, { createContext, useCallback, useContext } from "react";

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

export interface I18nCtx {
  locale: string;
  setLocale(code: string): void;
  languages: LanguageDef[];
  t: TFunction;
  /** Raw lookup of a (possibly plugin-prefixed) key in the active language. */
  lookup(key: string): string | undefined;
}

/**
 * Pseudo-locale for testing: every string that goes through `t()` is wrapped in ⟦ ⟧. Any visible text without the marks was
 * hard-coded, i.e. will never be translated. Select it with `setLocale("pseudo")`.
 */
export const PSEUDO = "pseudo";
export const decorate = (text: string, locale: string): string => (locale === PSEUDO ? `⟦${text}⟧` : text);

export const interpolate = (text: string, params?: Record<string, string | number>): string => (params ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : text);

const fallbackCtx: I18nCtx = { locale: "en", setLocale: () => {}, languages: [{ code: "en", label: "English" }], t: (_k, fb, p) => interpolate(fb ?? _k, p), lookup: () => undefined };
export const I18nContext = createContext<I18nCtx>(fallbackCtx);

export const useI18n = (): I18nCtx => useContext(I18nContext);
export const useT = (): TFunction => useContext(I18nContext).t;

/**
 * Translations for one plugin: looks up "<pluginId>:<key>" first (its own messages, prefixed automatically), then the system
 * vocabulary (already translated by the language plugins), then the fallback.
 */
export function usePluginT(pluginId: string): TFunction {
  const { lookup, locale } = useContext(I18nContext);
  return useCallback<TFunction>((key, fb, params) => decorate(interpolate(lookup(`${pluginId}:${key}`) ?? lookup(key) ?? fb ?? key, params), locale), [lookup, pluginId, locale]);
}

/** A translated string as a component: for class components and places where a hook cannot be used. */
export function T({ id, fb, p }: { id: string; fb: string; p?: Record<string, string | number> }): React.ReactElement {
  return <>{useT()(id, fb, p)}</>;
}
