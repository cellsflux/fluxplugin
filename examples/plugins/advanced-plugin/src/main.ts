import { definePlugin } from "fluxplugin";

export default definePlugin({
  hooks: [
    // Normalizes names before the host creates a student, and can veto invalid ones.
    { name: "before.item.create", handler: (ctx: any) => { ctx.input = { ...ctx.input, name: String(ctx.input.name ?? "").trim() }; if (!ctx.input.name) ctx.cancel("name is required"); } },
    { name: "transform.item.create", handler: (ctx: any) => ({ ...ctx.result, normalizedBy: "com.example.students" }) },
  ],
  events: [{ name: "item.created", handler: (p: any, ctx) => void ctx.logger.info(`item created: ${p.name}`) }],
  onActivate(ctx) {
    const stats = ctx.services.get<{ count(): number }>("stats.service"); // provided by the dependency
    ctx.logger.info(`started; ${stats?.count()} students according to the stats plugin`);
  },
});
