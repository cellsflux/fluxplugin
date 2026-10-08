import { useState } from "react";
import { useBridge } from "../providers/AppProviders";
import { itemsApi } from "../services/items";

/** Calls the host operation (which plugins may rewrite or veto through hooks) and exposes the outcome. */
export function useCreateItem() {
  const bridge = useBridge();
  const [result, setResult] = useState("");
  const create = async (name: string) => {
    try {
      setResult(JSON.stringify(await itemsApi.create(bridge, name)));
    } catch (e) {
      setResult("blocked: " + (e as Error).message);
    }
  };
  return { create, result };
}
