import React from "react";
import { Icon } from "./icons.js";
import { useExtensionItems } from "./components.js";
import { useT } from "./i18n.js";
import { navigate, useParams } from "./router.js";
import type { SettingsSection } from "./theme.js";

const COLORS = ["#007aff", "#34c759", "#ff9f0a", "#af52de", "#ff375f", "#5ac8fa", "#8e8e93"];

/**
 * macOS "System Settings"-style screen. Sections are contributed to the `settings` extension point by the host and by
 * plugins (language, appearance, your own…). Register the route `/settings/:section` (and `/settings`) with this component.
 */
export function SettingsPage(): React.ReactElement {
  const t = useT();
  const raw = useExtensionItems<SettingsSection>("settings", "sections");
  const sections = [...raw].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));
  const { section } = useParams();
  const active = sections.find((s) => s.id === section) ?? sections[0];
  if (!active) return <div className="flux-empty">{t("settings.empty", "No settings yet")}</div>;
  const Body = active.component;
  return (
    <div className="flux-settings" data-testid="settings-page">
      <nav className="flux-settings-nav" aria-label={t("settings.title", "Settings")}>
        <h1 className="flux-large-title">{t("settings.title", "Settings")}</h1>
        {sections.map((s, i) => (
          <button key={s.id} type="button" className="flux-settings-item" data-active={s.id === active.id || undefined} data-testid={"settings-" + s.id} onClick={() => navigate("/settings/" + s.id)}>
            <span className="flux-row-icon" style={{ background: COLORS[i % COLORS.length] }}><Icon name={s.icon ?? "settings"} size={15} /></span>
            <span>{t(`settings.${s.id}`, s.title)}</span>
          </button>
        ))}
      </nav>
      <div className="flux-settings-body">
        <h2 className="flux-title">{t(`settings.${active.id}`, active.title)}</h2>
        <Body />
      </div>
    </div>
  );
}
