import http from "node:http";

interface Release { id: number; tag: string; assets: { name: string; data: Buffer }[] }

/** Minimal in-process imitation of the GitHub endpoints used by fluxplugin (search, releases, uploads, topics, raw files). */
export async function startFakeGitHub() {
  const repos = new Map<string, { topics: string[]; stars: number; releases: Release[] }>();
  const raw = new Map<string, Buffer>();
  const state = { rateLimited: false, token: "tok", requests: [] as string[] };
  let nextId = 1;
  let base = "";
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    state.requests.push(`${req.method} ${url.pathname}`);
    const send = (code: number, body: unknown, headers: Record<string, string> = {}) => (res.writeHead(code, { "content-type": "application/json", ...headers }), res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body)));
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    if (state.rateLimited && !url.pathname.startsWith("/dl/")) return send(403, { message: "rate limit" }, { "x-ratelimit-remaining": "0" });
    const authed = req.headers.authorization === `Bearer ${state.token}`;
    let m: RegExpExecArray | null;
    if (url.pathname === "/search/repositories") {
      const topic = /topic:([\w-]+)/.exec(url.searchParams.get("q") ?? "")?.[1];
      return send(200, { items: [...repos].filter(([, r]) => r.releases.length && (!topic || r.topics.includes(topic))).map(([full_name, r]) => ({ full_name, html_url: `https://github.com/${full_name}`, stargazers_count: r.stars })) });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/releases\/latest$/.exec(url.pathname))) {
      const r = repos.get(m[1]!)?.releases.at(-1);
      return r ? send(200, { tag_name: r.tag, assets: r.assets.map((a) => ({ name: a.name, browser_download_url: `${base}/dl/${m![1]}/${r.tag}/${a.name}` })) }) : send(404, { message: "Not Found" });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/releases$/.exec(url.pathname)) && req.method === "POST") {
      if (!authed) return send(401, { message: "Bad credentials" });
      const repo = repos.get(m[1]!);
      if (!repo) return send(404, { message: "Not Found" });
      const j = JSON.parse(body.toString());
      if (repo.releases.some((r) => r.tag === j.tag_name)) return send(422, { message: "Validation Failed" });
      const rel: Release = { id: nextId++, tag: j.tag_name, assets: [] };
      repo.releases.push(rel);
      return send(201, { id: rel.id, html_url: `https://github.com/${m[1]}/releases/tag/${rel.tag}`, upload_url: `${base}/uploads/${m[1]}/${rel.id}/assets{?name,label}` });
    }
    if ((m = /^\/uploads\/([^/]+\/[^/]+)\/(\d+)\/assets$/.exec(url.pathname)) && req.method === "POST") {
      if (!authed) return send(401, { message: "Bad credentials" });
      const rel = repos.get(m[1]!)?.releases.find((r) => r.id === Number(m![2]));
      if (!rel) return send(404, { message: "Not Found" });
      rel.assets.push({ name: url.searchParams.get("name")!, data: body });
      return send(201, { name: url.searchParams.get("name") });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/topics$/.exec(url.pathname))) {
      const repo = repos.get(m[1]!);
      if (!repo) return send(404, { message: "Not Found" });
      if (req.method === "PUT") repo.topics = JSON.parse(body.toString()).names;
      return send(200, { names: repo.topics });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(url.pathname))) return repos.has(m[1]!) ? send(200, { full_name: m[1], permissions: { push: authed } }) : send(404, { message: "Not Found" });
    if ((m = /^\/dl\/([^/]+\/[^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname))) {
      const a = repos.get(m[1]!)?.releases.find((r) => r.tag === m![2])?.assets.find((x) => x.name === m![3]);
      return a ? (res.writeHead(200, { "content-type": "application/octet-stream" }), res.end(a.data)) : send(404, {});
    }
    if (url.pathname.startsWith("/raw/")) {
      const f = raw.get(url.pathname.slice(5));
      return f ? (res.writeHead(200), res.end(f)) : send(404, {});
    }
    send(404, { message: "Not Found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url: base, rawBase: base + "/raw", state, repos, raw,
    addRepo: (name: string, stars = 0) => repos.set(name, { topics: [], stars, releases: [] }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
