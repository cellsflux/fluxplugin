export type TemplateName = "basic" | "dashboard" | "backend";

export interface TemplateVars {
  id: string;
  name: string;
  /** Short identifier usable as JS identifier / IPC prefix. */
  slug: string;
  Pascal: string;
}

const pkg = (v: TemplateVars) =>
  JSON.stringify(
    {
      name: v.id,
      version: "1.0.0",
      private: true,
      type: "module",
      scripts: { dev: "fluxplugin dev", build: "fluxplugin build", package: "fluxplugin package", validate: "fluxplugin validate", release: "fluxplugin publish" },
      devDependencies: { fluxplugin: "^1.0.0", "@types/react": "^19.0.0", react: "^19.0.0", typescript: "^5.6.0" },
    },
    null,
    2,
  );

const tsconfig = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src"]
}
`;

const styles = (v: TemplateVars) => `/* Styles are loaded when the plugin activates and removed when it is disabled. */
.${v.slug}-card {
  border: 1px solid var(--flux-border, #e2e8f0);
  border-radius: 12px;
  padding: 16px;
}
`;

function basic(v: TemplateVars): Record<string, string> {
  return {
    "plugin.json": JSON.stringify(
      {
        id: v.id,
        name: v.name,
        version: "1.0.0",
        description: `${v.name} plugin`,
        author: "Your name",
        license: "MIT",
        repository: "https://github.com/YOUR_NAME/${v.slug}",   // fluxplugin publish releases here (replace YOUR_NAME)
        icon: "./assets/icon.svg",
        readme: "./README.md",
        categories: ["Productivity"],
        keywords: ["${v.slug}"],
        links: {},
        main: "./dist/main.mjs",
        renderer: "./dist/renderer.js",
        styles: ["./dist/index.css"],
        activationEvents: [`onCommand:${v.slug}.hello`],
        permissions: ["commands", "routes", "menus", "ui", "styles", "events"],
        engines: { "fluxplugin": "^1.0.0" },
        contributes: { commands: [{ id: `${v.slug}.hello`, title: `${v.name}: Say hello` }] },
      },
      null,
      2,
    ),
    "package.json": pkg(v),
    "tsconfig.json": tsconfig,
    "src/main.ts": `import { definePlugin } from "fluxplugin";

export default definePlugin({
  onActivate(ctx) {
    ctx.logger.info("${v.name} (main) activated");
  },
});
`,
    "src/renderer.tsx": `import { definePlugin } from "fluxplugin";

function ${v.Pascal}Page() {
  return (
    <div className="${v.slug}-card">
      <h1>${v.name}</h1>
      <p>Your first plugin page. Edit <code>src/renderer.tsx</code> and save.</p>
    </div>
  );
}

export default definePlugin({
  routes: [
    {
      path: "/${v.slug}",
      component: ${v.Pascal}Page,
      meta: { title: "${v.name}", menu: { label: "${v.name}" } },
    },
  ],
  commands: [
    {
      id: "${v.slug}.hello",
      title: "${v.name}: Say hello",
      execute: () => console.log("Hello from ${v.name}!"),
    },
  ],
});
`,
    "src/styles/index.css": styles(v),
    "assets/icon.svg": iconSvg(v),
    "README.md": readme(v),
  };
}

function dashboard(v: TemplateVars): Record<string, string> {
  const files = basic(v);
  const m = JSON.parse(files["plugin.json"]!);
  m.activationEvents = ["onStartup"];
  m.contributes = {};
  m.permissions = ["commands", "routes", "menus", "ui", "styles", "notifications"];
  files["plugin.json"] = JSON.stringify(m, null, 2);
  files["src/renderer.tsx"] = `import { definePlugin } from "fluxplugin";
import { usePluginState } from "fluxplugin/react";

function ${v.Pascal}Widget() {
  const [n, setN] = usePluginState("${v.id}", "clicks", 0);
  return (
    <div className="${v.slug}-card" data-testid="${v.slug}-widget">
      <strong>${v.name}</strong>
      <p>A widget injected into the host's <code>dashboard.after</code> slot.</p>
      <button onClick={() => setN((c) => c + 1)}>Clicked {n} times</button>
    </div>
  );
}

function ${v.Pascal}Page() {
  return <div className="${v.slug}-card"><h1>${v.name}</h1><p>Registered at runtime by a plugin.</p></div>;
}

export default definePlugin({
  routes: [{ path: "/${v.slug}", lazy: async () => ({ default: ${v.Pascal}Page }), meta: { title: "${v.name}", breadcrumb: "${v.name}", menu: { label: "${v.name}" } } }],
  components: [{ slot: "dashboard.after", component: ${v.Pascal}Widget, priority: 10 }],
  commands: [{ id: "${v.slug}.hello", title: "${v.name}: say hello", category: "${v.name}", execute: () => console.log("Hello from ${v.name}!") }],
  // Application menu: adds a top-level "${v.name}" menu to the title bar (File/Edit-style). Shortcuts come from the command's keybinding.
  menus: [{ id: "${v.slug}.menu", location: "application", label: "${v.name}", order: 50,
    children: [{ id: "${v.slug}.menu.open", label: "Open ${v.name}", path: "/${v.slug}" }, { id: "${v.slug}.menu.hello", label: "Say hello", command: "${v.slug}.hello" }] }],
  // Title-bar search: your results appear next to commands and pages.
  extensions: [
    { point: "dashboard", contribution: { toolbar: [{ id: "${v.slug}-hello", label: "${v.name}: hello", command: "${v.slug}.hello" }] } },
    { point: "titlebar", contribution: { searchProviders: [{ id: "${v.slug}.search", label: "${v.name}",
      search: (q: string) => ("${v.slug}".includes(q.toLowerCase()) ? [{ id: "${v.slug}.r1", title: "Open ${v.name}", subtitle: "page", run: () => { location.hash = "#/${v.slug}"; } }] : []) }] } },
  ],
  // A theme: tokens are CSS variables; the user picks it in the title bar.
  // { point: "theme", contribution: { themes: [{ id: "${v.slug}.ocean", label: "Ocean", dark: true, tokens: { "--flux-bg": "#06202b", "--flux-surface": "#0a2c3a", "--flux-fg": "#e6f6ff", "--flux-border": "#14465a", "--flux-accent": "#22d3ee" } }] } },
  onActivate(ctx) {
    ctx.notifications.push({ title: "${v.name} is ready", body: "Open the title-bar bell to see this notification.", level: "success" });
  },
});
`;
  return files;
}

function backend(v: TemplateVars): Record<string, string> {
  const files = basic(v);
  const m = JSON.parse(files["plugin.json"]!);
  m.activationEvents = [];
  m.permissions = ["ipc", "services", "events", "commands", "routes", "menus", "ui", "styles", "storage"];
  m.contributes = {};
  files["plugin.json"] = JSON.stringify(m, null, 2);
  files["src/main.ts"] = `import { definePlugin, defineIPC, s } from "fluxplugin";

const Input = s.object({ name: s.string({ min: 1 }) });
const Output = s.object({ message: s.string(), at: s.number() });

export const hello = defineIPC({
  name: "${v.slug}.hello",
  input: Input,
  output: Output,
  handler: async ({ name }, ctx) => ({ message: \`Hello \${name} from \${ctx.pluginId}\`, at: Date.now() }),
});

export default definePlugin({
  ipc: [hello],
  // Exposed to the renderer as window.plugins.${v.slug}.hello(...)
  preload: { ${v.slug}: { hello: "${v.slug}.hello" } },
  services: { "${v.slug}": { now: () => Date.now() } },
});
`;
  files["src/renderer.tsx"] = `import { definePlugin } from "fluxplugin";
import { usePluginIPC } from "fluxplugin/react";

function ${v.Pascal}Page() {
  const { data, call, loading, error } = usePluginIPC<{ name: string }, { message: string }>("${v.slug}.hello", { caller: "${v.id}" });
  return (
    <div className="${v.slug}-card">
      <button disabled={loading} onClick={() => void call({ name: "world" })}>Call main process</button>
      {data && <p>{data.message}</p>}
      {error && <p role="alert">{error.message}</p>}
    </div>
  );
}

export default definePlugin({
  routes: [{ path: "/${v.slug}", component: ${v.Pascal}Page, meta: { title: "${v.name}", menu: { label: "${v.name}" } } }],
});
`;
  return files;
}

export const TEMPLATES: Record<TemplateName, (v: TemplateVars) => Record<string, string>> = { basic, dashboard, backend };

export function varsFromName(name: string): TemplateVars {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "my-plugin";
  const id = slug.includes(".") ? slug : `com.example.${slug}`;
  const short = slug.split(".").pop()!;
  const Pascal = short.split(/[^a-z0-9]+/i).filter(Boolean).map((p) => p[0]!.toUpperCase() + p.slice(1)).join("");
  return { id, name: short.split("-").map((p) => p[0]!.toUpperCase() + p.slice(1)).join(" "), slug: short.replace(/-/g, "_"), Pascal };
}

/** Simple deterministic icon: coloured rounded square with the plugin's initial. Replace it with your own (png/svg/webp). */
function iconSvg(v: TemplateVars): string {
  let h = 0;
  for (const c of v.id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="22" fill="hsl(${h} 70% 48%)"/><text x="48" y="64" font-family="system-ui,sans-serif" font-size="52" font-weight="700" text-anchor="middle" fill="#fff">${v.name[0]!.toUpperCase()}</text></svg>\n`;
}

/** The long description shown on the plugin's page in the Plugin Manager (Markdown; raw HTML is not rendered). */
function readme(v: TemplateVars): string {
  return `# ${v.name}

One or two sentences that say what this plugin does and who it is for.

## What you get

- A **page** at \`/${v.slug}\` in the sidebar
- A **widget** on the dashboard
- A **command** you can run from the command palette (Ctrl/Cmd+K)

## How to use it

1. Enable the plugin in **Plugins**.
2. Open **${v.name}** in the sidebar.
3. Configure it in the plugin's *Settings* section.

## Permissions

| Permission | Why |
| --- | --- |
| \`routes\`, \`menus\` | adds its page and sidebar entry |
| \`ui\` | adds a dashboard widget |
| \`commands\` | registers its commands |

## Video & screenshots

Add them in \`plugin.json\` and they appear on this page:

\`\`\`json
"video": "https://www.youtube.com/watch?v=YOUR_VIDEO_ID",
"banner": "./assets/banner.png",
"screenshots": ["./assets/shot-1.png", "./assets/shot-2.png"],
"links": { "docs": "https://example.com/docs", "support": "https://example.com/support" }
\`\`\`

## Changelog

- **1.0.0** — first release
`;
}

/** Adds Tailwind v4 to a plugin: utilities only (no preflight, so the host's styles are never reset). */
export function withTailwind(files: Record<string, string>, v: TemplateVars): Record<string, string> {
  const m = JSON.parse(files["plugin.json"]!);
  m.styles = ["./dist/index.css", "./dist/tailwind.css"];
  files["plugin.json"] = JSON.stringify(m, null, 2);
  const pkg = JSON.parse(files["package.json"]!);
  pkg.devDependencies = { ...pkg.devDependencies, tailwindcss: "^4.0.0", "@tailwindcss/cli": "^4.0.0" };
  files["package.json"] = JSON.stringify(pkg, null, 2);
  files["src/styles/tailwind.css"] = `/* Utilities only: the host owns the preflight/reset. Colors follow the host theme. */
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);

@theme inline {
  --color-surface: var(--flux-surface);
  --color-border: var(--flux-border);
  --color-accent: var(--flux-accent);
  --color-muted: var(--flux-muted);
  --color-fg: var(--flux-fg);
}
`;
  files["src/renderer.tsx"] = files["src/renderer.tsx"]!.split(`className="${v.slug}-card"`).join('className="rounded-xl border border-border bg-surface p-4"');
  return files;
}
