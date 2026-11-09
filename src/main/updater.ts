import crypto from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { compareVersions, isValidVersion, planAppUpdate, stableStringify, type AppUpdatePlan, type ReleaseEntry, type UpdateManifest, type UpdateState } from "../core/index.js";

export type UpdateSource = { type: "http"; url: string; headers?: Record<string, string> } | { type: "github"; repo: string };

function urlsOf(src: UpdateSource): { latest: string; releases: string } {
  if (src.type === "github") {
    const base = `https://github.com/${src.repo}/releases/latest/download/`;
    return { latest: base + "latest.json", releases: base + "releases.json" };
  }
  const latest = src.url.endsWith("/") ? src.url + "latest.json" : src.url;
  return { latest, releases: new URL("releases.json", latest).href };
}

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/** Publisher side: signs a manifest with the update key (base64 PKCS#8 private key, see `generateSigningKeyPair`). */
export function signUpdateManifest(m: UpdateManifest, privateKeyB64: string): UpdateManifest {
  const { signature: _drop, ...body } = m;
  void _drop;
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  return { ...body, signature: crypto.sign(null, Buffer.from(stableStringify(body)), key).toString("base64") };
}

/** Client side: true only when the manifest was signed by the holder of `publicKeyB64`. */
export function verifyUpdateManifest(m: UpdateManifest, publicKeyB64: string): boolean {
  try {
    const { signature, ...body } = m;
    if (!signature) return false;
    return crypto.verify(null, Buffer.from(stableStringify(body)), crypto.createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" }), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export interface UpdaterOptions {
  source: UpdateSource;
  /** Folder for downloaded versions (`<userData>/app-updates`); the boot stub reads it. */
  dir: string;
  currentVersion: string;
  /** Root of the files the running app was loaded from. */
  payloadDir: string;
  /** Version of the installed application (installer). Updates whose `minHost` is higher need a full installer. */
  hostVersion?: string;
  /** Base64 SPKI public key: only manifests signed by the matching private key are accepted. Strongly recommended. */
  publicKey?: string;
  fetchImpl?: typeof fetch;
  onState?: (s: UpdateState) => void;
}

/**
 * Application updates, VS Code style: check → ask → download **only the files that changed** → switch at the next start, with
 * automatic rollback if the new version cannot start. Works against any static server or GitHub releases.
 */
export class AppUpdater {
  state: UpdateState;
  private manifest?: UpdateManifest;
  private plan?: AppUpdatePlan;
  private abort?: AbortController;
  private idle: (() => void)[] = [];
  backgroundAfterClose = false;

  constructor(private readonly o: UpdaterOptions) {
    this.state = { status: "idle", current: o.currentVersion };
  }

  private set(s: Partial<UpdateState>): UpdateState {
    this.state = { ...this.state, ...s };
    this.o.onState?.(this.state);
    if (this.state.status !== "downloading") for (const cb of this.idle.splice(0)) cb();
    return this.state;
  }

  private get f(): typeof fetch {
    return this.o.fetchImpl ?? fetch;
  }
  private get(url: string, signal?: AbortSignal): Promise<Response> {
    const headers = this.o.source.type === "http" ? this.o.source.headers : undefined;
    return this.f(url, { headers, signal: signal ?? AbortSignal.timeout(20_000) }).then((r) => {
      if (!r.ok) throw new Error(`update server responded ${r.status} for ${new URL(url).pathname}`);
      return r;
    });
  }

  /** Hashes of the installed files that the published manifest also lists (only those are needed). */
  private async localHashes(paths: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const p of paths) {
      try {
        out[p] = sha(await fs.readFile(path.join(this.o.payloadDir, p)));
      } catch {
        /* missing → will be downloaded */
      }
    }
    return out;
  }

  async check(): Promise<UpdateState> {
    if (this.state.status === "downloading") return this.state;
    this.set({ status: "checking", error: undefined });
    try {
      const { latest } = urlsOf(this.o.source);
      const m = (await (await this.get(latest)).json()) as UpdateManifest;
      if (!m || !isValidVersion(m.version) || typeof m.files !== "object") throw new Error("latest.json is not valid");
      if (this.o.publicKey && !verifyUpdateManifest(m, this.o.publicKey)) throw new Error("the update is not signed by the expected key: it was ignored");
      this.manifest = { ...m, files: Object.fromEntries(Object.entries(m.files).map(([p, f]) => [p, { ...f, url: new URL(f.url, latest).href }])) };
      if (compareVersions(m.version, this.o.currentVersion) <= 0) return this.set({ status: "up-to-date", latest: m.version, notes: m.notes });
      if (m.minHost && this.o.hostVersion && isValidVersion(m.minHost) && isValidVersion(this.o.hostVersion) && compareVersions(this.o.hostVersion, m.minHost) < 0) {
        this.plan = undefined;
        return this.set({ status: "available", latest: m.version, notes: m.notes, requiresInstaller: m.minHost, totalBytes: undefined, savedBytes: undefined });
      }
      this.plan = planAppUpdate({ version: this.o.currentVersion, files: await this.localHashes(Object.keys(m.files)) }, this.manifest);
      return this.set({ status: "available", requiresInstaller: undefined, latest: m.version, notes: m.notes, totalBytes: this.plan.totalBytes, savedBytes: this.plan.savedBytes, progress: undefined });
    } catch (e) {
      return this.set({ status: "error", error: (e as Error).message });
    }
  }

  async download(): Promise<UpdateState> {
    if (!this.manifest || !this.plan || this.state.status !== "available") return this.state;
    const m = this.manifest;
    const plan = this.plan;
    const partial = path.join(this.o.dir, `${m.version}.partial`);
    const final = path.join(this.o.dir, m.version);
    this.abort = new AbortController();
    const total = plan.totalBytes;
    let received = 0;
    let done = 0;
    const tick = () => this.set({ status: "downloading", progress: { receivedBytes: received, totalBytes: total, filesDone: done, filesTotal: plan.download.length } });
    try {
      await fs.rm(partial, { recursive: true, force: true });
      tick();
      for (const p of plan.reuse) {
        const dest = path.join(partial, p);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(path.join(this.o.payloadDir, p), dest); // unchanged: copied locally, nothing downloaded
      }
      for (const { path: rel, file } of plan.download) {
        const res = await this.get(file.url, this.abort.signal);
        const chunks: Buffer[] = [];
        const reader = res.body?.getReader();
        if (reader) {
          for (let r = await reader.read(); !r.done; r = await reader.read()) {
            chunks.push(Buffer.from(r.value));
            received += r.value.length;
            tick();
          }
        } else {
          chunks.push(Buffer.from(await res.arrayBuffer()));
          received += chunks[0]!.length;
        }
        const buf = Buffer.concat(chunks);
        if (sha(buf) !== file.sha256) throw new Error(`${rel} does not match its published checksum`);
        const dest = path.join(partial, rel);
        if (!dest.startsWith(partial + path.sep)) throw new Error(`unsafe path in update: ${rel}`);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, buf);
        done++;
        tick();
      }
      const files = Object.fromEntries(Object.entries(m.files).map(([p, f]) => [p, f.sha256]));
      await fs.writeFile(path.join(partial, "payload.json"), JSON.stringify({ version: m.version, files }));
      await fs.rm(final, { recursive: true, force: true });
      await fs.rename(partial, final);
      return this.set({ status: "ready", progress: { receivedBytes: total, totalBytes: total, filesDone: plan.download.length, filesTotal: plan.download.length } });
    } catch (e) {
      await fs.rm(partial, { recursive: true, force: true }).catch(() => undefined);
      const cancelled = this.abort?.signal.aborted;
      return this.set({ status: cancelled ? "available" : "error", error: cancelled ? undefined : (e as Error).message, progress: undefined });
    }
  }

  cancel(): void {
    this.abort?.abort();
  }

  /** Makes the downloaded version the one loaded at the next start. */
  apply(): void {
    if (this.state.status !== "ready" || !this.manifest) throw new Error("no downloaded update to apply");
    writeFileSync(path.join(this.o.dir, "current.json"), JSON.stringify({ version: this.manifest.version, dir: path.join(this.o.dir, this.manifest.version), boots: 0, confirmed: false }));
  }

  /** Full history (releases.json), newest first, with the installers of every version. */
  async releases(): Promise<ReleaseEntry[]> {
    const list = (await (await this.get(urlsOf(this.o.source).releases)).json()) as ReleaseEntry[];
    return list.filter((r) => isValidVersion(r.version)).sort((a, b) => compareVersions(b.version, a.version));
  }

  /** Runs `cb` as soon as no download is running (used to quit after a background download). */
  onceIdle(cb: () => void): void {
    if (this.state.status !== "downloading") cb();
    else this.idle.push(cb);
  }
}

interface Pointer {
  version: string;
  dir: string;
  boots: number;
  confirmed: boolean;
}

/**
 * Called first thing at startup (before the app loads): picks the newest valid payload. A new version that does not reach
 * `confirmBoot()` within two starts is abandoned and the bundled version runs again (automatic rollback).
 */
export function resolveBootTarget(updatesDir: string, bundledDir: string, bundledVersion?: string): { dir: string; version?: string; rolledBack?: boolean } {
  const file = path.join(updatesDir, "current.json");
  if (!existsSync(file)) return { dir: bundledDir };
  try {
    const p = JSON.parse(readFileSync(file, "utf8")) as Pointer;
    if ((bundledVersion && isValidVersion(bundledVersion) && compareVersions(p.version, bundledVersion) <= 0) || !existsSync(path.join(p.dir, "main.cjs"))) {
      rmSync(file, { force: true });
      return { dir: bundledDir };
    }
    if (!p.confirmed && p.boots >= 2) {
      writeFileSync(path.join(updatesDir, "bad.json"), JSON.stringify({ version: p.version, at: new Date().toISOString() }));
      rmSync(file, { force: true });
      return { dir: bundledDir, rolledBack: true };
    }
    writeFileSync(file, JSON.stringify({ ...p, boots: p.confirmed ? 0 : p.boots + 1 }));
    return { dir: p.dir, version: p.version };
  } catch {
    return { dir: bundledDir };
  }
}

/** The new version started fine (window shown): keep it. */
export function confirmBoot(updatesDir: string): void {
  const file = path.join(updatesDir, "current.json");
  try {
    const p = JSON.parse(readFileSync(file, "utf8")) as Pointer;
    writeFileSync(file, JSON.stringify({ ...p, confirmed: true, boots: 0 }));
  } catch {
    /* running the bundled version */
  }
}

/** Version of the payload the app was loaded from (updated payloads carry a payload.json), else `fallback`. */
export function payloadVersion(dir: string, fallback: string): string {
  try {
    return (JSON.parse(readFileSync(path.join(dir, "payload.json"), "utf8")) as { version: string }).version;
  } catch {
    return fallback;
  }
}
