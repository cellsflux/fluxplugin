import type { FluxBridge } from "fluxplugin";
import { CHANNELS } from "../../shared/constants";
import type { Item } from "../../shared/types";

/** Service layer: the only place that knows the IPC channel names. UI code calls these functions. */
export const itemsApi = {
  create: (bridge: FluxBridge, name: string) => bridge.invoke(CHANNELS.createItem, { name }) as Promise<Item>,
};
