# Publishing & verifying a release

```bash
pnpm install
pnpm typecheck && pnpm test         # ~138 tests
pnpm build                          # dist/ (ESM, shared chunks) + dist/types (.d.ts)
npm pack                            # fluxplugin-1.0.0.tgz — inspect with `tar tzf`

# Verify like a user, before publishing (offline-safe: installs the tarball):
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
mkdir /tmp/t && cd /tmp/t && npm init -y && npm i /path/to/fluxplugin-1.0.0.tgz
FLUXPLUGIN_SPEC=file:/path/to/fluxplugin-1.0.0.tgz npx fluxplugin init my-app
cd my-app && npm install && npm run build && npm run dev:web

# Publish (both packages; `fluxplugin` first):
npm publish                          # in the repo root  → fluxplugin
cd create-fluxplugin && npm publish  # → create-fluxplugin  (enables `npm create fluxplugin@latest`)
```
Check the names are free on npm first (`npm view fluxplugin`); if not, use a scope (`@you/fluxplugin`) and
search/replace the package name and `SHARED_MODULES` ids in `src/cli/shared-modules.ts`.
