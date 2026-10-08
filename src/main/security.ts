import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { PluginManifest } from "../core/index.js";

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

export const sha256File = async (file: string): Promise<string> => "sha256-" + crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");

/** Deterministic JSON (sorted keys) so signatures do not depend on key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function resolveInside(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(path.resolve(root) + path.sep)) throw new IntegrityError(`path escapes plugin directory: ${rel}`);
  return abs;
}

/** Fills `integrity` for every entry file of a manifest. Used by `fluxplugin package`. */
export async function computeIntegrity(root: string, manifest: Pick<PluginManifest, "main" | "preload" | "renderer" | "styles">): Promise<Record<string, string>> {
  const files = [manifest.main, manifest.preload, manifest.renderer, ...(manifest.styles ?? [])].filter((f): f is string => !!f);
  const out: Record<string, string> = {};
  for (const f of files) {
    const rel = f.replace(/^\.\//, "");
    try {
      out[rel] = await sha256File(resolveInside(root, rel));
    } catch {
      /* missing optional files are reported by validate */
    }
  }
  return out;
}

export function generateSigningKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

const signedPayload = (m: Record<string, unknown>): string => {
  const { signature: _s, ...rest } = m;
  return canonicalJson(rest);
};

export function signManifest(manifest: Record<string, unknown>, privateKeyB64: string): Record<string, unknown> {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  const pub = crypto.createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
  const value = crypto.sign(null, Buffer.from(signedPayload(manifest)), key).toString("base64");
  return { ...manifest, signature: { algorithm: "ed25519", publicKey: pub, value } };
}

export interface VerifyOptions {
  /** Verify the hashes listed in `manifest.integrity` (default true). */
  verifyIntegrity?: boolean;
  /** Public keys (base64 SPKI DER) allowed to sign plugins. */
  trustedKeys?: string[];
  /** Refuse plugins without a valid signature from a trusted key. Default false. */
  requireSignature?: boolean;
}

/** Throws `IntegrityError` when a check fails. Returns warnings otherwise. */
export async function verifyPlugin(root: string, raw: Record<string, unknown>, manifest: PluginManifest, opts: VerifyOptions = {}): Promise<string[]> {
  const warnings: string[] = [];
  if (opts.verifyIntegrity !== false && manifest.integrity) {
    for (const [rel, expected] of Object.entries(manifest.integrity)) {
      let actual: string;
      try {
        actual = await sha256File(resolveInside(root, rel));
      } catch {
        throw new IntegrityError(`integrity: file "${rel}" is missing`);
      }
      if (actual !== expected) throw new IntegrityError(`integrity: "${rel}" does not match its recorded hash (file was modified)`);
    }
  } else if (opts.verifyIntegrity !== false && opts.requireSignature) {
    throw new IntegrityError("integrity hashes are required but missing");
  }
  const sig = manifest.signature;
  if (sig) {
    let ok = false;
    try {
      const pub = crypto.createPublicKey({ key: Buffer.from(sig.publicKey, "base64"), format: "der", type: "spki" });
      ok = crypto.verify(null, Buffer.from(signedPayload(raw)), pub, Buffer.from(sig.value, "base64"));
    } catch {
      ok = false;
    }
    if (!ok) throw new IntegrityError("signature is invalid");
    if (opts.trustedKeys && !opts.trustedKeys.includes(sig.publicKey)) {
      if (opts.requireSignature) throw new IntegrityError("signed by an untrusted key");
      warnings.push("signed by an untrusted key");
    }
  } else if (opts.requireSignature) {
    throw new IntegrityError("plugin is not signed");
  }
  return warnings;
}
