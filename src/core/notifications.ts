import { toDisposable, type Disposable } from "./common.js";

export type NotificationLevel = "info" | "success" | "warning" | "error";

export interface NotificationAction {
  label: string;
  /** Command executed when the user clicks the action. */
  command: string;
  args?: unknown[];
}

export interface NotificationInput {
  id?: string;
  title: string;
  body?: string;
  level?: NotificationLevel;
  actions?: NotificationAction[];
  /** Toast duration in ms; 0 keeps it only in the notification center. Default 5000. */
  timeoutMs?: number;
}

export interface NotificationItem extends Required<Pick<NotificationInput, "id" | "title" | "level">> {
  body?: string;
  actions: NotificationAction[];
  timeoutMs: number;
  owner: string;
  time: number;
  read: boolean;
}

/** In-app notification center (bell + toasts). Plugins push through `ctx.notifications.push` (permission "notifications"). */
export class NotificationCenter {
  private items: NotificationItem[] = [];
  private listeners = new Set<() => void>();
  private pushListeners = new Set<(n: NotificationItem) => void>();
  private seq = 0;
  version = 0;
  constructor(private readonly capacity = 200) {}

  push(input: NotificationInput, owner = "host"): { id: string; dismiss(): void } {
    const id = input.id ?? `${owner}#${Date.now().toString(36)}-${this.seq++}`;
    this.items = this.items.filter((n) => n.id !== id);
    const item: NotificationItem = {
      id, title: input.title, body: input.body, level: input.level ?? "info", actions: input.actions ?? [],
      timeoutMs: input.timeoutMs ?? 5000, owner, time: Date.now(), read: false,
    };
    this.items.unshift(item);
    if (this.items.length > this.capacity) this.items.length = this.capacity;
    this.changed();
    for (const l of [...this.pushListeners]) l(item);
    return { id, dismiss: () => this.dismiss(id) };
  }

  list(): NotificationItem[] {
    return this.items;
  }
  get unread(): number {
    return this.items.filter((n) => !n.read).length;
  }
  markRead(id?: string): void {
    for (const n of this.items) if (!id || n.id === id) n.read = true;
    this.changed();
  }
  dismiss(id: string): void {
    this.items = this.items.filter((n) => n.id !== id);
    this.changed();
  }
  clear(): void {
    this.items = [];
    this.changed();
  }
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  /** Called for every new notification (toast host, native bridges, main→renderer forwarding). */
  onPush(l: (n: NotificationItem) => void): Disposable {
    this.pushListeners.add(l);
    return toDisposable(() => this.pushListeners.delete(l));
  }
  private changed(): void {
    this.version++;
    for (const l of [...this.listeners]) l();
  }
}
