import { definePlugin } from "fluxplugin";
import { Group, Icon, Row, useI18n } from "fluxplugin/react";
import { messages } from "./messages";

// To add a language: translate src/messages.ts, then add it here.
const languages = [
  { code: "fr", label: "French", nativeLabel: "Français" },
  { code: "es", label: "Spanish", nativeLabel: "Español" },
  { code: "de", label: "German", nativeLabel: "Deutsch" },
];

function LanguageSection() {
  const { locale, setLocale, languages: all, t } = useI18n();
  return (
    <>
      <Group title={t("settings.language", "Language")}>
        {all.map((l) => (
          <Row key={l.code} data-testid={"lang-" + l.code} title={l.nativeLabel ?? l.label} subtitle={l.label} onClick={() => setLocale(l.code)} right={locale === l.code ? <Icon name="check" size={18} /> : undefined} />
        ))}
      </Group>
      <Group>
        <Row title={t("language.follow", "Follow the system language")} onClick={() => setLocale(navigator.language)} />
      </Group>
    </>
  );
}

export default definePlugin({
  extensions: [
    { point: "settings", contribution: { sections: [{ id: "language", title: "Language", icon: "language", order: 20, component: LanguageSection }] } },
    { point: "i18n", contribution: { languages } },
    ...Object.entries(messages).map(([locale, m]) => ({ point: "i18n", contribution: { messages: [{ locale, messages: m }] } })),
  ],
});
