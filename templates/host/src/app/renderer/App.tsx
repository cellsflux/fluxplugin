import type { FluxBridge } from "fluxplugin";
import type { RendererFramework } from "fluxplugin/react";
import { AppProviders } from "./providers/AppProviders";
import { AppShell } from "./shell/AppShell";

export function App({ framework, bridge }: { framework: RendererFramework; bridge: FluxBridge }) {
  return (
    <AppProviders framework={framework} bridge={bridge}>
      <AppShell />
    </AppProviders>
  );
}
