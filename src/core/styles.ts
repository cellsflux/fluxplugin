import { Registry } from "./registry.js";
import type { Disposable } from "./common.js";

export interface StyleEntry {
  id: string;
  /** Inline CSS text (already compiled). */
  css?: string;
  /** URL of a stylesheet (served by the host — e.g. `fluxplugin://<id>/styles/index.css`). */
  href?: string;
  /** Lower numbers load first; later entries win ties in the cascade. Default 100. */
  priority: number;
  /** Wrap rules in `@scope ([data-fluxplugin="<id>"])` so they only affect the plugin's own subtree. */
  scoped: boolean;
  owner: string;
}

export interface StyleInput {
  id?: string;
  css?: string;
  href?: string;
  priority?: number;
  scoped?: boolean;
}

/**
 * Data-only registry of the styles contributed by plugins. A renderer adapter (see `fluxplugin/react`'s
 * `StyleHost`) mirrors this registry into `<style>`/`<link>` elements, which is what makes
 * disable → remove and hot-reload → replace work without touching the DOM from plugin code.
 */
export class StyleRegistry extends Registry<StyleEntry> {
  private n = 0;
  constructor() {
    super("Style");
  }

  register(input: StyleInput, owner: string): Disposable {
    if (!input.css && !input.href) throw new Error("style needs `css` or `href`");
    const id = input.id ?? `style-${this.n++}`;
    const entry: StyleEntry = { id, css: input.css, href: input.href, priority: input.priority ?? 100, scoped: input.scoped ?? false, owner };
    return this.add(`${owner}::${id}`, entry, owner);
  }

  /** Entries in cascade order. */
  ordered(): StyleEntry[] {
    return this.list()
      .map((e, i) => ({ e, i }))
      .sort((a, b) => a.e.priority - b.e.priority || a.i - b.i)
      .map((x) => x.e);
  }
}

export function scopeCss(css: string, pluginId: string): string {
  return `@scope ([data-fluxplugin="${pluginId.replace(/"/g, "")}"]) {\n${css}\n}`;
}
