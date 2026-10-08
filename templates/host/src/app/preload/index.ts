import { contextBridge, ipcRenderer } from "electron";
import { exposeFluxBridge } from "fluxplugin/preload";

// The only thing renderer code receives from the preload: window.__fluxplugin
exposeFluxBridge(contextBridge, ipcRenderer);
