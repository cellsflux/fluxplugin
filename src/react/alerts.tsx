import React, { useEffect, useState, type ReactNode } from "react";
import { busy } from "./busy.js";

export interface AlertButton {
  label: string;
  value: string;
  variant?: "primary" | "secondary" | "destructive";
}
interface Request {
  title: string;
  message?: ReactNode;
  buttons: AlertButton[];
  resolve(v: string): void;
}

let push: ((r: Request) => void) | undefined;

const ask = (title: string, message: ReactNode, buttons: AlertButton[]): Promise<string> =>
  new Promise((resolve) => {
    if (push) push({ title, message, buttons, resolve });
    else resolve(typeof window !== "undefined" && window.confirm(`${title}\n\n${typeof message === "string" ? message : ""}`) ? buttons[buttons.length - 1]!.value : buttons[0]!.value); // no provider: last resort
  });

/** In-app alerts (macOS sheets). Use instead of window.alert / confirm so the app never shows a browser dialog. */
export const alertApi = {
  alert: (o: { title: string; message?: ReactNode; okLabel?: string }): Promise<void> => ask(o.title, o.message, [{ label: o.okLabel ?? "OK", value: "ok", variant: "primary" }]).then(() => undefined),
  confirm: (o: { title: string; message?: ReactNode; confirmLabel?: string; cancelLabel?: string; destructive?: boolean }): Promise<boolean> =>
    ask(o.title, o.message, [{ label: o.cancelLabel ?? "Cancel", value: "cancel", variant: "secondary" }, { label: o.confirmLabel ?? "OK", value: "ok", variant: o.destructive ? "destructive" : "primary" }]).then((v) => v === "ok"),
  /** Several choices; resolves with the chosen button's `value`. */
  choose: (o: { title: string; message?: ReactNode; buttons: AlertButton[] }): Promise<string> => ask(o.title, o.message, o.buttons),
};
export const useAlert = () => alertApi;

/** Renders the pending alert as a sheet. Alerts queue: they are shown one after the other. */
export function AlertProvider({ children }: { children?: ReactNode }): React.ReactElement {
  const [queue, setQueue] = useState<Request[]>([]);
  useEffect(() => {
    push = (r) => setQueue((q) => [...q, r]);
    return () => void (push = undefined);
  }, []);
  const cur = queue[0];
  const answer = (v: string) => {
    cur?.resolve(v);
    setQueue((q) => q.slice(1));
  };
  useEffect(() => {
    if (!cur) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && answer(cur.buttons[0]!.value);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  return (
    <>
      {children}
      {cur && (
        <div className="flux-dialog-backdrop" role="presentation">
          <div className="flux-dialog flux-sheet" role="alertdialog" aria-modal="true" aria-label={cur.title} data-testid="alert">
            <h3>{cur.title}</h3>
            {cur.message && <div className="flux-dialog-body">{cur.message}</div>}
            <div className="flux-dialog-actions">
              {cur.buttons.map((b) => (
                <button key={b.value} type="button" autoFocus={b.variant === "primary"} data-testid={"alert-" + b.value} className={`flux-btn flux-btn-${b.variant ?? "secondary"}`} onClick={() => answer(b.value)}>{b.label}</button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Lists what would be lost, for the quit confirmation. */
export const describeBusy = (): string[] => busy.list().map((i) => (i.kind === "dirty" ? `${i.label} (unsaved)` : `${i.label} (in progress)`));
