import { s } from "fluxplugin";
import type { MainFramework } from "fluxplugin/main";
import { CHANNELS, OPERATIONS } from "../shared/constants";
import type { Item } from "../shared/types";

/**
 * Host operations. Each one runs through the hook pipeline, so plugins can validate, normalize or veto it
 * (before.item.create, transform.item.create, ...) without touching this file.
 */
export function registerOperations(fw: MainFramework): void {
  fw.manager.ipc.handle(
    CHANNELS.createItem,
    (input: { name: string }) =>
      fw.manager.hooks.run(OPERATIONS.createItem, input, (i) => {
        const item: Item = { id: Math.random().toString(36).slice(2, 8), name: i.name };
        fw.manager.events.emit("item.created", item, "host");
        return item as unknown as Record<string, unknown>;
      }),
    "host",
    { input: s.object({ name: s.string() }) },
  );
}
