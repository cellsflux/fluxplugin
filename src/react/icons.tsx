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
  home: "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z",
  folder: "M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z",
  grid: "M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z",
  panel: "M3 5v14h18V5H3zm6 12H5V7h4v10zm10 0h-8V7h8v10z",
  globe: "M12 2a10 10 0 100 20 10 10 0 000-20zm6.9 6h-3a15.7 15.7 0 00-1.4-3.6A8 8 0 0118.9 8zM12 4c.8 1.2 1.5 2.5 1.9 4h-3.8c.4-1.5 1.1-2.8 1.9-4zM4.3 14a8.2 8.2 0 010-4h3.4a16.5 16.5 0 000 4H4.3zm.8 2h3a15.7 15.7 0 001.4 3.6A8 8 0 015.1 16zm3-8h-3a8 8 0 014.4-3.6A15.7 15.7 0 008.1 8zM12 20c-.8-1.2-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.8-1.9 4zm2.3-6H9.7a14.7 14.7 0 010-4h4.6a14.7 14.7 0 010 4zm.3 5.6a15.7 15.7 0 001.4-3.6h3a8 8 0 01-4.4 3.6zm1.7-5.6a16.5 16.5 0 000-4h3.4a8.2 8.2 0 010 4h-3.4z",
  palette: "M12 3a9 9 0 000 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.3-.5-.8-.5-1.3 0-1.1.9-2 2-2H18c1.7 0 3-1.3 3-3 0-4.4-4-8-9-8zM6.5 12a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm3-4a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm5 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm3 4a1.5 1.5 0 110-3 1.5 1.5 0 010 3z",
  language: "M12.9 15l-2.5-2.5c1.7-1.9 2.9-4 3.6-6.5H17V4h-7V2H8v2H1v2h11.2c-.7 1.9-1.7 3.7-3.2 5.3-1-1.1-1.8-2.3-2.4-3.3h-2c.7 1.6 1.7 3.2 3 4.7L3.3 17.3l1.4 1.4L9 14.4l2.5 2.5.4-1.9zM18.5 10h-2L12 22h2l1.1-3h4.8l1.1 3h2l-4.5-12zm-2.6 7l1.6-4.3 1.6 4.3h-3.2z",
  info: "M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z",
  sliders: "M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z",
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-2.7 0-8 1.3-8 4v2h16v-2c0-2.7-5.3-4-8-4z",
  star: "M12 17.3l6.2 3.7-1.6-7L22 9.2l-7.2-.6L12 2 9.2 8.6 2 9.2 7.5 14l-1.6 7z",
  download: "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z",
  trash: "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
  power: "M13 3h-2v10h2V3zm4.8 2.2l-1.4 1.4A6 6 0 116.6 6.6L5.2 5.2A8 8 0 1017.8 5.2z",
  chevronRight: "M10 17l5-5-5-5v10z",
  back: "M15.4 7.4L14 6l-6 6 6 6 1.4-1.4L10.8 12z",
  type: "M5 4v3h5.5v12h3V7H19V4H5z",
  external: "M19 19H5V5h7V3H5a2 2 0 00-2 2v14a2 2 0 002 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.6l-9.8 9.8 1.4 1.4L19 6.4V10h2V3h-7z",
  bolt: "M7 2v11h3v9l7-12h-4l4-8z",
  shield: "M12 1L3 5v6c0 5.6 3.8 10.7 9 12 5.2-1.3 9-6.4 9-12V5l-9-4z",
  refresh: "M17.7 6.3A8 8 0 104 12h2a6 6 0 119.2-5.1L13 9h7V2l-2.3 2.3z",
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
