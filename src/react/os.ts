import { useMemo } from "react";

export type OS = "mac" | "windows" | "linux" | "other";

export function detectOS(ua = typeof navigator === "undefined" ? "" : navigator.userAgent): OS {
  if (/Mac|iPhone|iPad/i.test(ua)) return "mac";
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux|X11|CrOS/i.test(ua)) return "linux";
  return "other";
}
export const useOS = (): OS => useMemo(() => detectOS(), []);

/** `Mod+Shift+R` → `⌘⇧R` on macOS, `Ctrl+Shift+R` elsewhere. */
export function formatShortcut(binding: string, os: OS = detectOS()): string {
  const mac = os === "mac";
  const map: Record<string, string> = mac ? { mod: "⌘", ctrl: "⌃", shift: "⇧", alt: "⌥" } : { mod: "Ctrl", ctrl: "Ctrl", shift: "Shift", alt: "Alt" };
  const parts = binding.split("+").map((p) => map[p.toLowerCase()] ?? (p.length === 1 ? p.toUpperCase() : p));
  return mac ? parts.join("") : parts.join("+");
}
