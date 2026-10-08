import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotificationCenter, PluginManager, MemoryStorageBackend, validateManifest, videoEmbedUrl } from "fluxplugin";
import { copyPluginRuntime } from "fluxplugin/main";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { Markdown, detectOS, formatShortcut } from "fluxplugin/react";

describe("videoEmbedUrl", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://vimeo.com/123456789", "https://player.vimeo.com/video/123456789"],
    ["https://example.com/video.mp4", undefined],
    ["https://www.youtube.com/watch?v=<script>", undefined],
    ["javascript:alert(1)", undefined],
  ])("%s", (u, expected) => expect(videoEmbedUrl(u)).toBe(expected));
});

describe("manifest marketplace metadata", () => {
  const base = { id: "com.x.y", name: "Y", version: "1.0.0", main: "./m.js" };
  it("accepts icon, banner, screenshots, video, links, categories", () => {
    const r = validateManifest({ ...base, icon: "./assets/i.png", banner: "./assets/b.png", screenshots: ["./assets/1.png"], video: "https://youtu.be/dQw4w9WgXcQ", links: { docs: "https://x.dev" }, categories: ["Tools"], keywords: ["a"] });
    expect(r.ok).toBe(true);
    expect(r.manifest?.screenshots).toEqual(["./assets/1.png"]);
  });
  it("rejects non-https video and links", () => {
    expect(validateManifest({ ...base, video: "http://insecure.example/v" }).ok).toBe(false);
    expect(validateManifest({ ...base, links: { docs: "javascript:alert(1)" } }).ok).toBe(false);
  });
});

describe("NotificationCenter", () => {
  it("pushes, counts unread, marks read, dismisses, notifies and caps history", () => {
    const c = new NotificationCenter(3);
    const seen: string[] = [];
    c.onPush((n) => void seen.push(n.title));
    const a = c.push({ title: "A" }, "p");
    c.push({ title: "B", level: "error" }, "p");
    expect(c.unread).toBe(2);
    c.markRead();
    expect(c.unread).toBe(0);
    a.dismiss();
    expect(c.list().map((n) => n.title)).toEqual(["B"]);
    for (let i = 0; i < 5; i++) c.push({ title: `n${i}` });
    expect(c.list()).toHaveLength(3);
    expect(seen).toHaveLength(7);
  });
  it("is available to plugins only with the notifications permission", async () => {
    const m = new PluginManager({ runtime: "renderer", storage: new MemoryStorageBackend() });
    const mk = (id: string, permissions: string[]) => m.register({ manifest: { id, name: id, version: "1.0.0", main: "x", permissions }, load: async () => ({ onActivate: (ctx) => void ctx.notifications.push({ title: "hi" }) }) });
    mk("n.ok", ["notifications"]);
    mk("n.no", []);
    await m.activate("n.ok");
    await expect(m.activate("n.no")).rejects.toThrow(/missing permission "notifications"/);
    expect(m.notifications.list()[0]).toMatchObject({ title: "hi", owner: "n.ok" });
  });
});

describe("distributed plugins ship runtime files only (never source code)", () => {
  it("copies plugin.json, dist, assets, README and referenced files — not src, .ts, .tsx or sourcemaps", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-rt-"));
    try {
      const src = path.join(tmp, "p");
      const put = async (rel: string, c = "x") => (await fs.mkdir(path.dirname(path.join(src, rel)), { recursive: true }), fs.writeFile(path.join(src, rel), c));
      await put("plugin.json", JSON.stringify({ id: "com.x.rt", name: "R", version: "1.0.0", main: "./dist/main.mjs", renderer: "./dist/renderer.js", icon: "./assets/icon.svg", screenshots: ["./assets/s1.png"] }));
      for (const f of ["dist/main.mjs", "dist/renderer.js", "dist/index.css", "dist/main.mjs.map", "assets/icon.svg", "assets/s1.png", "README.md", "LICENSE",
        "src/main.ts", "src/renderer.tsx", "tsconfig.json", "package.json", "node_modules/x/index.js", ".env", "secrets.txt"]) await put(f);
      const copied = await copyPluginRuntime(src, path.join(tmp, "out"));
      expect(copied.sort()).toEqual(["LICENSE", "README.md", "assets/icon.svg", "assets/s1.png", "dist/index.css", "dist/main.mjs", "dist/renderer.js", "plugin.json"]);
      expect(copied.some((f) => /\.(tsx?|map)$/.test(f) || f.startsWith("src/"))).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("OS helpers", () => {
  it("detects the platform and formats shortcuts per OS", () => {
    expect(detectOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("mac");
    expect(detectOS("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(detectOS("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
    expect(formatShortcut("Mod+Shift+R", "mac")).toBe("⌘⇧R");
    expect(formatShortcut("Mod+Shift+R", "windows")).toBe("Ctrl+Shift+R");
  });
});

describe("Markdown (plugin descriptions)", () => {
  const html = (s: string) => renderToStaticMarkup(React.createElement(Markdown, { source: s }));
  it("renders headings, lists, tables, code and https links", () => {
    const out = html("# T\n\n- a\n- **b**\n\n| Perm | Why |\n| --- | --- |\n| `ipc` | calls |\n\n```\ncode\n```\n\n[x](https://example.com)");
    expect(out).toContain("<h2>T</h2>");
    expect(out).toContain("<li><strong>b</strong></li>");
    expect(out).toContain("<table>");
    expect(out).toContain("<td><code>ipc</code></td>");
    expect(out).toContain("<pre><code>code</code></pre>");
    expect(out).toContain('href="https://example.com"');
  });
  it("never renders raw HTML, scripts, javascript: links or images", () => {
    const out = html('<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![img](https://x.dev/a.png) <img src=x onerror=alert(1)>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("&lt;script&gt;");
  });
});
