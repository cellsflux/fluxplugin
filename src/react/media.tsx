import React, { useEffect, useMemo, useState } from "react";
import type { VideoInfo } from "../core/index.js";
import { Icon } from "./icons.js";

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/i;

/** Detects an image type from the first bytes of a (base64 or binary) payload. */
function sniff(bytes: Uint8Array): string | undefined {
  const b = (...v: number[]) => v.every((x, i) => bytes[i] === x);
  if (b(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (b(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (b(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (b(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  if (b(0x42, 0x4d)) return "image/bmp";
  const head = new TextDecoder().decode(bytes.slice(0, 120)).trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return undefined;
}

export type ImageInput = string | Blob | ArrayBuffer | Uint8Array | null | undefined;

export interface ResolvedImage {
  src: string;
  /** Call when the image is no longer used (revokes object URLs). */
  release?: () => void;
}

/**
 * Turns any supported image source into something an <img> can show:
 * https/http URLs, `data:image/*;base64,…`, raw base64 text, `blob:` URLs, Blob/File/ArrayBuffer objects, `file://` URLs,
 * absolute local paths (C:\… or /…), and relative paths (resolved against `base`, e.g. a plugin's asset URL).
 * Anything else (javascript:, other data: types…) returns undefined.
 */
export function toImageSrc(input: ImageInput, opts: { base?: string } = {}): ResolvedImage | undefined {
  if (input == null || input === "") return undefined;
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    if (input.type && !IMAGE_MIME.test(input.type)) return undefined;
    const url = URL.createObjectURL(input);
    return { src: url, release: () => URL.revokeObjectURL(url) };
  }
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    const mime = sniff(bytes);
    if (!mime) return undefined;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    return { src: url, release: () => URL.revokeObjectURL(url) };
  }
  const s = String(input).trim();
  if (/^data:/i.test(s)) {
    const m = /^data:([^;,]+)[;,]/i.exec(s);
    return m && IMAGE_MIME.test(m[1]!) ? { src: s } : undefined;
  }
  if (/^blob:/i.test(s) || /^https?:\/\//i.test(s) || /^file:\/\//i.test(s)) return { src: s };
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[a-z]:[\\/]/i.test(s)) return /^fluxplugin:\/\//i.test(s) ? { src: s } : undefined; // other schemes (javascript:, …)
  if (/^[a-z]:[\\/]/i.test(s)) return { src: "file:///" + s.replace(/\\/g, "/") }; // Windows path
  // raw base64 (no data: prefix)
  if (s.length > 64 && /^[A-Za-z0-9+/=\s]+$/.test(s)) {
    try {
      const bin = atob(s.replace(/\s/g, ""));
      const bytes = Uint8Array.from(bin.slice(0, 160), (c) => c.charCodeAt(0));
      const mime = sniff(bytes);
      if (mime) return { src: `data:${mime};base64,${s.replace(/\s/g, "")}` };
    } catch {
      /* not base64 */
    }
  }
  if (s.startsWith("/") && typeof location !== "undefined" && location.protocol === "file:") return { src: "file://" + s }; // absolute posix path in Electron
  if (opts.base && !s.startsWith("/")) {
    try {
      return { src: new URL(s, opts.base).href };
    } catch {
      return undefined;
    }
  }
  return { src: s };
}

/** <img> that accepts any source accepted by `toImageSrc`, with a graceful placeholder when it fails to load. */
export function Img({ src, base, alt = "", fallback, className, style, ...rest }: { src: ImageInput; base?: string; alt?: string; fallback?: React.ReactNode } & Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src" | "alt">): React.ReactElement {
  const [failed, setFailed] = useState(false);
  const resolved = useMemo(() => toImageSrc(src, { base }), [src, base]);
  useEffect(() => {
    setFailed(false);
    return () => resolved?.release?.();
  }, [resolved]);
  if (!resolved || failed) return <>{fallback ?? <span className={"flux-img-fallback " + (className ?? "")} style={style} role="img" aria-label={alt}><Icon name="image" size={18} /></span>}</>;
  return <img {...rest} className={className} style={style} src={resolved.src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

/**
 * Video player. Hosted players (YouTube, Vimeo, Dailymotion, Loom, Streamable) use a sandboxed iframe; direct media files
 * (mp4/webm/ogg/mov, https or shipped inside a plugin) use the native HTML5 player; anything else becomes a link.
 */
export function VideoPlayer({ video, poster, title = "Video" }: { video: VideoInfo; poster?: string; title?: string }): React.ReactElement {
  if (video.kind === "html5" && video.src) {
    return (
      <video className="flux-video" data-testid="plugin-video" data-kind="html5" controls playsInline preload="metadata" poster={poster} aria-label={title}>
        <source src={video.src} />
        <a href={video.url} target="_blank" rel="noopener noreferrer">Download the video</a>
      </video>
    );
  }
  if (video.embedUrl) {
    return (
      <iframe className="flux-video" data-testid="plugin-video" data-kind={video.kind} src={video.embedUrl} title={title} loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen; autoplay=(self)"
        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen />
    );
  }
  return (
    <a className="flux-video-link" data-testid="plugin-video" data-kind="link" href={video.url} target="_blank" rel="noopener noreferrer">
      <Icon name="play" size={18} /> Watch the video
    </a>
  );
}
