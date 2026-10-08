import React from "react";

const PATHS: Record<string, string> = {
  search: "M11 4a7 7 0 105.2 11.7l3.5 3.5 1.4-1.4-3.5-3.5A7 7 0 0011 4zm0 2a5 5 0 110 10 5 5 0 010-10z",
  bell: "M12 3a6 6 0 00-6 6v3.6L4.3 15.3A1 1 0 005 17h14a1 1 0 00.7-1.7L18 12.6V9a6 6 0 00-6-6zm-2 16a2 2 0 004 0h-4z",
  sun: "M12 7a5 5 0 100 10 5 5 0 000-10zM11 1h2v3h-2V1zm0 19h2v3h-2v-3zM1 11h3v2H1v-2zm19 0h3v2h-3v-2zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4-2.1-2.1zm12.1 12.1l1.4-1.4 2.1 2.1-1.4 1.4-2.1-2.1zM5.6 19.8l-1.4-1.4 2.1-2.1 1.4 1.4-2.1 2.1zM18.4 7.7l-1.4-1.4 2.1-2.1 1.4 1.4-2.1 2.1z",
  moon: "M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z",
  plug: "M9 2v5H7v3a5 5 0 004 4.9V19H8v2h8v-2h-3v-4.1A5 5 0 0017 10V7h-2V2h-2v5h-2V2H9z",
  settings: "M12 8a4 4 0 100 8 4 4 0 000-8zm8.9 5l1.7 1.3-2 3.4-2-.8a7.6 7.6 0 01-1.7 1l-.3 2.1h-4l-.3-2.1a7.6 7.6 0 01-1.7-1l-2 .8-2-3.4L5.3 13a7 7 0 010-2L3.6 9.7l2-3.4 2 .8a7.6 7.6 0 011.7-1L9.6 4h4l.3 2.1a7.6 7.6 0 011.7 1l2-.8 2 3.4L17.9 11a7 7 0 010 2z",
  check: "M9 16.2l-3.5-3.5L4 14.2l5 5 11-11-1.5-1.5L9 16.2z",
  close: "M6.4 5l-1.4 1.4L10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6 6.4 5z",
  chevron: "M7 10l5 5 5-5H7z",
  play: "M8 5v14l11-7L8 5z",
  image: "M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zm3 3a2 2 0 100 4 2 2 0 000-4zm-3 9h16v-3l-4-4-5 5-3-3-4 4v1z",
  command: "M7 3a4 4 0 00-1 7.9v2.2A4 4 0 107 21a4 4 0 004-4h2a4 4 0 104-4 4 4 0 00-1-.1V10.9A4 4 0 1017 3a4 4 0 00-4 4h-2a4 4 0 00-4-4zm4 9H9V10h2v2zm4 0h-2V10h2v2z",
};

export type IconName = keyof typeof PATHS | (string & {});

/** Small built-in icon set (24×24, currentColor). Pass your own SVG path with `d` for custom icons. */
export function Icon({ name, d, size = 16, title }: { name?: IconName; d?: string; size?: number; title?: string }): React.ReactElement {
  const path = d ?? (name ? PATHS[name] : undefined) ?? PATHS["plug"]!;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden={title ? undefined : true} role={title ? "img" : undefined} className="flux-icon">
      {title && <title>{title}</title>}
      <path d={path} />
    </svg>
  );
}
export const iconNames = Object.keys(PATHS);
