import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePluginFramework } from "./components.js";

/** Global keybindings: runs the command bound to the pressed shortcut. `Mod` = Ctrl (Win/Linux) or Cmd (macOS). */
export function useKeybindings(opts: { enabled?: boolean } = {}): void {
  const fw = usePluginFramework();
  useEffect(() => {
    if (opts.enabled === false) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return; // already handled (e.g. the command palette owns Mod+K)
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) && !(e.ctrlKey || e.metaKey)) return;
      const parts: string[] = [];
      if (e.ctrlKey || e.metaKey) parts.push("mod");
      if (e.shiftKey) parts.push("shift");
      if (e.altKey) parts.push("alt");
      const key = e.key.toLowerCase();
      if (["control", "shift", "alt", "meta"].includes(key)) return;
      parts.push(key);
      const cmd = fw.manager.commands.byKeybinding(parts.join("+"));
      if (cmd) {
        e.preventDefault();
        void fw.manager.commands.execute(cmd.id).catch((err) => fw.manager.logs.logger("host").error(`command ${cmd.id} failed: ${String(err)}`));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fw, opts.enabled]);
}

/** Searchable command palette (opens with Mod+K, or controlled through `open`). */
export function CommandPalette({ open, onClose }: { open?: boolean; onClose?: () => void }): React.ReactElement | null {
  const fw = usePluginFramework();
  const cmds = fw.manager.commands;
  useSyncExternalStore(cmds.subscribe, () => cmds.version, () => cmds.version);
  const [internal, setInternal] = useState(false);
  const isOpen = open ?? internal;
  const close = () => (onClose ? onClose() : setInternal(false));
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setInternal((v) => !v);
      } else if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setIndex(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [isOpen]);

  const results = useMemo(() => cmds.palette(query), [cmds, query, cmds.version]);
  if (!isOpen) return null;
  const run = (i: number): void => {
    const c = results[i];
    if (!c) return;
    close();
    void cmds.execute(c.id).catch((e) => fw.manager.logs.logger("host").error(String(e)));
  };
  return (
    <div className="flux-palette-backdrop" onMouseDown={close} role="presentation">
      <div className="flux-palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="flux-palette-input"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => (setQuery(e.target.value), setIndex(0))}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setIndex((i) => Math.min(i + 1, results.length - 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setIndex((i) => Math.max(i - 1, 0)));
            else if (e.key === "Enter") run(index);
          }}
        />
        <ul className="flux-palette-list" role="listbox">
          {results.length === 0 && <li className="flux-palette-empty">No matching commands</li>}
          {results.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === index} className={"flux-palette-item" + (i === index ? " is-active" : "")} onMouseEnter={() => setIndex(i)} onClick={() => run(i)}>
              <span>
                {c.category && <span className="flux-palette-cat">{c.category}: </span>}
                {c.title}
              </span>
              {c.keybinding && <kbd>{c.keybinding.replace("Mod", /Mac/.test(navigator.platform) ? "⌘" : "Ctrl")}</kbd>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
