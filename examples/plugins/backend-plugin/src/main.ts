import { definePlugin, defineIPC, s } from "fluxplugin";

const Stats = s.object({ students: s.number(), uptimeSec: s.number(), at: s.number() });
const started = Date.now();
let students = 12;

export default definePlugin({
  config: { version: 1, schema: s.object({ intervalMs: s.number({ min: 500, max: 60000 }).default(3000), verbose: s.boolean().default(false) }) },
  ipc: [
    defineIPC({ name: "stats.get", output: Stats, handler: () => ({ students, uptimeSec: Math.round((Date.now() - started) / 1000), at: Date.now() }) }),
    defineIPC({ name: "stats.addStudent", input: s.object({ count: s.number({ int: true, min: 1, max: 100 }) }), output: Stats,
      handler: ({ count }) => ((students += count), { students, uptimeSec: Math.round((Date.now() - started) / 1000), at: Date.now() }) }),
  ],
  preload: { stats: { get: "stats.get", add: "stats.addStudent", onUpdated: { kind: "event", channel: "stats.updated" } } },
  services: { "stats.service": { count: () => students } },
  async onActivate(ctx) {
    const { intervalMs } = await ctx.config.get();
    const t = setInterval(() => ctx.ipc.send("stats.updated", { students, at: Date.now() }), intervalMs);
    ctx.lifecycle.onDeactivate(() => clearInterval(t)); // timers must be cleaned: nothing leaks after disable
  },
});
