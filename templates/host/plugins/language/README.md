# Language

Choose the language of the whole interface: menus, search, notifications, settings and the plugin manager.

## Languages included

| Language | Code |
| --- | --- |
| English | `en` |
| Français | `fr` |
| Español | `es` |
| Deutsch | `de` |

Open **Settings → Language** and pick one. The change is instant and remembered.

## Add your own language

1. Copy `src/messages.ts` and translate the values.
2. Add the language to the list in `src/renderer.tsx`.
3. Build with `fluxplugin build`.

> [!NOTE]
> Any plugin can ship translations — the app merges them. Missing words fall back to English, so a partial translation is fine.

## Right-to-left languages

Set `rtl: true` on a language (Arabic, Hebrew…) and the whole interface mirrors automatically.
