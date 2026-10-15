import { definePlugin } from "fluxplugin";
import { Button, Group, Row, Segmented, Switch, useAppearance, useT, useTheme, type ThemeMode } from "fluxplugin/react";
import { useState } from "react";

const ACCENTS = ["#007aff", "#34c759", "#ff9f0a", "#af52de", "#ff375f", "#5ac8fa", "#8e8e93"];

function AppearanceSection() {
  const t = useT();
  const { mode, setMode, themeId, setThemeId, themes } = useTheme();
  const { appearance: a, setAppearance, resetAppearance, fonts } = useAppearance();
  const [custom, setCustom] = useState(a.customFont);
  return (
    <>
      <Group title={t("appearance.mode", "Mode")}>
        <Row title={t("appearance.mode", "Mode")} right={
          <Segmented<ThemeMode> value={(themeId ? "" : mode) as ThemeMode} onChange={setMode} label="Mode"
            options={[{ value: "system", label: t("theme.system", "System") }, { value: "light", label: t("theme.light", "Light") }, { value: "dark", label: t("theme.dark", "Dark") }]} />} />
      </Group>

      <Group title={t("appearance.theme", "Theme")}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", padding: 14 }}>
          {[{ id: "", label: t("appearance.themeDefault", "Default"), tokens: { "--flux-bg": "#ffffff", "--flux-surface": "#f5f5f7", "--flux-accent": "#007aff" } }, ...themes].map((th) => (
            <button key={th.id || "default"} type="button" className="flux-theme-card" data-on={(themeId ?? "") === th.id || undefined} data-testid={"theme-" + (th.id || "default")} onClick={() => (th.id ? setThemeId(th.id) : setMode(mode))}>
              <span className="flux-theme-prev" style={{ display: "flex" }}>
                <i style={{ flex: 2, background: th.tokens["--flux-bg"] }} /><i style={{ flex: 1, background: th.tokens["--flux-surface"] }} /><i style={{ flex: 1, background: th.tokens["--flux-accent"] }} />
              </span>
              <span className="cap">{th.label}</span>
            </button>
          ))}
        </div>
      </Group>

      <Group title={t("appearance.accent", "Accent color")}>
        <div className="flux-swatches" style={{ padding: 14 }}>
          <button type="button" className="flux-swatch" title={t("appearance.accentDefault", "Theme default")} style={{ background: "conic-gradient(#ff3b30,#ff9f0a,#34c759,#0a84ff,#af52de,#ff3b30)" }} data-on={!a.accent || undefined} onClick={() => setAppearance({ accent: undefined })} />
          {ACCENTS.map((c) => <button key={c} type="button" aria-label={c} className="flux-swatch" style={{ background: c }} data-on={a.accent === c || undefined} data-testid={"accent-" + c.slice(1)} onClick={() => setAppearance({ accent: c })} />)}
        </div>
      </Group>

      <Group title={t("appearance.text", "Text")}>
        <Row title={t("appearance.font", "Font")} right={
          <select className="flux-select" value={a.fontId} data-testid="font-select" onChange={(e) => setAppearance({ fontId: e.target.value })}>{fonts.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select>} />
        <Row title={t("appearance.customFont", "Your own font")} subtitle={t("appearance.customFontHint", "Any font installed on your computer")} right={
          <input className="flux-input" style={{ width: 170 }} placeholder="e.g. Avenir Next" value={custom} data-testid="custom-font" onChange={(e) => setCustom(e.target.value)} onBlur={() => setAppearance({ customFont: custom })} onKeyDown={(e) => e.key === "Enter" && setAppearance({ customFont: custom })} />} />
        <Row title={t("appearance.fontSize", "Text size")} right={<><input className="flux-range" type="range" min={12} max={20} step={1} value={a.fontSize} data-testid="font-size" onChange={(e) => setAppearance({ fontSize: Number(e.target.value) })} /><span style={{ width: 34, textAlign: "right" }}>{a.fontSize}px</span></>} />
        <Row title={t("appearance.lineHeight", "Line spacing")} right={<input className="flux-range" type="range" min={1.2} max={2} step={0.05} value={a.lineHeight} onChange={(e) => setAppearance({ lineHeight: Number(e.target.value) })} />} />
        <div style={{ padding: "4px 14px 14px" }}><p style={{ margin: 0 }}>{t("appearance.preview", "The quick brown fox jumps over the lazy dog.")}</p></div>
      </Group>

      <Group title={t("appearance.layout", "Layout")}>
        <Row title={t("appearance.density", "Spacing")} right={
          <Segmented value={a.density} onChange={(density) => setAppearance({ density })} label="Spacing" options={[{ value: "comfortable", label: t("appearance.comfortable", "Comfortable") }, { value: "compact", label: t("appearance.compact", "Compact") }]} />} />
        <Row title={t("appearance.radius", "Corners")} right={
          <Segmented value={a.radius} onChange={(radius) => setAppearance({ radius })} label="Corners" options={[{ value: "sharp", label: t("appearance.sharp", "Sharp") }, { value: "default", label: t("appearance.default", "Default") }, { value: "round", label: t("appearance.round", "Round") }]} />} />
        <Row title={t("appearance.translucency", "Translucency")} right={<Switch checked={a.translucency} onChange={(translucency) => setAppearance({ translucency })} label="Translucency" />} />
        <Row title={t("appearance.motion", "Reduce motion")} right={<Switch checked={a.reduceMotion} onChange={(reduceMotion) => setAppearance({ reduceMotion })} label="Reduce motion" />} />
      </Group>
      <Button variant="destructive" onClick={() => (resetAppearance(), setCustom(""))}>{t("appearance.reset", "Reset appearance")}</Button>
    </>
  );
}

export default definePlugin({
  extensions: [
    { point: "settings", contribution: { sections: [{ id: "appearance", title: "Appearance", icon: "palette", order: 10, component: AppearanceSection }] } },
    { point: "theme", contribution: { themes: [
      { id: "midnight", label: "Midnight", dark: true, tokens: { "--flux-bg": "#0b1020", "--flux-surface": "#111936", "--flux-surface-2": "#1a2447", "--flux-fg": "#e6ebff", "--flux-muted": "#8f9bc7", "--flux-border": "rgba(150,170,255,.18)", "--flux-accent": "#7c9cff", "--flux-material": "rgba(17,25,54,.72)" } },
      { id: "sunset", label: "Sunset", tokens: { "--flux-bg": "#fff8f1", "--flux-surface": "#ffefe0", "--flux-surface-2": "#ffe0c7", "--flux-fg": "#3b1f12", "--flux-muted": "#9a6b53", "--flux-border": "rgba(120,60,20,.16)", "--flux-accent": "#ff6a3d", "--flux-material": "rgba(255,239,224,.8)" } },
      { id: "forest", label: "Forest", dark: true, tokens: { "--flux-bg": "#0f1a14", "--flux-surface": "#162720", "--flux-surface-2": "#1f3a2e", "--flux-fg": "#e4f3ea", "--flux-muted": "#8fb3a0", "--flux-border": "rgba(150,230,190,.16)", "--flux-accent": "#34d399", "--flux-material": "rgba(22,39,32,.74)" } },
      { id: "graphite", label: "Graphite (high contrast)", tokens: { "--flux-bg": "#ffffff", "--flux-surface": "#f0f0f0", "--flux-surface-2": "#dcdcdc", "--flux-fg": "#000000", "--flux-muted": "#3a3a3a", "--flux-border": "#000000", "--flux-accent": "#0040dd", "--flux-material": "rgba(240,240,240,.95)" } },
    ] } },
    { point: "font", contribution: { fonts: [
      { id: "editorial", label: "Editorial", stack: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif' },
      { id: "geometric", label: "Geometric", stack: '"Avenir Next", Avenir, "Century Gothic", Futura, "Trebuchet MS", sans-serif' },
      { id: "readable", label: "Easy reading", stack: '"Atkinson Hyperlegible", Verdana, Tahoma, sans-serif' },
    ] } },
  ],
});
