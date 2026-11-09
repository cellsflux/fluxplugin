/**
 * FluxAPI: the desktop capabilities an application needs, behind one typed interface that works the same for the host, for
 * renderer plugins and for main-process plugins. Every call is permission-checked per plugin in the main process.
 */
export interface FileFilter {
  name: string;
  /** Without dot: ["png", "jpg"]. */
  extensions: string[];
}

/** A file the user chose (or the OS handed over). `id` is a capability: only the plugin it was granted to can use it. */
export interface FileRef {
  id: string;
  path: string;
  name: string;
  ext: string;
  size: number;
  mime: string;
}

export interface DesktopApi {
  /** Native OS notification (permission "notifications"). */
  notify(n: { title: string; body?: string; silent?: boolean }): Promise<void>;
  files: {
    /** Native open dialog (permission "filesystem.read"). The returned refs are readable by the caller. */
    open(o?: { title?: string; filters?: FileFilter[]; multiple?: boolean }): Promise<FileRef[]>;
    /** Native save dialog (permission "filesystem.write"). The returned ref is writable by the caller. */
    save(o?: { title?: string; defaultName?: string; filters?: FileFilter[] }): Promise<FileRef | null>;
    read(ref: FileRef | string, as?: "text" | "base64"): Promise<string>;
    write(ref: FileRef | string, data: string, as?: "text" | "base64"): Promise<void>;
    /** Shows the file in Finder / Explorer. */
    reveal(ref: FileRef | string): Promise<void>;
  };
  /** Permission "clipboard". */
  clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
  /** Permission "shell". Only https:, http: and mailto: links. */
  shell: { openExternal(url: string): Promise<void> };
  app: { info(): Promise<{ name: string; version: string; platform: string; locale: string }> };
  /** Prints the focused window (permission "window"). */
  print(o?: { silent?: boolean }): Promise<void>;
  /** Renders the focused window to PDF; returns base64 (permission "window"). */
  printToPDF(): Promise<string>;
  /** System tray icon with a small menu (permission "window"). Clicks arrive as `TRAY_EVENT`; `null` removes it. */
  tray: { set(t: { tooltip?: string; items?: { id: string; label: string }[] } | null): Promise<void> };
  /** Global keyboard shortcuts, active even when the app is in the background (permission "shortcuts"). Presses arrive as `SHORTCUT_EVENT`. */
  shortcuts: { register(accelerator: string): Promise<boolean>; unregister(accelerator: string): Promise<void> };
}

export const API_CHANNELS = {
  notify: "flux.api.notify",
  open: "flux.api.files.open",
  save: "flux.api.files.save",
  read: "flux.api.files.read",
  write: "flux.api.files.write",
  reveal: "flux.api.files.reveal",
  handOver: "flux.api.files.handOver",
  pending: "flux.api.files.pending",
  clipRead: "flux.api.clipboard.read",
  clipWrite: "flux.api.clipboard.write",
  openExternal: "flux.api.shell.openExternal",
  appInfo: "flux.api.app.info",
  print: "flux.api.print",
  printPdf: "flux.api.printPdf",
  trayset: "flux.api.tray.set",
  shortcutRegister: "flux.api.shortcuts.register",
  shortcutUnregister: "flux.api.shortcuts.unregister",
} as const;

/** Broadcast by the main process when the OS asks the app to open a file (double-click, "Open with…", drag on the icon, argv). */
export const FILE_OPEN_EVENT = "flux.file.open";
export const SHORTCUT_EVENT = "flux.shortcut";
export const TRAY_EVENT = "flux.tray.click";

const MIME: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv", html: "text/html", xml: "application/xml", pdf: "application/pdf",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", zip: "application/zip",
};
export const mimeOf = (ext: string): string => MIME[ext.replace(/^\./, "").toLowerCase()] ?? "application/octet-stream";

export type FileOpenMode = "route" | "modal" | "import";

/** How a plugin wants to receive a file: open a route, show a modal, or import it silently. Contributed to the `fileHandlers` extension point. */
export interface FileHandlerDef {
  id: string;
  title: string;
  /** Lower-case, with or without dot: [".md", "markdown"]. */
  extensions: string[];
  mimeTypes?: string[];
  mode: FileOpenMode;
  /** mode "route": path to navigate to; the file is available through `useOpenedFile()` and `?file=<id>`. */
  route?: string;
  /** mode "modal": component rendered in a sheet with `{ file, onClose }`. */
  component?: unknown;
  /** mode "import": called with the file; resolve to close, throw to report an error. */
  import?: (file: FileRef) => Promise<void> | void;
  priority?: number;
  /** Plugin that contributed it (filled by the host). */
  owner?: string;
}

const norm = (e: string) => e.replace(/^\./, "").toLowerCase();

/** Which handlers can open `file`, best first (priority, then specificity: extension match before mime match). */
export function resolveFileHandlers<H extends FileHandlerDef>(handlers: H[], file: Pick<FileRef, "ext" | "mime">): H[] {
  const ext = norm(file.ext);
  return handlers
    .map((h) => ({ h, score: h.extensions.some((e) => norm(e) === ext || e === "*") ? (h.extensions.includes("*") ? 1 : 2) : (h.mimeTypes ?? []).includes(file.mime) ? 1 : 0 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => (b.h.priority ?? 0) - (a.h.priority ?? 0) || b.score - a.score || a.h.title.localeCompare(b.h.title))
    .map((x) => x.h);
}
