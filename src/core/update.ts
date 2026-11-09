import { compareVersions, isValidVersion } from "./semver.js";

/** One file of the application payload (the built app: main, preload, renderer, bundled plugins). */
export interface UpdateFile {
  sha256: string;
  size: number;
  /** Absolute, or relative to latest.json. */
  url: string;
}

/** `latest.json` on your update server (static host or GitHub release asset). Files are addressed by content, so unchanged files are never downloaded again. */
export interface UpdateManifest {
  version: string;
  publishedAt: string;
  /** Markdown release notes for this version. */
  notes?: string;
  channel?: string;
  /** Oldest installed application (installer) that can load this payload; older ones must download a full installer. */
  minHost?: string;
  /** ed25519 signature (base64) of the manifest without this field (see `stableStringify`). */
  signature?: string;
  files: Record<string, UpdateFile>;
}

/** One line of `releases.json`: the full history, with installers for people who want to download any version. */
export interface ReleaseEntry {
  version: string;
  publishedAt: string;
  notes?: string;
  /** platform (win | mac | linux) → full installer URL. */
  installers?: Record<string, string>;
}

export type UpdateStatus = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "ready" | "error";

export interface UpdateState {
  status: UpdateStatus;
  current: string;
  latest?: string;
  notes?: string;
  /** What will be downloaded vs. reused from the installed version. */
  totalBytes?: number;
  savedBytes?: number;
  progress?: { receivedBytes: number; totalBytes: number; filesDone: number; filesTotal: number };
  error?: string;
  /** The user chose to keep downloading after closing the window. */
  background?: boolean;
  /** This version needs a full installer (the installed application is older than `minHost`). */
  requiresInstaller?: string;
}

export interface AppUpdatePlan {
  status: "update" | "up-to-date" | "downgrade";
  download: { path: string; file: UpdateFile }[];
  reuse: string[];
  remove: string[];
  totalBytes: number;
  /** Bytes NOT downloaded because the installed copy already matches. */
  savedBytes: number;
}

/** Progressive update: compares the installed payload (hash per file) with the published one and lists only what changed. */
export function planAppUpdate(current: { version: string; files: Record<string, string> }, latest: UpdateManifest): AppUpdatePlan {
  const cmp = isValidVersion(current.version) && isValidVersion(latest.version) ? compareVersions(latest.version, current.version) : 1;
  const download: AppUpdatePlan["download"] = [];
  const reuse: string[] = [];
  let saved = 0;
  for (const [p, f] of Object.entries(latest.files)) {
    if (current.files[p] === f.sha256) {
      reuse.push(p);
      saved += f.size;
    } else download.push({ path: p, file: f });
  }
  return {
    status: cmp > 0 ? "update" : cmp === 0 ? "up-to-date" : "downgrade",
    download,
    reuse,
    remove: Object.keys(current.files).filter((p) => !(p in latest.files)),
    totalBytes: download.reduce((n, d) => n + d.file.size, 0),
    savedBytes: saved,
  };
}

export const nextVersion = (v: string, bump: "patch" | "minor" | "major"): string => {
  const [a = 0, b = 0, c = 0] = v.split("-")[0]!.split(".").map(Number);
  return bump === "major" ? `${a + 1}.0.0` : bump === "minor" ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
};

/** JSON with sorted keys: the exact bytes that are signed and verified. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
