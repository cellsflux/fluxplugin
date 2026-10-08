/** Minimal CSS for the framework's own components. Uses CSS variables so hosts can theme it; Tailwind is not required. */
export const baseCss = `
:root{--flux-bg:#fff;--flux-fg:#0f172a;--flux-muted:#64748b;--flux-border:#e2e8f0;--flux-accent:#4f46e5;--flux-accent-fg:#fff;--flux-surface:#f8fafc;--flux-danger:#dc2626;--flux-ok:#16a34a;--flux-warn:#d97706;--flux-radius:10px}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--flux-bg:#0b1020;--flux-fg:#e5e7eb;--flux-muted:#94a3b8;--flux-border:#1f2a44;--flux-surface:#111936}}
.fluxplugin-error{padding:8px 12px;border:1px solid var(--flux-danger);border-radius:var(--flux-radius);color:var(--flux-danger);font-size:13px}
.flux-breadcrumbs{font-size:13px;color:var(--flux-muted)}.flux-breadcrumbs a{color:inherit}
.flux-not-found,.flux-forbidden,.flux-loading{padding:24px;color:var(--flux-muted)}
.flux-palette-backdrop{position:fixed;inset:0;background:rgba(2,6,23,.45);display:flex;justify-content:center;align-items:flex-start;padding-top:14vh;z-index:9999}
.flux-palette{width:min(560px,92vw);background:var(--flux-bg);color:var(--flux-fg);border:1px solid var(--flux-border);border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.35);overflow:hidden}
.flux-palette-input{width:100%;box-sizing:border-box;padding:14px 16px;border:0;border-bottom:1px solid var(--flux-border);background:transparent;color:inherit;font-size:15px;outline:none}
.flux-palette-list{list-style:none;margin:0;padding:6px;max-height:340px;overflow:auto}
.flux-palette-item{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 12px;border-radius:8px;cursor:pointer;font-size:14px}
.flux-palette-item.is-active{background:var(--flux-accent);color:var(--flux-accent-fg)}
.flux-palette-cat{opacity:.65}.flux-palette-empty{padding:14px;color:var(--flux-muted);font-size:14px}
.flux-palette kbd{font:11px ui-monospace,monospace;padding:2px 6px;border:1px solid currentColor;border-radius:5px;opacity:.7}

:root[data-theme="dark"]{--flux-bg:#0b1020;--flux-fg:#e5e7eb;--flux-muted:#94a3b8;--flux-border:#1f2a44;--flux-surface:#111936}
:root[data-theme="light"]{--flux-bg:#fff;--flux-fg:#0f172a;--flux-muted:#64748b;--flux-border:#e2e8f0;--flux-surface:#f8fafc}
.flux-icon{flex:none;vertical-align:middle}
.flux-titlebar{--flux-titlebar-h:40px;height:var(--flux-titlebar-h);box-sizing:border-box;display:grid;grid-template-columns:1fr minmax(160px,400px) 1fr;align-items:center;gap:8px;padding:0 8px;background:var(--flux-surface);border-bottom:1px solid var(--flux-border);color:var(--flux-fg);-webkit-app-region:drag;user-select:none;position:relative;z-index:50}
.flux-titlebar[data-electron][data-os="mac"]{padding-left:82px}
.flux-titlebar[data-electron][data-os="windows"],.flux-titlebar[data-electron][data-os="linux"]{padding-right:calc(100vw - env(titlebar-area-x,0px) - env(titlebar-area-width,100vw) + 8px)}
.flux-titlebar button,.flux-titlebar input,.flux-titlebar select,.flux-titlebar .flux-dropdown{-webkit-app-region:no-drag}
.flux-tb-left,.flux-tb-right{display:flex;align-items:center;gap:4px;min-width:0}.flux-tb-right{justify-content:flex-end}
.flux-brand{display:flex;align-items:center;gap:8px;font-weight:600;margin-right:8px;white-space:nowrap}
.flux-tb-btn{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;color:inherit;border-radius:6px;padding:5px 9px;font:inherit;cursor:pointer;position:relative}
.flux-tb-btn:hover,.flux-tb-btn.is-open{background:var(--flux-border)}
.flux-menubar{display:flex}.flux-menu{position:relative}
.flux-dropdown{position:absolute;top:calc(100% + 4px);left:0;min-width:220px;max-width:360px;margin:0;padding:6px;list-style:none;background:var(--flux-bg);color:var(--flux-fg);border:1px solid var(--flux-border);border-radius:10px;box-shadow:0 14px 36px rgba(0,0,0,.28);z-index:60}
.flux-dd-item{display:flex;justify-content:space-between;align-items:center;gap:16px;width:100%;border:0;background:transparent;color:inherit;font:inherit;text-align:left;padding:7px 10px;border-radius:7px;cursor:pointer}
.flux-dd-item:hover,.flux-dd-item.is-active{background:var(--flux-accent);color:var(--flux-accent-fg)}
.flux-dd-item kbd,.flux-dd-item small{opacity:.65;font:11px ui-monospace,monospace}.flux-sep{height:1px;background:var(--flux-border);margin:5px 4px}
.flux-search{position:relative;display:flex;align-items:center;gap:8px;background:var(--flux-bg);border:1px solid var(--flux-border);border-radius:8px;padding:0 10px;height:28px;color:var(--flux-muted)}
.flux-search input{flex:1;min-width:0;border:0;background:transparent;color:var(--flux-fg);font:inherit;outline:none}
.flux-search-results{left:0;right:0;max-width:none;top:calc(100% + 6px)}.flux-group{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--flux-muted);padding:6px 10px 2px}
.flux-empty{padding:12px;color:var(--flux-muted);font-size:13px}.flux-select{margin-left:4px;background:var(--flux-bg);color:inherit;border:1px solid var(--flux-border);border-radius:6px;padding:3px 4px;font:inherit}
.flux-bell{position:relative}.flux-badge{position:absolute;top:0;right:0;min-width:15px;height:15px;border-radius:99px;background:var(--flux-danger);color:#fff;font-size:10px;line-height:15px;text-align:center}
.flux-notif-panel{left:auto;right:0;width:340px;max-height:420px;overflow:auto;padding:0}.flux-notif-head{display:flex;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--flux-border)}
.flux-notif{display:flex;justify-content:space-between;gap:10px;padding:10px 12px;border-bottom:1px solid var(--flux-border);border-left:3px solid var(--flux-accent)}
.flux-notif.flux-success{border-left-color:var(--flux-ok)}.flux-notif.flux-warning{border-left-color:var(--flux-warn)}.flux-notif.flux-error{border-left-color:var(--flux-danger)}
.flux-notif p{margin:2px 0 4px;font-size:13px}.flux-notif small{color:var(--flux-muted)}.flux-notif-actions{display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.flux-link{background:none;border:0;color:var(--flux-accent);cursor:pointer;font:inherit;font-size:12px;padding:0}
.flux-toasts{position:fixed;top:48px;right:12px;display:flex;flex-direction:column;gap:8px;z-index:40;pointer-events:none}
.flux-toast{pointer-events:auto;background:var(--flux-bg);color:var(--flux-fg);border:1px solid var(--flux-border);border-left:4px solid var(--flux-accent);border-radius:10px;padding:10px 14px;box-shadow:0 10px 28px rgba(0,0,0,.25);max-width:340px;font-size:13px}
.flux-toast.flux-success{border-left-color:var(--flux-ok)}.flux-toast.flux-warning{border-left-color:var(--flux-warn)}.flux-toast.flux-error{border-left-color:var(--flux-danger)}
.flux-md{line-height:1.6}.flux-md h2,.flux-md h3,.flux-md h4,.flux-md h5{margin:1.1em 0 .4em}.flux-md pre{background:var(--flux-surface);padding:10px;border-radius:8px;overflow:auto}
.flux-md code{background:var(--flux-surface);padding:1px 5px;border-radius:4px;font-size:.92em}.flux-md pre code{padding:0;background:none}.flux-md table{border-collapse:collapse;margin:8px 0;font-size:13px}.flux-md th,.flux-md td{border:1px solid var(--flux-border);padding:5px 10px;text-align:left}.flux-md th{background:var(--flux-surface)}.flux-md blockquote{margin:8px 0;padding:2px 12px;border-left:3px solid var(--flux-border);color:var(--flux-muted)}
`;
