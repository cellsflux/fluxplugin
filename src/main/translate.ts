import crypto from "node:crypto";
import { promises as fs } from "node:fs";

export interface TranslateConfig {
  /** Off by default: README text is sent to the translation service you configure. */
  enabled?: boolean;
  provider?: "libretranslate" | "google" | "custom";
  /** libretranslate: instance URL (https://libretranslate.com or your own). custom: POST endpoint. */
  url?: string;
  /** Name of the environment variable holding the API key (never put the key itself in config files). */
  apiKeyEnv?: string;
}

export interface Translator {
  name: string;
  translate(text: string, from: string | undefined, to: string): Promise<string>;
}

export function createTranslator(cfg: TranslateConfig | undefined, env: Record<string, string | undefined> = process.env, f: typeof fetch = fetch): Translator | undefined {
  if (!cfg?.enabled) return undefined;
  const key = cfg.apiKeyEnv ? env[cfg.apiKeyEnv] : undefined;
  const post = async (url: string, body: unknown): Promise<any> => {
    const r = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`translation service responded ${r.status}`);
    return r.json();
  };
  switch (cfg.provider ?? "libretranslate") {
    case "google":
      if (!key) throw new Error(`translate.provider "google" needs the API key in the environment variable ${cfg.apiKeyEnv ?? "(apiKeyEnv)"}`);
      return { name: "Google Translate", translate: async (q, from, to) => (await post(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(key)}`, { q, source: from, target: to, format: "text" })).data.translations[0].translatedText };
    case "custom":
      if (!cfg.url) throw new Error('translate.provider "custom" needs "url"');
      return { name: new URL(cfg.url).hostname, translate: async (text, from, to) => String((await post(cfg.url!, { text, from, to })).text) };
    default: {
      const base = (cfg.url ?? "https://libretranslate.com").replace(/\/$/, "");
      return { name: "LibreTranslate", translate: async (q, from, to) => String((await post(`${base}/translate`, { q, source: from ?? "auto", target: to, format: "text", api_key: key })).translatedText) };
    }
  }
}

const STOP: Record<string, string[]> = {
  en: ["the", "and", "of", "to", "is", "in", "that", "for", "with", "you", "this", "are", "your"],
  fr: ["le", "la", "les", "et", "des", "est", "une", "pour", "dans", "que", "vous", "avec", "sur", "du"],
  es: ["el", "la", "los", "y", "de", "es", "una", "para", "con", "que", "en", "por", "las"],
  de: ["der", "die", "das", "und", "ist", "mit", "für", "ein", "eine", "nicht", "sie", "den", "auf"],
  pt: ["o", "os", "e", "de", "é", "uma", "para", "com", "que", "em", "você", "não", "das"],
  it: ["il", "lo", "e", "di", "è", "una", "per", "con", "che", "in", "non", "gli", "della"],
};

/** Cheap language guess from stop-words (en, fr, es, de, pt, it). Returns undefined when unsure — declare `"language"` in plugin.json to be exact. */
export function detectLanguage(text: string): string | undefined {
  const words = text.toLowerCase().replace(/```[\s\S]*?```/g, " ").match(/\p{L}+/gu) ?? [];
  if (words.length < 12) return undefined;
  const scores = Object.entries(STOP).map(([l, sw]) => [l, words.filter((w) => sw.includes(w)).length / words.length] as const).sort((a, b) => b[1] - a[1]);
  return scores[0]![1] >= 0.08 && scores[0]![1] > (scores[1]?.[1] ?? 0) * 1.3 ? scores[0]![0] : undefined;
}

export class TranslationCache {
  private data: Record<string, string> = {};
  private loaded = false;
  constructor(private readonly file?: string) {}
  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (this.file) this.data = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      /* first run */
    }
  }
  async get(k: string) {
    await this.load();
    return this.data[k];
  }
  private queue: Promise<unknown> = Promise.resolve();
  async set(k: string, v: string) {
    await this.load();
    this.data[k] = v;
    // Writes run one after the other (parallel translations would otherwise interleave and corrupt the file).
    if (this.file) this.queue = this.queue.then(() => fs.writeFile(this.file!, JSON.stringify(this.data))).catch(() => undefined);
    await this.queue;
  }
}

/** Translates Markdown paragraph by paragraph; fenced code blocks are left untouched. Results are cached per (engine, language, text). */
export async function translateMarkdown(md: string, to: string, from: string | undefined, tr: Translator, cache = new TranslationCache()): Promise<string> {
  const parts = md.split(/(```[\s\S]*?```)/g);
  const jobs: { i: number; text: string }[] = [];
  const out = [...parts];
  parts.forEach((p, i) => {
    if (i % 2 === 1) return;
    p.split(/\n{2,}/).forEach((para, j) => {
      if (/\p{L}/u.test(para)) jobs.push({ i: i * 10_000 + j, text: para });
    });
  });
  const done = new Map<number, string>();
  const queue = [...jobs];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const key = crypto.createHash("sha1").update(`${tr.name}|${to}|${job.text}`).digest("hex");
      let v = await cache.get(key);
      if (v === undefined) {
        v = await tr.translate(job.text.slice(0, 4500), from, to);
        await cache.set(key, v);
      }
      done.set(job.i, v);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  parts.forEach((p, i) => {
    if (i % 2 === 1) return;
    out[i] = p.split(/\n{2,}/).map((para, j) => done.get(i * 10_000 + j) ?? para).join("\n\n");
  });
  return out.join("");
}
