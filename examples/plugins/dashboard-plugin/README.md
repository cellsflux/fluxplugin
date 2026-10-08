# Dashboard Widgets

Renderer-only plugin: a lazy route, a dashboard widget, a toolbar action and scoped styles.

## What you get

- A **widget** on the dashboard (slot `dashboard.after`)
- A lazy-loaded **Analytics** page with a sidebar entry
- A **toolbar action** contributed to the host's `dashboard` extension point
- A command with the shortcut `Mod+Shift+R`

## How to use it

1. Open **Plugins** and make sure _Dashboard Widgets_ is enabled.
2. Look for its entries in the sidebar, the menu bar and the dashboard.
3. Open the plugin's page in **Plugins → Details** to change its settings and read its logs.

## Permissions

| Permission      | Why                                |
| --------------- | ---------------------------------- |
| `routes, menus` | its page and sidebar entry         |
| `ui`            | widget + toolbar contribution      |
| `commands`      | the refresh command                |
| `styles`        | its own CSS, removed when disabled |

## Good to know

> Plugins are shipped as built JavaScript only. Source code never leaves the author's machine.

Documentation: [fluxplugin on npm](https://www.npmjs.com/package/fluxplugin)
