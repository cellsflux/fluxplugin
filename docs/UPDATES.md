# Application updates (progressive, VS Code style)

1. **Configure** `fluxplugin.config.json` → `"updates": { "enabled": true, "source": { "type": "github", "repo": "you/app" } }` (or `{ "type": "http", "url": "https://updates.acme.com/" }` for a private server).
2. **Publish**: `npx fluxplugin publish --production` (`--bump patch|minor|major|none`, `--github you/app`, `--out release-server`, `--base-url https://…`).
   It bumps `package.json`, builds, writes `releases/<version>.md` (write what changed above the auto block; the detected file changes are filled in and never overwrite your text),
   and produces `latest.json`, `releases.json`, `notes/<v>.md` and **content-addressed files** — only files that are new since the previous release. With `--github` it creates the release and uploads them.
   Run `npx fluxplugin dist` first and the installers in `release/` are published too, so **any version can be downloaded in full**.
3. **Installed apps** check at start and every 6 h, show a small card bottom-right ("Version X is available — download 1.2 MB, 48 MB already on your computer"), explain the changes ("What's new"),
   download **only changed files** with a progress bar, then "Restart now". Closing the window during the download offers **keep in background / quit anyway**.
4. **Safe**: every file is verified (sha256) before use; the new version is loaded by `dist/boot.cjs` and abandoned automatically after two failed starts (rollback to the bundled version).
   Settings → Updates shows the history, release notes and installers of every version.

5. **Signed updates (recommended)**: generate a key pair (`generateSigningKeyPair()` from `fluxplugin/main`), put the public key in `fluxplugin.config.json` → `updates.publicKey`, and publish with
   `FLUXPLUGIN_UPDATE_KEY=<private key> npx fluxplugin publish --production` (or `--update-key`). Apps ignore any `latest.json` that is not signed by that key. Without a key the publisher warns.
6. **Minimum installed version**: `publish --production --min-host 1.4.0` marks a payload that older installers cannot load; those apps show "this version needs a full installer" instead of downloading it, and the installers stay available in Settings → Updates.

Scope: updates replace the application payload (main, preload, renderer, bundled plugins). A new Electron runtime or native modules still need a full installer.
