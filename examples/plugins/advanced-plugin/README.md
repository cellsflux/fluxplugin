# Students Pro

Advanced: hooks, events, services, guards, layout, extension points, dependency on Stats.

## What you get

- **Hooks** on the host operation `item.create`: trims names and vetoes empty ones
- A **route guard** and a **plugin layout**
- A **PRO badge** in the title bar and a dashboard toolbar action
- A dependency on *Stats Service* (activated first)

## How to use it

1. Open **Plugins** and make sure *Students Pro* is enabled.
2. Look for its entries in the sidebar, the menu bar and the dashboard.
3. Open the plugin's page in **Plugins → Details** to change its settings and read its logs.

## Permissions

| Permission | Why |
| --- | --- |
| `hooks` | intercepting host operations |
| `events` | reacting to `item.created` |
| `services` | reading the stats service |

## Good to know

> Plugins are shipped as built JavaScript only. Source code never leaves the author's machine.

Documentation: [fluxplugin on npm](https://www.npmjs.com/package/fluxplugin)
