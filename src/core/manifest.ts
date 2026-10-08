import { s, type Infer, type Issue } from "./schema.js";
import { isValidRange, isValidVersion, satisfies } from "./semver.js";

/** Version of the plugin API implemented by this framework build. Plugins declare compatibility via `engines`. */
export const FRAMEWORK_VERSION = "1.0.0";
export const FRAMEWORK_ENGINE_KEY = "fluxplugin";

/** Built-in permission identifiers. Hosts may add their own with the `x.` namespace (e.g. `x.billing.read`). */
export const BUILTIN_PERMISSIONS = [
  "filesystem.read",
  "filesystem.write",
  "network",
  "database",
  "ipc",
  "window",
  "notifications",
  "storage",
  "services",
  "menus",
  "commands",
  "routes",
  "ui",
  "events",
  "hooks",
  "styles",
  "clipboard",
  "shell",
] as const;
export type BuiltinPermission = (typeof BUILTIN_PERMISSIONS)[number];
export type Permission = BuiltinPermission | `x.${string}`;

const ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const ACTIVATION_RE = /^(\*|onStartup|onCommand:.+|onRoute:.+|onEvent:.+|onService:.+|onSlot:.+|onIPC:.+)$/;

const permissionSchema = s.custom<Permission>(
  (v) => typeof v === "string" && ((BUILTIN_PERMISSIONS as readonly string[]).includes(v) || /^x\.[a-z0-9.-]+$/.test(v)),
  `unknown permission (built-ins: ${BUILTIN_PERMISSIONS.join(", ")}; custom ones must start with "x.")`,
);

const versionRange = s.custom<string>((v) => typeof v === "string" && isValidRange(v), "expected a valid semver range");

export const menuLocations = ["application", "context", "sidebar", "toolbar", "commandPalette", "tray", "settings"] as const;
export type MenuLocation = (typeof menuLocations)[number];

export const manifestSchema = s.object({
  id: s.string({ pattern: ID_RE, min: 3, max: 128, description: "Unique reverse-DNS style identifier, lowercase" }),
  name: s.string({ min: 1, max: 128 }),
  version: s.custom<string>((v) => typeof v === "string" && isValidVersion(v), "expected a valid semver version"),
  description: s.string().optional(),
  author: s.union(s.string(), s.object({ name: s.string(), email: s.string().optional(), url: s.string().optional() })).optional(),
  homepage: s.string().optional(),
  repository: s.union(s.string(), s.object({ type: s.string().optional(), url: s.string() })).optional(),
  license: s.string().optional(),
  icon: s.string().optional(),
  /** Wide image shown at the top of the plugin page (png/jpg/webp/svg inside the plugin). */
  banner: s.string().optional(),
  /** Screenshots shown in a gallery (paths inside the plugin). */
  screenshots: s.array(s.string()).default([]),
  /** Detailed description as Markdown (default: ./README.md). Rendered safely: no raw HTML. */
  readme: s.string().optional(),
  /** Explanation video (https URL; YouTube and Vimeo are embedded, other hosts become a link). */
  video: s.string({ pattern: /^https:\/\/\S+$/ }).optional(),
  categories: s.array(s.string()).default([]),
  keywords: s.array(s.string()).default([]),
  /** Extra links: docs, support, changelog, funding... */
  links: s.record(s.string({ pattern: /^https:\/\/\S+$/ })).default({}),
  /** Entry executed in the Electron main process. */
  main: s.string().optional(),
  /** Entry executed in the preload context (sandbox-compatible, no Node). */
  preload: s.string().optional(),
  /** ESM entry loaded by the renderer. */
  renderer: s.string().optional(),
  styles: s.array(s.string()).optional(),
  tailwind: s
    .object({
      /** Globs (relative to the plugin root) scanned by Tailwind so utility classes are never purged. */
      content: s.array(s.string()).optional(),
      safelist: s.array(s.string()).optional(),
      /** Path of a pre-compiled CSS file produced by the plugin's own Tailwind build. */
      precompiled: s.string().optional(),
    })
    .optional(),
  activationEvents: s.array(s.string({ pattern: ACTIVATION_RE })).default([]),
  deactivationEvents: s.array(s.string()).default([]),
  permissions: s.array(permissionSchema).default([]),
  dependencies: s.record(versionRange).default({}),
  optionalDependencies: s.record(versionRange).default({}),
  peerDependencies: s.record(versionRange).default({}),
  engines: s.record(versionRange).default({}),
  /** Static, declarative metadata mirrored by the code-level registrations (lets the host display plugins without activating them). */
  contributes: s
    .object({
      routes: s.array(s.object({ path: s.string(), title: s.string().optional(), icon: s.string().optional(), permission: permissionSchema.optional() })).optional(),
      commands: s.array(s.object({ id: s.string(), title: s.string(), category: s.string().optional() })).optional(),
      menus: s
        .array(s.object({ location: s.enum(menuLocations), id: s.string(), label: s.string(), command: s.string().optional() }))
        .optional(),
      services: s.array(s.string()).optional(),
      ipc: s.array(s.string()).optional(),
      hooks: s.array(s.string()).optional(),
      slots: s.array(s.string()).optional(),
      configuration: s.unknown().optional(),
    })
    .default({}),
  /** Optional integrity hash (sha256-<hex>) of the main bundle. Verified before load when present. */
  integrity: s.record(s.string({ pattern: /^sha256-[0-9a-f]{64}$/ })).optional(),
  signature: s.object({ algorithm: s.literal("ed25519"), publicKey: s.string(), value: s.string() }).optional(),
});

export type PluginManifest = Infer<typeof manifestSchema>;

export interface ManifestValidation {
  ok: boolean;
  manifest?: PluginManifest;
  issues: Issue[];
  warnings: string[];
}

/**
 * Validates a raw manifest object (e.g. parsed `plugin.json`). Also checks engine compatibility
 * against the running framework version and reports non-fatal warnings.
 */
export function validateManifest(raw: unknown, opts: { frameworkVersion?: string } = {}): ManifestValidation {
  const r = manifestSchema.parse(raw);
  if (!r.ok) return { ok: false, issues: r.issues, warnings: [] };
  const manifest = r.value;
  const issues: Issue[] = [];
  const warnings: string[] = [];
  const fw = opts.frameworkVersion ?? FRAMEWORK_VERSION;
  const required = manifest.engines?.[FRAMEWORK_ENGINE_KEY];
  if (required && !satisfies(fw, required)) {
    issues.push({ path: `engines.${FRAMEWORK_ENGINE_KEY}`, message: `requires framework ${required}, running ${fw}` });
  }
  if (!manifest.main && !manifest.renderer && !manifest.preload) {
    issues.push({ path: "", message: "at least one of main, preload or renderer entry is required" });
  }
  if (!required) warnings.push(`engines.${FRAMEWORK_ENGINE_KEY} is not declared; compatibility cannot be verified`);
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    if (dep === manifest.id) issues.push({ path: `dependencies.${dep}`, message: "a plugin cannot depend on itself" });
  }
  return { ok: issues.length === 0, manifest: issues.length ? undefined : manifest, issues, warnings };
}

/** Turns a YouTube/Vimeo URL into a privacy-friendly embed URL; returns undefined for any other host. */
export function videoEmbedUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = u.hostname.replace(/^www\./, "");
  let id: string | undefined;
  if (host === "youtu.be") id = u.pathname.slice(1);
  else if (host === "youtube.com" || host === "m.youtube.com") id = u.searchParams.get("v") ?? (/^\/(embed|shorts)\//.test(u.pathname) ? u.pathname.split("/")[2] : undefined);
  if (id && /^[\w-]{6,20}$/.test(id)) return `https://www.youtube-nocookie.com/embed/${id}`;
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const vid = u.pathname.split("/").filter(Boolean).pop();
    if (vid && /^\d+$/.test(vid)) return `https://player.vimeo.com/video/${vid}`;
  }
  return undefined;
}
