import { PermissionDeniedError, toDisposable, type Disposable } from "./common.js";
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

/**
 * Tracks which permissions each plugin declared and which were granted.
 * Every scoped API of `PluginContext` calls `assert()` before doing anything privileged.
 */
export class PermissionManager {
  private declared = new Map<string, Set<Permission>>();
  private granted = new Map<string, Set<Permission>>();
  private listeners = new Set<(pluginId: string) => void>();
  private readonly autoGrant: boolean;

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

  revoke(pluginId: string, permission: Permission): void {
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
