import { useEffect } from "react";

export interface BusyItem {
  id: number;
  /** `busy`: something is running. `dirty`: the user has unsaved changes. */
  kind: "busy" | "dirty";
  label: string;
}

let seq = 0;
let items: BusyItem[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Registry of what would be lost by leaving: running actions and unsaved edits. Read by the navigation and quit guards. */
export const busy = {
  register(kind: BusyItem["kind"], label: string): () => void {
    const item = { id: ++seq, kind, label };
    items = [...items, item];
    emit();
    return () => {
      items = items.filter((i) => i !== item);
      emit();
    };
  },
  list: (): BusyItem[] => items,
  hasDirty: (): boolean => items.some((i) => i.kind === "dirty"),
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};

/** Marks an action as running while `active`: quitting the app asks for confirmation. */
export function useBusy(active: boolean, label: string): void {
  useEffect(() => (active ? busy.register("busy", label) : undefined), [active, label]);
}

/**
 * Call with `dirty = true` while a form has unsaved changes: leaving the screen (links, back button, menus, palette) or the app asks
 * "Discard changes?" first. Saving (or cancelling) sets it back to false.
 */
export function useUnsavedChanges(dirty: boolean, label = "Unsaved changes"): void {
  useEffect(() => (dirty ? busy.register("dirty", label) : undefined), [dirty, label]);
  useEffect(() => {
    if (!dirty) return;
    const l = (e: BeforeUnloadEvent) => (e.preventDefault(), (e.returnValue = ""));
    window.addEventListener("beforeunload", l); // browser mode: the browser's own prompt (cannot be styled)
    return () => window.removeEventListener("beforeunload", l);
  }, [dirty]);
}
