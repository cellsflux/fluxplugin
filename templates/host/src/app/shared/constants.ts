/** Names shared by the main process and the renderer. No imports here: this layer depends on nothing. */
export const APP_NAME = "__APP_NAME__";

/** Height of the custom title bar in px (must match --flux-titlebar-h in CSS). */
export const TITLEBAR_HEIGHT = 40;

/** IPC channels the host exposes to the renderer (also allow-listed in main/framework.ts). */
export const CHANNELS = {
  createItem: "host.item.create",
  /** Colours the native window buttons (Windows/Linux overlay) to match the current theme. */
  setTitleBarOverlay: "host.window.setTitleBarOverlay",
} as const;

/** Declarative extension points the host offers to plugins (see renderer/extension-points.ts).
 *  The built-in "theme" and "titlebar" points are declared by declareHostPoints(). */
export const EXTENSION_POINTS = {
  dashboard: "dashboard",
} as const;

/** UI slots where plugins can inject components (see <PluginSlot name=... />). */
export const SLOTS = {
  brandBadges: "header.badges",
  titlebarLeft: "titlebar.left",
  titlebarRight: "titlebar.right",
  dashboardBefore: "dashboard.before",
  dashboardAfter: "dashboard.after",
} as const;

/** Hook pipeline operations plugins can intercept: before./after./transform./validate.<operation>. */
export const OPERATIONS = {
  createItem: "item.create",
} as const;
