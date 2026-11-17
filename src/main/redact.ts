import crypto from "node:crypto";
import type { RegistryEntryLike } from "../core/index.js";

/**
 * What reaches the interface must not reveal where things come from: store URLs, update servers, download links.
 * (Anything stored in the application itself can still be extracted by a determined person; real protection is server-side:
 * authentication, signed manifests, licenses. This keeps URLs out of the UI, the DOM, devtools and IPC messages.)
 */
export function redactMessage(msg: string): string {
  return String(msg)
    .replace(/\b(?:https?|wss?|ftp|file):\/\/[^\s"')<>]+/gi, "[server]")
    .replace(/\b(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|EHOSTUNREACH)\b[^\n]*/g, "the server cannot be reached ($1)");
}

export const assetToken = (url: string): string => crypto.createHash("sha256").update(url).digest("hex").slice(0, 32);

export interface PublicEntryOptions {
  /** Internal registry name → label the user may see ("Official store"). */
  label(source: string): string;
  /** Turns a remote asset URL into an opaque local URL served by the main process. */
  asset(url: string): string;
}

/** The entry as the renderer sees it: no download locations, no store URLs, no hashes, no raw links. */
export function publicEntry(e: RegistryEntryLike, o: PublicEntryOptions): RegistryEntryLike {
  const links = e.links ?? {};
  const linkLabels = [...Object.keys(links), ...(e.homepage ? ["website"] : []), ...(e.pricing?.purchaseUrl ? ["purchase"] : [])];
  return {
    ...e,
    source: o.label(e.source),
    sources: [...new Set((e.sources ?? [e.source]).map(o.label))],
    location: "",
    iconUrl: e.iconUrl ? o.asset(e.iconUrl) : undefined,
    bannerUrl: e.bannerUrl ? o.asset(e.bannerUrl) : undefined,
    screenshots: e.screenshots?.map(o.asset),
    pricing: e.pricing && { ...e.pricing, purchaseUrl: undefined, publicKey: undefined },
    linkLabels,
    links: undefined,
    homepage: undefined,
    folder: undefined,
    files: undefined,
    hashes: undefined,
    sha256: undefined,
  };
}
