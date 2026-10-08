# Security model (honest version)

**What is enforced**
* Renderer ↔ main: sandboxed preload exposes only `window.__fluxplugin`. The renderer may call **only** channels a plugin explicitly
  exposed via `preload.expose`, host allow-listed channels, and `flux.plugins.*` (disable with `allowManagement:false`).
* IPC input/output validated by schema; stack traces never cross the boundary; `flux.*` names are reserved.
* Permissions are declared in the manifest, granted by the host (`requireApproval:true` → nothing until the user approves),
  checked on every scoped API, persisted, and revocable live. Host APIs can be permission-gated.
* Integrity: sha256 of entry files in `integrity`; ed25519 manifest signatures with trusted keys (`trustedKeys`, `requireSignature`).
* Archives: path-traversal-safe extraction; HTTP registry checksums verified; asset protocol rejects traversal, manifest and main entry.
* Crash isolation: timeouts, rollback, error boundaries, auto-disable.

* Plugin pages: README Markdown is rendered without raw HTML or images; links must be https and open in the system browser; videos are
  embedded only for YouTube (nocookie) / Vimeo through a sandboxed iframe allowed by the page CSP.
* Distribution: only runtime files (`plugin.json`, `dist/`, `assets/`, README/LICENSE) are packaged or installed; sources never ship.
* `npm audit fix --force` can silently jump Electron several majors — keep Electron updates deliberate (see TROUBLESHOOTING).

**What is NOT enforced — do not rely on it**
* Plugin `main` code runs in the Electron main process with full Node access. Permissions are an API contract, **not a sandbox**:
  a malicious plugin can `require("fs")`. Only install plugins you trust; use signatures + `requireSignature`.
* Renderer plugin code shares the host page's JS realm; it can reach `window.__fluxplugin` and the management API.
  For untrusted plugins you need iframe/utility-process isolation (not implemented).
* `@scope` scoped styles need Chromium ≥ 118.
