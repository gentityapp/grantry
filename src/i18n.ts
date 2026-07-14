// Lightweight i18n for the dashboard, OAuth/connect pages and user-facing
// notices. Two locales: English (source) and Japanese.
//
// Design: translation-by-source-string. English literals stay inline in the
// templates as the canonical key; `t("Dashboard")` returns the Japanese string
// when the request locale is `ja`, otherwise the English source unchanged. Any
// string missing from the Japanese dictionary falls back to English, so the UI
// is never broken by incomplete coverage — it just degrades to English for the
// untranslated phrase.
//
// Locale is carried per-request through AsyncLocalStorage rather than threaded
// as a parameter, because the render layer (ui.ts, ~7800 lines) is a web of
// synchronous string builders and passing a locale to every one is infeasible.
// The middleware in server.ts runs each request inside `runWithLocale`, and the
// synchronous render functions read it via `currentLocale()` / `t()`.
import { AsyncLocalStorage } from "node:async_hooks";
import { ja } from "./i18n/ja.js";

export type Locale = "en" | "ja";

export const LOCALES: Locale[] = ["en", "ja"];
export const LANG_COOKIE = "gn_lang";

const store = new AsyncLocalStorage<Locale>();

export function runWithLocale<T>(locale: Locale, fn: () => T): T {
  return store.run(locale, fn);
}

export function currentLocale(): Locale {
  return store.getStore() ?? "en";
}

/** Value for the `<html lang>` attribute of the active locale. */
export function htmlLang(): string {
  return currentLocale();
}

/**
 * Pick a locale from an explicit cookie override, else the browser's
 * Accept-Language header, else English. The cookie always wins so the in-app
 * language switcher is authoritative.
 */
export function detectLocale(
  acceptLanguage: string | null | undefined,
  cookieValue: string | null | undefined,
): Locale {
  if (cookieValue === "ja" || cookieValue === "en") return cookieValue;
  if (acceptLanguage && /(^|[,;\s])ja\b/i.test(acceptLanguage)) return "ja";
  return "en";
}

/**
 * Translate a source (English) string for the active request locale.
 * Optional `{name}` placeholders in the string are replaced from `params`.
 */
export function t(source: string, params?: Record<string, string | number>): string {
  const locale = currentLocale();
  let out = locale === "ja" ? (ja[source] ?? source) : source;
  if (params) {
    for (const [key, val] of Object.entries(params)) {
      out = out.replaceAll(`{${key}}`, String(val));
    }
  }
  return out;
}
