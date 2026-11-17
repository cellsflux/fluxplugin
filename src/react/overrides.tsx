import React, { Component, useMemo, type ComponentType, type ReactNode } from "react";
import { s } from "../core/index.js";
import { useExtensionItemsWithOwner, usePluginFramework, usePlugins } from "./components.js";

/** A component that replaces one of the library's built-in parts of the interface. */
export interface OverrideDef {
  /** One of `OVERRIDE_TARGETS`. */
  target: string;
  /** Receives the same props as the built-in component plus `Default` (the built-in component, to wrap or reuse). */
  component: ComponentType<any>;
  /** Highest wins when several replace the same part. */
  priority?: number;
}

/**
 * Parts of the interface that can be replaced. Replace the title bar, the menu bar only, the store page, the store tiles, the plugin
 * details page, the sidebar… and keep (or reuse) the rest. Your component plugs into the same logic through the hooks of the library
 * (`useMenu`, `useCatalog`, `useInstallFlows`, `useT`, …), so nothing has to be re-implemented.
 */
export const OVERRIDE_TARGETS = [
  "titlebar", "titlebar.menubar", "titlebar.search", "titlebar.notifications", "titlebar.theme",
  "sidebar", "breadcrumbs", "command-palette", "settings", "update.card",
  "plugins.page", "plugins.row", "plugins.store", "plugins.tile", "plugins.details", "plugins.store-details",
] as const;
export type OverrideTarget = (typeof OVERRIDE_TARGETS)[number];

const isComponent = (v: unknown): boolean => typeof v === "function" || (typeof v === "object" && v !== null);

/** Declares the `overrides` extension point. Called by `declareHostPoints`. */
export function declareOverridePoint(framework: { manager: { extensionPoints: { definition(n: string): unknown; declare(d: any): void } } }): void {
  const ep = framework.manager.extensionPoints;
  if (ep.definition("overrides")) return;
  ep.declare({ name: "overrides", contributions: { overrides: s.object({ target: s.string(), component: s.custom<ComponentType<any>>(isComponent, "expected a React component"), priority: s.number().optional() }) } });
}

class Guard extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(e: unknown) {
    console.error("A replacement component failed; the built-in one is used instead.", e);
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Renders the replacement registered for `name` — if its owner may replace parts of the interface (the host, or a plugin with the
 * `override` permission) — and the built-in component otherwise. A replacement that crashes is swapped back for the built-in one.
 */
export function Overridable<P extends object>({ name, Default, props }: { name: string; Default: ComponentType<P>; props: P }): React.ReactElement {
  const fw = usePluginFramework();
  const items = useExtensionItemsWithOwner<OverrideDef>("overrides", "overrides");
  const plugins = usePlugins(); // grants change → re-evaluate
  const chosen = useMemo(
    () => items.filter((i) => i.value.target === name && (i.owner === "host" || fw.manager.permissions.has(i.owner, "override"))).sort((a, b) => (b.value.priority ?? 0) - (a.value.priority ?? 0))[0],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, name, fw, plugins],
  );
  const base = <Default {...props} />;
  if (!chosen) return base;
  const Custom = chosen.value.component as ComponentType<P & { Default: ComponentType<P> }>;
  return (
    <Guard key={chosen.owner + chosen.value.target} fallback={base}>
      <Custom {...props} Default={Default} />
    </Guard>
  );
}

/** Makes a built-in component replaceable: `export const TitleBar = overridable("titlebar", DefaultTitleBar)`. */
export function overridable<P extends object>(name: string, Default: ComponentType<P>): ComponentType<P> {
  const C = (props: P) => <Overridable name={name} Default={Default} props={props} />;
  C.displayName = `Overridable(${name})`;
  return C;
}
