import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as ReactDOMClient from "react-dom/client";
import * as flux from "fluxplugin";
import * as fluxReact from "fluxplugin/react";
import type { FluxBridge } from "fluxplugin";
import { RendererFramework, createHttpBridge, declareHostPoints, installSharedModules } from "fluxplugin/react";
import { declareExtensionPoints } from "./extension-points";
import { registerHostMenus } from "./menus";
import { registerHostRoutes } from "./routes";

/**
 * Infrastructure layer: connects to the main process, shares singletons with plugin bundles,
 * declares what plugins may extend, registers the host's own routes, then starts the plugins.
 */
export async function bootstrap(): Promise<{ framework: RendererFramework; bridge: FluxBridge }> {
  // One copy of React and of the runtime: plugin bundles import these from globalThis.
  installSharedModules({
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "react/jsx-dev-runtime": jsxRuntime,
    "react-dom/client": ReactDOMClient,
    fluxplugin: flux,
    "fluxplugin/react": fluxReact,
  });

  // Electron: the preload bridge. Browser mode: HTTP bridge to `fluxplugin dev --web`.
  const bridge: FluxBridge = (window as unknown as { __fluxplugin?: FluxBridge }).__fluxplugin ?? createHttpBridge();
  const framework = new RendererFramework({ bridge });

  declareHostPoints(framework); // built-in "theme" and "titlebar" (search providers) extension points
  declareExtensionPoints(framework); // BEFORE plugins start
  registerHostRoutes(framework);
  registerHostMenus(framework);
  await framework.start();
  return { framework, bridge };
}
