# Stats Service

Main + renderer plugin: validated IPC, preload API, pushed events and a typed config.

## What you get

- A **main-process** service answering validated IPC calls (`stats.get`, `stats.addStudent`)
- A **preload API** exposed as `window.plugins.stats`
- A live **push** (`stats.updated`) every few seconds, with a configurable interval
- A typed, persisted **configuration** (see *Settings*)

## How to use it

1. Open **Plugins** and make sure *Stats Service* is enabled.
2. Look for its entries in the sidebar, the menu bar and the dashboard.
3. Open the plugin's page in **Plugins → Details** to change its settings and read its logs.

## Permissions

| Permission | Why |
| --- | --- |
| `ipc` | handlers and push events |
| `services` | the `stats.service` other plugins can use |
| `storage` | persisting its settings |

## Good to know

> Plugins are shipped as built JavaScript only. Source code never leaves the author's machine.

Documentation: [fluxplugin on npm](https://www.npmjs.com/package/fluxplugin)
