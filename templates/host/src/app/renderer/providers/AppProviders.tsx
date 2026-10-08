import { createContext, useCallback, useContext, type ReactNode } from "react";
import type { FluxBridge } from "fluxplugin";
import { PluginProvider, StyleHost, ThemeProvider, ToastHost, baseCss, type RendererFramework } from "fluxplugin/react";
import { setTitleBarOverlay } from "../services/window";

const BridgeContext = createContext<FluxBridge | null>(null);

/** Gives pages access to the main-process bridge without importing globals. */
export function useBridge(): FluxBridge {
  const b = useContext(BridgeContext);
  if (!b) throw new Error("useBridge must be used inside <AppProviders>");
  return b;
}

export function AppProviders({ framework, bridge, children }: { framework: RendererFramework; bridge: FluxBridge; children: ReactNode }) {
  // Keep the native window buttons in sync with the theme (light / dark / plugin themes).
  const onResolved = useCallback((r: { surface: string; fg: string }) => r.surface && setTitleBarOverlay(bridge, r.surface, r.fg), [bridge]);
  return (
    <PluginProvider framework={framework}>
      <BridgeContext.Provider value={bridge}>
        <style>{baseCss}</style>
        <StyleHost />
        <ThemeProvider onResolved={onResolved}>
          {children}
          <ToastHost />
        </ThemeProvider>
      </BridgeContext.Provider>
    </PluginProvider>
  );
}
