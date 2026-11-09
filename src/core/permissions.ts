import { PermissionDeniedError, PermissionLockedError, toDisposable, type Disposable } from "./common.js";
import type { Permission } from "./manifest.js";

export interface PermissionSnapshot {
  declared: Permission[];
  granted: Permission[];
  denied: Permission[];
}

export interface PermissionManagerOptions {
  /**
   * When true (default) every permission declared in a manifest is granted automatically.
   * Set to false for third-party plugins: declared permissions then need an explicit `grant()`
   * (typically after the user approved them in the Plugin Manager UI), or a matching entry in `approved`.
   */
  autoGrant?: boolean;
  /** Previously approved permissions (e.g. restored from disk). */
  approved?: Record<string, Permission[]>;
  /** Called whenever grants change so the host can persist them. */
  onChange?: (pluginId: string, snapshot: PermissionSnapshot) => void;
}

export interface PermissionInfo {
  title: string;
  description: string;
  /** What happens when it is on / off. */
  consequence: string;
  sensitive?: boolean;
  /** Permissions that must stay granted while this one is granted. */
  requires?: Permission[];
}

/** Human-readable catalog used by every UI. Custom (`x.*`) permissions are described by the host. */
export const PERMISSION_CATALOG: Record<string, PermissionInfo> = {
  ipc: { title: "Talk to the app's background process", description: "Call and answer background tasks.", consequence: "Off: its features that need the background process stop working." },
  services: { title: "Share and use services", description: "Offer features to other plugins and use theirs.", consequence: "Off: it cannot use or provide shared services." },
  events: { title: "Send and receive events", description: "React to what happens in the app.", consequence: "Off: it no longer reacts to app events." },
  hooks: { title: "Change how the app behaves", description: "Intercept, validate or modify operations.", consequence: "Off: its rules no longer apply to operations.", sensitive: true },
  commands: { title: "Add commands", description: "Appear in the command palette and menus, with shortcuts.", consequence: "Off: its commands disappear." },
  routes: { title: "Add pages", description: "Create its own screens in the app.", consequence: "Off: its pages are removed." },
  menus: { title: "Add menu entries", description: "Appear in the menu bar and sidebar.", consequence: "Off: its menu entries disappear." },
  ui: { title: "Add interface elements", description: "Place widgets, buttons, settings sections and themes in the app.", consequence: "Off: its interface additions disappear." },
  styles: { title: "Style the interface", description: "Add its own look.", consequence: "Off: it can no longer restyle the app." },
  storage: { title: "Save its own data", description: "Keep settings and data on this device.", consequence: "Off: it cannot save anything." },
  notifications: { title: "Show notifications", description: "Alert you inside the app.", consequence: "Off: no more notifications from it." },
  network: { title: "Use the network", description: "Connect to the internet.", consequence: "Off: no internet access for it.", sensitive: true },
  "filesystem.read": { title: "Read files", description: "Open files on your computer.", consequence: "Off: it cannot read your files.", sensitive: true },
  "filesystem.write": { title: "Write files", description: "Create or change files on your computer.", consequence: "Off: it cannot change your files.", sensitive: true, requires: ["filesystem.read"] },
  database: { title: "Use the database", description: "Read and write the app's data.", consequence: "Off: no access to the app's data.", sensitive: true },
  window: { title: "Control windows", description: "Open, move or resize windows.", consequence: "Off: it cannot manage windows.", sensitive: true },
  clipboard: { title: "Use the clipboard", description: "Copy and paste for you.", consequence: "Off: no clipboard access.", sensitive: true },
  camera: { title: "Use the camera", description: "Take pictures and record video.", consequence: "Off: it cannot use the camera.", sensitive: true },
  shortcuts: { title: "Global keyboard shortcuts", description: "React to key combinations even when the app is in the background.", consequence: "Off: its global shortcuts stop working.", sensitive: true },
  shell: { title: "Run system commands", description: "Launch programs on your computer.", consequence: "Off: it cannot launch programs.", sensitive: true },
};

export const permissionInfo = (p: string): PermissionInfo =>
  PERMISSION_CATALOG[p] ?? (p.startsWith("x.") ? { title: `Custom access: ${p.slice(2)}`, description: "A capability defined by this app.", consequence: "Off: the feature that uses it stops working." } : { title: p, description: "", consequence: "" });

export interface PermissionLock {
  reason: string;
  kind: "system" | "required" | "feature" | "permission";
  /** Feature ids or permission names holding the lock — switch those off first. */
  by: string[];
}

/**
 * Tracks which permissions each plugin declared and which were granted.
 * Every scoped API of `PluginContext` calls `assert()` before doing anything privileged.
 */
export class PermissionManager {
  private declared = new Map<string, Set<Permission>>();
  private granted = new Map<string, Set<Permission>>();
  private listeners = new Set<(pluginId: string) => void>();
  private readonly autoGrant: boolean;
  private lockCheck?: (pluginId: string, permission: Permission) => PermissionLock | undefined;

  constructor(private readonly opts: PermissionManagerOptions = {}) {
    this.autoGrant = opts.autoGrant ?? true;
    for (const [id, perms] of Object.entries(opts.approved ?? {})) this.granted.set(id, new Set(perms));
  }

  /** Restores grants persisted from a previous session (call before `declare`). */
  restore(approved: Record<string, readonly Permission[]>): void {
    for (const [id, perms] of Object.entries(approved)) this.granted.set(id, new Set(perms));
  }

  /** Registers a plugin's requested permissions (called when its manifest is loaded). */
  declare(pluginId: string, permissions: readonly Permission[]): void {
    const set = new Set(permissions);
    this.declared.set(pluginId, set);
    const granted = this.granted.get(pluginId) ?? new Set<Permission>();
    if (this.autoGrant) for (const p of set) granted.add(p);
    // Drop grants for permissions the plugin no longer asks for.
    for (const p of [...granted]) if (!set.has(p)) granted.delete(p);
    this.granted.set(pluginId, granted);
    this.notify(pluginId);
  }

  forget(pluginId: string): void {
    this.declared.delete(pluginId);
    this.granted.delete(pluginId);
  }

  has(pluginId: string, permission: Permission): boolean {
    return this.granted.get(pluginId)?.has(permission) ?? false;
  }

  hasAll(pluginId: string, permissions: readonly Permission[]): boolean {
    return permissions.every((p) => this.has(pluginId, p));
  }

  assert(pluginId: string, permission: Permission, api: string = permission): void {
    if (!this.has(pluginId, permission)) throw new PermissionDeniedError(pluginId, permission, api);
  }

  grant(pluginId: string, permission: Permission): void {
    if (!this.declared.get(pluginId)?.has(permission)) {
      throw new Error(`Plugin "${pluginId}" did not declare permission "${permission}"`);
    }
    const set = this.granted.get(pluginId) ?? new Set<Permission>();
    set.add(permission);
    this.granted.set(pluginId, set);
    this.notify(pluginId);
  }

  grantAll(pluginId: string): void {
    for (const p of this.declared.get(pluginId) ?? []) this.grant(pluginId, p);
  }

  /** Installed by the plugin manager: which permissions cannot be revoked right now (system, required, in use). */
  setLockCheck(fn: (pluginId: string, permission: Permission) => PermissionLock | undefined): void {
    this.lockCheck = fn;
  }

  /** Grants regardless of an earlier revocation (permissions protected by the system). */
  forceGrant(pluginId: string, permission: Permission): void {
    const set = this.granted.get(pluginId) ?? new Set<Permission>();
    set.add(permission);
    this.granted.set(pluginId, set);
    (this as unknown as { denied?: Map<string, Set<Permission>> }).denied?.get(pluginId)?.delete(permission);
  }

  revoke(pluginId: string, permission: Permission): void {
    const lock = this.lockCheck?.(pluginId, permission);
    if (lock && this.has(pluginId, permission)) throw new PermissionLockedError(pluginId, permission, lock.reason, lock.by);
    this.granted.get(pluginId)?.delete(permission);
    this.notify(pluginId);
  }

  snapshot(pluginId: string): PermissionSnapshot {
    const declared = [...(this.declared.get(pluginId) ?? [])];
    const granted = [...(this.granted.get(pluginId) ?? [])];
    return { declared, granted, denied: declared.filter((p) => !granted.includes(p)) };
  }

  onChange(l: (pluginId: string) => void): Disposable {
    this.listeners.add(l);
    return toDisposable(() => this.listeners.delete(l));
  }

  private notify(pluginId: string): void {
    this.opts.onChange?.(pluginId, this.snapshot(pluginId));
    for (const l of this.listeners) l(pluginId);
  }
}
