/**
 * Design system of the framework's components: macOS look (SF-style type, translucent materials, grouped lists, switches,
 * segmented controls). Everything is driven by CSS variables so hosts, users (Settings → Appearance) and plugin themes can
 * restyle it: --flux-font, --flux-font-size, --flux-line, --flux-radius, --flux-accent, --flux-bg/-surface/-fg/-muted/-border …
 */
export const baseCss = `
:root{--flux-font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI Variable","Segoe UI",system-ui,Roboto,"Helvetica Neue",sans-serif;--flux-font-size:14px;--flux-line:1.5;--flux-radius:10px;--flux-radius-lg:14px;--flux-pad:1;
--flux-bg:#fff;--flux-surface:#f5f5f7;--flux-surface-2:#e9e9ee;--flux-fg:#1d1d1f;--flux-muted:#6e6e73;--flux-border:rgba(60,60,67,.16);--flux-accent:#007aff;--flux-accent-fg:#fff;--flux-ok:#34c759;--flux-warn:#ff9f0a;--flux-danger:#ff3b30;--flux-shadow:0 10px 34px rgba(0,0,0,.14);--flux-material:rgba(246,246,248,.78)}
@media (prefers-color-scheme:dark){:root:not([data-theme]){--flux-bg:#1c1c1e;--flux-surface:#2c2c2e;--flux-surface-2:#3a3a3c;--flux-fg:#f5f5f7;--flux-muted:#98989d;--flux-border:rgba(235,235,245,.16);--flux-accent:#0a84ff;--flux-shadow:0 10px 34px rgba(0,0,0,.55);--flux-material:rgba(44,44,46,.72)}}
:root[data-theme="dark"]{--flux-bg:#1c1c1e;--flux-surface:#2c2c2e;--flux-surface-2:#3a3a3c;--flux-fg:#f5f5f7;--flux-muted:#98989d;--flux-border:rgba(235,235,245,.16);--flux-accent:#0a84ff;--flux-shadow:0 10px 34px rgba(0,0,0,.55);--flux-material:rgba(44,44,46,.72)}
:root[data-theme="light"]{--flux-bg:#fff;--flux-surface:#f5f5f7;--flux-surface-2:#e9e9ee;--flux-fg:#1d1d1f;--flux-muted:#6e6e73;--flux-border:rgba(60,60,67,.16);--flux-accent:#007aff;--flux-material:rgba(246,246,248,.78)}
:root[data-radius="sharp"]{--flux-radius:4px;--flux-radius-lg:6px}:root[data-radius="round"]{--flux-radius:14px;--flux-radius-lg:22px}:root[data-density="compact"]{--flux-pad:.7}
:root[data-motion="reduced"] *{transition:none!important;animation:none!important}
html{font-family:var(--flux-font);font-size:var(--flux-font-size);line-height:var(--flux-line);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
body{font-family:var(--flux-font);font-size:1em;line-height:var(--flux-line);color:var(--flux-fg);background:var(--flux-bg)}
button,input,select,textarea{font-family:inherit;font-size:inherit}
.flux-icon{flex:none;vertical-align:middle}
.flux-large-title{font-size:2em;font-weight:700;letter-spacing:-.025em;margin:0 0 .6em;line-height:1.15}.flux-title{font-size:1.5em;font-weight:700;letter-spacing:-.02em;margin:0 0 .8em}
.flux-empty,.flux-not-found,.flux-forbidden,.flux-loading{padding:24px;color:var(--flux-muted)}
.flux-plugin-error{padding:10px 14px;border-radius:var(--flux-radius);background:color-mix(in srgb,var(--flux-danger) 12%,transparent);color:var(--flux-danger);font-size:.92em}
.flux-breadcrumbs{font-size:.86em;color:var(--flux-muted);margin-bottom:6px}.flux-breadcrumbs a{color:inherit;text-decoration:none}.flux-breadcrumbs a:hover{color:var(--flux-accent)}
/* ---- materials (vibrancy) */
.flux-titlebar,.flux-side,.flux-dropdown,.flux-toast,.flux-palette{background:var(--flux-material);-webkit-backdrop-filter:saturate(180%) blur(24px);backdrop-filter:saturate(180%) blur(24px)}
:root[data-translucency="off"] .flux-titlebar,:root[data-translucency="off"] .flux-side,:root[data-translucency="off"] .flux-dropdown,:root[data-translucency="off"] .flux-toast,:root[data-translucency="off"] .flux-palette{background:var(--flux-surface);-webkit-backdrop-filter:none;backdrop-filter:none}
/* ---- buttons / switch / segmented */
.flux-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--flux-border);background:var(--flux-bg);color:var(--flux-fg);border-radius:calc(var(--flux-radius) - 2px);padding:calc(5px*var(--flux-pad)) 14px;font-weight:500;cursor:pointer;transition:background .12s,transform .06s}
.flux-btn:hover{background:var(--flux-surface)}.flux-btn:active{transform:scale(.97)}.flux-btn:disabled{opacity:.5;cursor:default}
.flux-btn-primary{background:var(--flux-accent);border-color:transparent;color:var(--flux-accent-fg)}.flux-btn-primary:hover{background:var(--flux-accent);filter:brightness(1.08)}
.flux-btn-destructive{color:var(--flux-danger)}.flux-btn-plain{border-color:transparent;background:transparent;color:var(--flux-accent)}.flux-btn-plain:hover{background:var(--flux-surface)}
.flux-btn-sm{padding:3px 11px;font-size:.92em;border-radius:99px}.flux-btn-lg{padding:9px 22px;font-size:1.05em;border-radius:99px}
.flux-switch{position:relative;width:42px;height:26px;border-radius:99px;border:0;background:var(--flux-surface-2);cursor:pointer;transition:background .18s;flex:none;padding:0}
.flux-switch span{position:absolute;top:2px;left:2px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);transition:transform .18s}
.flux-switch[data-on]{background:var(--flux-ok)}.flux-switch[data-on] span{transform:translateX(16px)}.flux-switch:focus-visible{outline:2px solid var(--flux-accent);outline-offset:2px}
.flux-seg{display:inline-flex;background:var(--flux-surface-2);border-radius:9px;padding:2px;gap:2px}
.flux-seg button{border:0;background:transparent;color:var(--flux-fg);border-radius:7px;padding:calc(4px*var(--flux-pad)) 14px;font-weight:500;cursor:pointer}
.flux-seg button[data-on]{background:var(--flux-bg);box-shadow:0 1px 3px rgba(0,0,0,.18)}
.flux-input{width:100%;box-sizing:border-box;border:1px solid var(--flux-border);background:var(--flux-bg);color:var(--flux-fg);border-radius:var(--flux-radius);padding:calc(7px*var(--flux-pad)) 12px;outline:none}.flux-input:focus{border-color:var(--flux-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--flux-accent) 25%,transparent)}
.flux-select{background:var(--flux-bg);color:inherit;border:1px solid var(--flux-border);border-radius:7px;padding:3px 6px}
/* ---- grouped lists */
.flux-group-box{margin:0 0 calc(22px*var(--flux-pad))}.flux-group-title{font-size:.78em;text-transform:uppercase;letter-spacing:.06em;color:var(--flux-muted);margin:0 14px 6px;font-weight:600}
.flux-group-body{background:var(--flux-surface);border-radius:var(--flux-radius-lg);overflow:hidden}.flux-group-footer{font-size:.82em;color:var(--flux-muted);margin:6px 14px 0}
.flux-row{display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box;padding:calc(10px*var(--flux-pad)) 14px;border:0;background:transparent;color:inherit;text-align:left;position:relative;min-height:calc(44px*var(--flux-pad))}
.flux-row+.flux-row::before{content:"";position:absolute;top:0;left:14px;right:0;height:1px;background:var(--flux-border)}
.flux-row.is-link{cursor:pointer}.flux-row.is-link:hover{background:color-mix(in srgb,var(--flux-fg) 5%,transparent)}.flux-row[data-selected]{background:color-mix(in srgb,var(--flux-accent) 14%,transparent)}
.flux-row-icon{width:28px;height:28px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;background:var(--flux-accent);color:#fff;flex:none;overflow:hidden}
.flux-row-text{display:flex;flex-direction:column;min-width:0;flex:1}.flux-row-title{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.flux-row-sub{font-size:.88em;color:var(--flux-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.flux-row-right{display:flex;align-items:center;gap:8px;color:var(--flux-muted)}
.flux-img-fallback{display:inline-flex;align-items:center;justify-content:center;background:var(--flux-surface-2);color:var(--flux-muted);border-radius:inherit;min-width:32px;min-height:32px}
/* ---- title bar */
.flux-titlebar{--flux-titlebar-h:40px;height:var(--flux-titlebar-h);box-sizing:border-box;display:grid;grid-template-columns:1fr minmax(160px,400px) 1fr;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid var(--flux-border);color:var(--flux-fg);-webkit-app-region:drag;user-select:none;position:relative;z-index:50}
.flux-titlebar[data-electron][data-os="mac"]{padding-left:82px}
.flux-titlebar[data-electron][data-os="windows"],.flux-titlebar[data-electron][data-os="linux"]{padding-right:calc(100vw - env(titlebar-area-x,0px) - env(titlebar-area-width,100vw) + 8px)}
.flux-titlebar button,.flux-titlebar input,.flux-titlebar select,.flux-titlebar .flux-dropdown{-webkit-app-region:no-drag}
.flux-tb-left,.flux-tb-right{display:flex;align-items:center;gap:2px;min-width:0}.flux-tb-right{justify-content:flex-end}
.flux-brand{display:flex;align-items:center;gap:8px;font-weight:650;margin-right:8px;white-space:nowrap}
.flux-tb-btn{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;color:inherit;border-radius:6px;padding:4px 9px;font:inherit;cursor:pointer;position:relative}
.flux-tb-btn:hover,.flux-tb-btn.is-open{background:color-mix(in srgb,var(--flux-fg) 9%,transparent)}
.flux-menubar{display:flex}.flux-menu{position:relative}
.flux-dropdown{position:absolute;top:calc(100% + 4px);left:0;min-width:230px;max-width:380px;margin:0;padding:5px;list-style:none;color:var(--flux-fg);border:1px solid var(--flux-border);border-radius:10px;box-shadow:var(--flux-shadow);z-index:60}
.flux-dd-item{display:flex;justify-content:space-between;align-items:center;gap:18px;width:100%;border:0;background:transparent;color:inherit;font:inherit;text-align:left;padding:5px 10px;border-radius:5px;cursor:pointer}
.flux-dd-item:hover,.flux-dd-item.is-active{background:var(--flux-accent);color:var(--flux-accent-fg)}.flux-dd-item kbd,.flux-dd-item small{opacity:.6;font:11px ui-monospace,monospace}.flux-sep{height:1px;background:var(--flux-border);margin:5px 6px}
.flux-search{position:relative;display:flex;align-items:center;gap:8px;background:color-mix(in srgb,var(--flux-fg) 7%,transparent);border-radius:8px;padding:0 10px;height:26px;color:var(--flux-muted)}
.flux-search input{flex:1;min-width:0;border:0;background:transparent;color:var(--flux-fg);outline:none}.flux-search:focus-within{box-shadow:0 0 0 3px color-mix(in srgb,var(--flux-accent) 30%,transparent)}
.flux-search-results{left:0;right:0;max-width:none;top:calc(100% + 6px)}.flux-group{font-size:.74em;text-transform:uppercase;letter-spacing:.06em;color:var(--flux-muted);padding:7px 10px 2px;font-weight:600}
.flux-bell{position:relative}.flux-badge{position:absolute;top:0;right:0;min-width:15px;height:15px;border-radius:99px;background:var(--flux-danger);color:#fff;font-size:10px;line-height:15px;text-align:center}
.flux-notif-panel{left:auto;right:0;width:350px;max-height:440px;overflow:auto;padding:0}.flux-notif-head{display:flex;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--flux-border)}
.flux-notif{display:flex;justify-content:space-between;gap:10px;padding:11px 14px;border-bottom:1px solid var(--flux-border)}.flux-notif p{margin:2px 0 4px;font-size:.92em}.flux-notif small{color:var(--flux-muted)}.flux-notif-actions{display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.flux-notif.flux-success{box-shadow:inset 3px 0 var(--flux-ok)}.flux-notif.flux-warning{box-shadow:inset 3px 0 var(--flux-warn)}.flux-notif.flux-error{box-shadow:inset 3px 0 var(--flux-danger)}.flux-notif.flux-info{box-shadow:inset 3px 0 var(--flux-accent)}
.flux-link{background:none;border:0;color:var(--flux-accent);cursor:pointer;font:inherit;font-size:.88em;padding:0}
.flux-toasts{position:fixed;top:48px;right:14px;display:flex;flex-direction:column;gap:8px;z-index:40;pointer-events:none}
.flux-toast{pointer-events:auto;color:var(--flux-fg);border:1px solid var(--flux-border);border-radius:14px;padding:11px 15px;box-shadow:var(--flux-shadow);max-width:350px;font-size:.93em}
.flux-toast.flux-success{border-left:4px solid var(--flux-ok)}.flux-toast.flux-warning{border-left:4px solid var(--flux-warn)}.flux-toast.flux-error{border-left:4px solid var(--flux-danger)}
/* ---- command palette (Spotlight) */
.flux-palette-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.28);display:flex;justify-content:center;align-items:flex-start;padding-top:14vh;z-index:9999}
.flux-palette{width:min(600px,92vw);color:var(--flux-fg);border:1px solid var(--flux-border);border-radius:16px;box-shadow:var(--flux-shadow);overflow:hidden}
.flux-palette-input{width:100%;box-sizing:border-box;padding:16px 18px;border:0;border-bottom:1px solid var(--flux-border);background:transparent;color:inherit;font-size:1.25em;outline:none}
.flux-palette-list{list-style:none;margin:0;padding:6px;max-height:360px;overflow:auto}.flux-palette-item{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 12px;border-radius:8px;cursor:pointer}
.flux-palette-item.is-active{background:var(--flux-accent);color:var(--flux-accent-fg)}.flux-palette-cat{opacity:.65}.flux-palette-empty{padding:16px;color:var(--flux-muted)}.flux-palette kbd{font:11px ui-monospace,monospace;opacity:.7}
/* ---- sidebar */
.flux-side{display:flex;flex-direction:column;justify-content:space-between;height:100%;box-sizing:border-box;padding:12px 10px;border-right:1px solid var(--flux-border);overflow-y:auto;overflow-x:hidden;transition:padding .18s}
.flux-side-nav,.flux-side-bottom{display:flex;flex-direction:column;gap:2px}.flux-side-sep{height:1px;background:var(--flux-border);margin:8px 8px}
.flux-nav-group{position:relative}
.flux-nav{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;padding:calc(6px*var(--flux-pad)) 10px;border:0;background:transparent;color:inherit;text-decoration:none;border-radius:8px;cursor:pointer;font-weight:500;text-align:left;white-space:nowrap}
.flux-nav:hover{background:color-mix(in srgb,var(--flux-fg) 7%,transparent)}.flux-nav[data-active]{background:var(--flux-accent);color:var(--flux-accent-fg)}.flux-nav[data-parent-active]{font-weight:650}
.flux-nav-icon{display:inline-flex;width:22px;justify-content:center;flex:none}.flux-nav-label{flex:1;overflow:hidden;text-overflow:ellipsis}
.flux-nav-badge{font-size:.78em;background:var(--flux-danger);color:#fff;border-radius:99px;padding:0 6px}.flux-nav-chev{display:inline-flex;transition:transform .15s;opacity:.6}.flux-nav-chev[data-open]{transform:rotate(90deg)}
.flux-subnav{margin-left:14px;padding-left:8px;border-left:1px solid var(--flux-border);display:flex;flex-direction:column;gap:2px;margin-top:2px}.flux-subnav .flux-nav{font-weight:450;padding-top:calc(4px*var(--flux-pad));padding-bottom:calc(4px*var(--flux-pad))}
.flux-side[data-collapsed] .flux-nav{justify-content:center;padding:9px 0}
.flux-flyout{display:none;position:absolute;left:calc(100% + 6px);top:0;min-width:190px;padding:6px;background:var(--flux-bg);border:1px solid var(--flux-border);border-radius:10px;box-shadow:var(--flux-shadow);z-index:80}.flux-nav-group:hover>.flux-flyout{display:block}
.flux-flyout-title{font-size:.75em;text-transform:uppercase;letter-spacing:.06em;color:var(--flux-muted);padding:4px 10px}.flux-flyout-item{display:block;padding:6px 10px;border-radius:6px;color:inherit;text-decoration:none}.flux-flyout-item:hover,.flux-flyout-item[data-active]{background:var(--flux-accent);color:var(--flux-accent-fg)}
.flux-side-footer{font-size:.78em;color:var(--flux-muted);padding:6px 10px}
/* ---- settings */
.flux-settings{display:grid;grid-template-columns:240px minmax(0,1fr);gap:28px;align-items:start}.flux-settings-nav{display:flex;flex-direction:column;gap:2px;position:sticky;top:0}
.flux-settings-item{display:flex;align-items:center;gap:10px;border:0;background:transparent;color:inherit;border-radius:9px;padding:calc(7px*var(--flux-pad)) 10px;cursor:pointer;text-align:left;font-weight:500}.flux-settings-item:hover{background:color-mix(in srgb,var(--flux-fg) 7%,transparent)}.flux-settings-item[data-active]{background:var(--flux-accent);color:var(--flux-accent-fg)}
.flux-settings-body{min-width:0;max-width:720px}.flux-swatches{display:flex;gap:10px;flex-wrap:wrap}.flux-swatch{width:26px;height:26px;border-radius:50%;border:2px solid transparent;cursor:pointer;box-shadow:inset 0 0 0 2px var(--flux-bg)}.flux-swatch[data-on]{border-color:var(--flux-fg)}
.flux-theme-card{border:2px solid var(--flux-border);border-radius:12px;overflow:hidden;cursor:pointer;background:none;padding:0;text-align:left;width:128px}.flux-theme-card[data-on]{border-color:var(--flux-accent)}.flux-theme-card .flux-theme-prev{height:62px;display:flex}.flux-theme-card span.cap{display:block;padding:6px 9px;font-size:.84em;font-weight:500}
.flux-range{width:180px;accent-color:var(--flux-accent)}
/* ---- plugin pages */
.flux-pm{max-width:860px;margin:0 auto}.flux-pm-top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.flux-pm-back{display:inline-flex;align-items:center;gap:2px;border:0;background:none;color:var(--flux-accent);cursor:pointer;font-size:1em;padding:0;margin-bottom:12px}
.flux-pm-icon{width:56px;height:56px;border-radius:24%;object-fit:cover;flex:none;box-shadow:0 1px 4px rgba(0,0,0,.2);overflow:hidden;display:inline-flex}.flux-pm-icon.lg{width:104px;height:104px;border-radius:23%;box-shadow:0 4px 18px rgba(0,0,0,.22)}
.flux-pm-hero{display:flex;gap:22px;align-items:center;margin:4px 0 22px;flex-wrap:wrap}.flux-pm-hero h1{margin:0;font-size:2em;letter-spacing:-.02em;line-height:1.15}.flux-pm-hero .by{color:var(--flux-muted);margin:3px 0 12px}.flux-pm-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.flux-pm-facts{display:flex;border-top:1px solid var(--flux-border);border-bottom:1px solid var(--flux-border);margin:0 0 22px;overflow:auto}.flux-pm-fact{flex:1;min-width:104px;padding:12px 8px;text-align:center;border-right:1px solid var(--flux-border)}.flux-pm-fact:last-child{border:0}.flux-pm-fact small{display:block;font-size:.7em;letter-spacing:.06em;text-transform:uppercase;color:var(--flux-muted);font-weight:600}.flux-pm-fact b{font-size:1.15em;font-weight:650}
.flux-pm-shots{display:flex;gap:14px;overflow-x:auto;padding:4px 2px 14px;scroll-snap-type:x mandatory}.flux-pm-shots img,.flux-pm-banner{height:260px;border-radius:var(--flux-radius-lg);border:1px solid var(--flux-border);scroll-snap-align:start;cursor:zoom-in;flex:none}.flux-pm-banner{width:100%;height:auto;max-height:240px;object-fit:cover;cursor:default;margin-bottom:18px}
.flux-pm h3.sec{font-size:1.3em;font-weight:700;letter-spacing:-.015em;margin:26px 0 10px}
.flux-pill{display:inline-block;font-size:.76em;padding:2px 9px;border-radius:99px;background:var(--flux-surface-2);color:var(--flux-muted);font-weight:600}.flux-pill.ok{background:color-mix(in srgb,var(--flux-ok) 18%,transparent);color:var(--flux-ok)}.flux-pill.err{background:color-mix(in srgb,var(--flux-danger) 16%,transparent);color:var(--flux-danger)}.flux-pill.warn{background:color-mix(in srgb,var(--flux-warn) 20%,transparent);color:var(--flux-warn)}
.flux-zoom{position:fixed;inset:0;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;z-index:9999;cursor:zoom-out}.flux-zoom img{max-width:92vw;max-height:90vh;border-radius:14px}
.flux-video{width:100%;max-width:640px;aspect-ratio:16/9;border:0;border-radius:var(--flux-radius-lg);background:#000;display:block}.flux-video-link{display:inline-flex;gap:6px;align-items:center;color:var(--flux-accent);text-decoration:none}
.flux-pre{max-height:200px;overflow:auto;font:12px ui-monospace,monospace;background:var(--flux-surface);padding:12px;border-radius:var(--flux-radius);margin:0;white-space:pre-wrap}
.flux-fields label{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 14px}
/* ---- Markdown: app-store style typography */
.flux-md{font-size:1.04em;line-height:1.68;color:var(--flux-fg);letter-spacing:-.004em;max-width:70ch;overflow-wrap:anywhere}
.flux-md>:first-child{margin-top:0}.flux-md p{margin:.85em 0}
.flux-md h2{font-size:1.6em;font-weight:700;letter-spacing:-.022em;line-height:1.2;margin:1.7em 0 .5em}.flux-md h3{font-size:1.28em;font-weight:650;letter-spacing:-.015em;margin:1.5em 0 .4em}.flux-md h4,.flux-md h5{font-size:.82em;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--flux-muted);margin:1.6em 0 .4em}
.flux-md a{color:var(--flux-accent);text-decoration:none}.flux-md a:hover{text-decoration:underline;text-underline-offset:3px}
.flux-md ul,.flux-md ol{padding-left:1.3em;margin:.8em 0}.flux-md li{margin:.4em 0;padding-left:.2em}.flux-md li::marker{color:var(--flux-muted)}.flux-md li.flux-task{list-style:none;margin-left:-1.2em;display:flex;gap:8px;align-items:baseline}
.flux-md code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.86em;background:var(--flux-surface-2);padding:.14em .42em;border-radius:6px}
.flux-md pre{background:var(--flux-surface);border:1px solid var(--flux-border);border-radius:14px;padding:14px 18px;overflow:auto;line-height:1.55;margin:1.1em 0}.flux-md pre code{background:none;padding:0;font-size:.85em}
.flux-md blockquote{margin:1.1em 0;padding:.2em 1em;border-left:3px solid var(--flux-border);color:var(--flux-muted)}
.flux-md hr{border:0;height:1px;background:var(--flux-border);margin:2em 0}
.flux-md table{width:100%;border-collapse:separate;border-spacing:0;margin:1.2em 0;font-size:.94em;border:1px solid var(--flux-border);border-radius:14px;overflow:hidden}.flux-md th{text-align:left;font-size:.78em;letter-spacing:.06em;text-transform:uppercase;color:var(--flux-muted);background:var(--flux-surface);padding:9px 14px}.flux-md td{padding:10px 14px;border-top:1px solid var(--flux-border)}
.flux-md-img{max-width:100%;height:auto;border-radius:14px;border:1px solid var(--flux-border);margin:.9em 0;display:block}
.flux-callout{display:flex;flex-direction:column;gap:2px;margin:1.2em 0;padding:13px 16px;border-radius:14px;background:color-mix(in srgb,var(--c,var(--flux-accent)) 11%,transparent);border-left:4px solid var(--c,var(--flux-accent))}
.flux-callout strong{color:var(--c,var(--flux-accent));font-size:.82em;letter-spacing:.05em;text-transform:uppercase}.flux-callout[data-kind="warning"],.flux-callout[data-kind="caution"]{--c:var(--flux-warn)}.flux-callout[data-kind="tip"]{--c:var(--flux-ok)}.flux-callout[data-kind="important"]{--c:#af52de}
`;
