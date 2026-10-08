import { s } from "fluxplugin";
import type { RendererFramework } from "fluxplugin/react";
import { EXTENSION_POINTS } from "../shared/constants";

/** Declare what plugins may contribute. Contributions are validated against these schemas. */
export function declareExtensionPoints(framework: RendererFramework): void {
  framework.manager.extensionPoints.declare({
    name: EXTENSION_POINTS.dashboard,
    contributions: {
      toolbar: s.object({ id: s.string(), label: s.string(), command: s.string().optional() }),
    },
  });
}
