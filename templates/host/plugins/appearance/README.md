# Appearance

Make the app yours. This plugin adds an **Appearance** page to *Settings* and four extra themes.

## What you can change

- **Mode** — System, Light or Dark.
- **Theme** — Midnight, Sunset, Forest or high-contrast Graphite.
- **Accent color** — seven colors, or the theme's own.
- **Text** — font family, any font installed on your computer, size and line spacing.
- **Layout** — compact or comfortable spacing, corner roundness, translucency and reduced motion.

> [!TIP]
> Type the name of any font installed on your computer in *Your own font*. If it is missing, the next font in the list is used.

## How it works

| Setting | Stored as |
| --- | --- |
| Theme and mode | the app's theme variables |
| Fonts, size, spacing | CSS variables on the page |

Your choices are saved on this device and apply to every plugin, because plugins use the same variables.

## For developers

Plugins can add their own **themes** and **fonts** to the same lists — see the `theme` and `font` extension points in the documentation.
