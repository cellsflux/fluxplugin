import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as ReactDOMClient from "react-dom/client";
import * as flux from "fluxplugin";
import * as fluxReact from "fluxplugin/react";
import type { FluxBridge } from "fluxplugin";
import { RendererFramework, createHttpBridge, createStaticBridge, declareHostPoints, installSharedModules } from "fluxplugin/react";
import { declareExtensionPoints } from "./extension-points";
import { registerHostMenus } from "./menus";
import { registerHostSettings } from "./settings";
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

  const bridge = await pickBridge();
  const framework = new RendererFramework({ bridge });

  declareHostPoints(framework); // built-in "theme" and "titlebar" (search providers) extension points
  declareExtensionPoints(framework); // BEFORE plugins start
  registerHostRoutes(framework);
  registerHostMenus(framework);
  registerHostSettings(framework);
  await framework.start();
  return { framework, bridge };
}

/** Electron: the preload bridge. Browser dev mode: HTTP bridge to `fluxplugin dev --web`. Static website export: bootstrap.json only. */
async function pickBridge(): Promise<FluxBridge> {
  const injected = (window as unknown as { __fluxplugin?: FluxBridge }).__fluxplugin;
  if (injected) return injected;
  try {
    const r = await fetch("/flux/bootstrap");
    if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) return createHttpBridge();
  } catch {
    /* no server behind this page */
  }
  return createStaticBridge("./bootstrap.json");
}
