import { promises as fs } from "node:fs";
import path from "node:path";
import type { StorageBackend } from "../core/index.js";

const safe = (ns: string) => ns.replace(/[^a-zA-Z0-9._-]/g, "_");

async function atomicWrite(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, file);
}

/** One JSON file per plugin namespace, written atomically (tmp + rename). */
export class FsStorageBackend implements StorageBackend {
  constructor(private readonly dir: string) {}
  private file(ns: string) {
    return path.join(this.dir, `${safe(ns)}.json`);
  }
  async read(ns: string): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(await fs.readFile(this.file(ns), "utf8")) as Record<string, unknown>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  }
  async write(ns: string, data: Record<string, unknown>): Promise<void> {
    await atomicWrite(this.file(ns), JSON.stringify(data));
  }
  async remove(ns: string): Promise<void> {
    await fs.rm(this.file(ns), { force: true });
  }
}

/** Persists the list of disabled plugins and approved permissions. Updates are serialized (no lost writes). */
export class JsonStateFile {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}

  async readAll(): Promise<{ disabled: string[]; approved: Record<string, string[]> }> {
    try {
      const j = JSON.parse(await fs.readFile(this.file, "utf8"));
      return { disabled: Array.isArray(j.disabled) ? j.disabled : [], approved: j.approved && typeof j.approved === "object" ? j.approved : {} };
    } catch {
      return { disabled: [], approved: {} };
    }
  }

  /** Merges `patch(current)` into the file. Concurrent calls run one after the other. */
  update(patch: Partial<{ disabled: string[]; approved: Record<string, string[]> }> | ((cur: { disabled: string[]; approved: Record<string, string[]> }) => Partial<{ disabled: string[]; approved: Record<string, string[]> }>)): Promise<void> {
    const run = this.queue.then(async () => {
      const cur = await this.readAll();
      const p = typeof patch === "function" ? patch(cur) : patch;
      await atomicWrite(this.file, JSON.stringify({ ...cur, ...p }, null, 2));
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Resolves once every queued write has hit the disk. */
  async flush(): Promise<void> {
    await this.queue;
  }
}
