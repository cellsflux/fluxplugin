import React, { type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName } from "./icons.js";

/** iOS/macOS-style toggle. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }): React.ReactElement {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="flux-switch" data-on={checked || undefined} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

/** Segmented control (like NSSegmentedControl / UISegmentedControl). */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label?: string }): React.ReactElement {
  return (
    <div className="flux-seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} data-on={o.value === value || undefined} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Inset grouped list ("Settings" look). */
export function Group({ title, footer, children, className }: { title?: ReactNode; footer?: ReactNode; children: ReactNode; className?: string }): React.ReactElement {
  return (
    <section className={"flux-group-box " + (className ?? "")}>
      {title && <h3 className="flux-group-title">{title}</h3>}
      <div className="flux-group-body">{children}</div>
      {footer && <p className="flux-group-footer">{footer}</p>}
    </section>
  );
}

export interface RowProps {
  icon?: IconName | ReactNode;
  iconColor?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  chevron?: boolean;
  onClick?: () => void;
  selected?: boolean;
  "data-testid"?: string;
}

export function Row({ icon, iconColor, title, subtitle, right, chevron, onClick, selected, ...rest }: RowProps): React.ReactElement {
  const content = (
    <>
      {icon !== undefined && (
        <span className="flux-row-icon" style={iconColor ? { background: iconColor } : undefined}>
          {typeof icon === "string" ? <Icon name={icon} size={16} /> : icon}
        </span>
      )}
      <span className="flux-row-text">
        <span className="flux-row-title">{title}</span>
        {subtitle && <span className="flux-row-sub">{subtitle}</span>}
      </span>
      {right && <span className="flux-row-right" onClick={(e) => e.stopPropagation()}>{right}</span>}
      {chevron && <Icon name="chevronRight" size={18} />}
    </>
  );
  return onClick ? (
    <button type="button" className="flux-row is-link" data-selected={selected || undefined} onClick={onClick} {...rest}>{content}</button>
  ) : (
    <div className="flux-row" {...rest}>{content}</div>
  );
}

export function Button({ variant = "secondary", size = "md", children, ...rest }: { variant?: "primary" | "secondary" | "destructive" | "plain"; size?: "sm" | "md" | "lg" } & ButtonHTMLAttributes<HTMLButtonElement>): React.ReactElement {
  return (
    <button type="button" {...rest} className={`flux-btn flux-btn-${variant} flux-btn-${size} ${rest.className ?? ""}`}>
      {children}
    </button>
  );
}
