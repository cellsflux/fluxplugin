import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogQuery, InstallPlan, RegistryEntryLike, UpdateAnalysis } from "../core/index.js";
import { permissionInfo, paginate } from "../core/index.js";
import { alertApi, Button, Dialog, Icon, Img, Markdown, navigate, useT, usePluginFramework } from "../react/index.js";

const SENSITIVE = new Set(["network", "filesystem.read", "filesystem.write", "shell", "database", "clipboard", "window", "hooks"]);
export const priceLabel = (e: RegistryEntryLike, free: string): string => (e.pricing && e.pricing.model !== "free" ? `${e.pricing.amount ?? ""} ${e.pricing.currency ?? ""}${e.pricing.model === "subscription" ? " /mo" : ""}`.trim() || "Paid" : free);

/**
 * Install / update flows shared by the store and the detail pages. They always ask the server for a plan first (dependencies,
 * conflicts, licenses) and show a dialog when the user must decide something; nothing is installed before the confirmation.
 */
export function useInstallFlows(onDone: () => void) {
  const t = useT();
  const { client } = usePluginFramework();
  const [dialog, setDialog] = useState<React.ReactNode>(null);
  const [busy, setBusy] = useState("");
  const close = () => setDialog(null);

  const run = useCallback(async (id: string, update: boolean) => {
    setBusy(id);
    try {
      await (update ? client.update({ id }) : client.install({ id }));
      setDialog(null);
      onDone();
    } catch (e) {
      setDialog(<Dialog title={t("plugins.failed", "Installation failed")} onCancel={close}><div className="flux-note err">{(e as Error).message}</div></Dialog>);
    } finally {
      setBusy("");
    }
  }, [client, onDone, t]);

  const licenseDialog = useCallback((e: RegistryEntryLike, retry: () => void) => {
    let token = "";
    setDialog(
      <Dialog title={t("plugins.licenseTitle", "License required")} confirmLabel={t("plugins.activate", "Activate")} onCancel={close}
        onConfirm={() => void client.setLicense(e.id, token).then(() => (close(), retry())).catch((err: Error) => void alertApi.alert({ title: "Error", message: err.message }))}>
        <p>{t("plugins.paidBody", "{name} is a paid plugin ({price}). Enter the license key you received from the author.", { name: e.name, price: priceLabel(e, "") })}</p>
        {e.pricing?.purchaseUrl && <p><a href={e.pricing.purchaseUrl} target="_blank" rel="noopener noreferrer">{t("plugins.buy", "Buy a license")}</a></p>}
        <input className="flux-input" data-testid="license-input" placeholder="License key" onChange={(ev) => (token = ev.target.value)} />
      </Dialog>,
    );
  }, [client, t]);

  const install = useCallback(async (e: RegistryEntryLike) => {
    let plan: InstallPlan;
    try {
      plan = await client.plan(e.id);
    } catch (err) {
      return setDialog(<Dialog title={t("plugins.failed", "Installation failed")} onCancel={close}><div className="flux-note err">{(err as Error).message}</div></Dialog>);
    }
    if (!plan.ok) {
      if (plan.problems.every((p) => p.code === "license")) return licenseDialog(e, () => void install(e));
      return setDialog(
        <Dialog title={t("plugins.cannotInstall", "Cannot install {name}", { name: e.name })} onCancel={close}>
          <ul data-testid="plan-problems">{plan.problems.map((p, i) => <li key={i}>{p.message}</li>)}</ul>
        </Dialog>,
      );
    }
    const deps = plan.steps.filter((s) => s.reason === "dependency");
    const sensitive = plan.permissions.filter((p) => SENSITIVE.has(p) || p.startsWith("x."));
    if (!deps.length && !sensitive.length) return void run(e.id, false);
    setDialog(
      <Dialog title={t("plugins.confirmInstall", "Install {name}?", { name: e.name })} confirmLabel={t("plugins.get", "Get")} busy={busy === e.id} onCancel={close} onConfirm={() => void run(e.id, false)}>
        {deps.length > 0 && <><strong>{t("plugins.alsoInstalled", "These plugins are needed and will be installed first:")}</strong>
          <ul data-testid="plan-deps">{deps.map((s) => <li key={s.entry.id}>{s.entry.name} <span style={{ color: "var(--flux-muted)" }}>v{s.entry.version}</span></li>)}</ul></>}
        {sensitive.length > 0 && <><strong>{t("plugins.sensitiveAccess", "Sensitive access requested:")}</strong>
          <ul>{sensitive.map((p) => <li key={p}>{permissionInfo(p).title}</li>)}</ul></>}
      </Dialog>,
    );
  }, [client, licenseDialog, run, t, busy]);

  const update = useCallback(async (id: string, name: string) => {
    let a: UpdateAnalysis | undefined;
    try {
      a = await client.analyze(id);
    } catch {
      /* fall through: the server re-checks */
    }
    if (a?.status === "inconsistent") return setDialog(<Dialog title={t("plugins.inconsistent", "Cannot update {name}", { name })} onCancel={close}><div className="flux-note err">{a.reasons.join(" ")}</div></Dialog>);
    if (!a || !a.needsConfirmation) return void run(id, true);
    setDialog(
      <Dialog title={t("plugins.updateTitle", "Update {name} to {v}?", { name, v: a.to })} confirmLabel={t("plugins.update", "Update")} onCancel={close} onConfirm={() => void run(id, true)}>
        <div className="flux-note" data-testid="update-reasons"><ul>{a.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></div>
        {a.files && <p>{a.files.added.length} files added · {a.files.removed.length} removed · {a.files.changed.length} changed</p>}
        {a.notes.map((n) => <Markdown key={n.version} source={n.notes} />)}
      </Dialog>,
    );
  }, [client, run, t]);

  return { dialog, busy, install, update };
}

const SIZES = [5, 10, 20, 50];

/** Store home: search, categories, free/paid filter, tiles, pagination. Filtering happens before paging; results replace (never append to) the state. */
export function StoreView({ mode }: { mode: "discover" | "updates" }): React.ReactElement {
  const t = useT();
  const { client } = usePluginFramework();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [price, setPrice] = useState<"all" | "free" | "paid">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<{ items: RegistryEntryLike[]; total: number; totalAll: number; pages: number; page: number; pageSize: number; categories: { name: string; count: number }[]; errors: { source: string; message: string }[] }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const flows = useInstallFlows(useCallback(() => setTick((x) => x + 1), []));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let live = true; // a slow older request never overwrites a newer one
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setLoading(true);
      setError("");
      const query: CatalogQuery = { q, category: category || undefined, price, page, pageSize };
      const req = mode === "discover"
        ? client.catalog(query)
        : client.updates().then((all) => ({ ...paginate(all.filter((e) => !q || `${e.name} ${e.id}`.toLowerCase().includes(q.toLowerCase())), page, pageSize), totalAll: all.length, categories: [], errors: [], conflicts: [], fetchedAt: 0 }));
      req.then((r) => live && setData(r as never)).catch((e: Error) => live && (setData(undefined), setError(e.message))).finally(() => live && setLoading(false));
    }, q ? 300 : 0);
    return () => { live = false; };
  }, [client, mode, q, category, price, page, pageSize, tick]);

  const first = data && data.total ? (data.page - 1) * data.pageSize + 1 : 0;
  const last = data ? Math.min(data.page * data.pageSize, data.total) : 0;
  const numbers = useMemo(() => {
    if (!data) return [] as number[];
    const s = new Set([1, data.pages, data.page - 1, data.page, data.page + 1]);
    return [...s].filter((n) => n >= 1 && n <= data.pages).sort((a, b) => a - b);
  }, [data]);

  return (
    <div data-testid={"store-" + mode}>
      <div className="flux-pm-top">
        <input className="flux-input" style={{ maxWidth: 320 }} placeholder={t("plugins.search", "Search plugins")} value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} aria-label="Search plugins" />
        {mode === "discover" && (
          <select className="flux-select" value={price} aria-label="Price" data-testid="price-filter" onChange={(e) => (setPrice(e.target.value as "all" | "free" | "paid"), setPage(1))}>
            <option value="all">{t("plugins.allPrices", "Free & paid")}</option><option value="free">{t("plugins.free", "Free")}</option><option value="paid">{t("plugins.paid", "Paid")}</option>
          </select>
        )}
        <Button size="sm" onClick={() => { void client.catalog({ refresh: true }).then(() => setTick((x) => x + 1)); }} title="Refresh the catalog">{t("plugins.refresh", "Refresh")}</Button>
      </div>
      {mode === "discover" && data && data.categories.length > 0 && (
        <div className="flux-chips" data-testid="categories">
          <button className="flux-chip" data-on={!category || undefined} onClick={() => (setCategory(""), setPage(1))}>{t("plugins.all", "All")}</button>
          {data.categories.map((c) => <button key={c.name} className="flux-chip" data-on={category === c.name || undefined} onClick={() => (setCategory(c.name), setPage(1))}>{c.name} · {c.count}</button>)}
        </div>
      )}
      {data?.errors?.map((e) => <div key={e.source} className="flux-note err" role="alert" data-testid="store-error"><strong>{e.source}</strong>: {e.message}</div>)}
      {error && <div className="flux-note err" role="alert" data-testid="store-error">{error}</div>}
      {loading && !data && <div className="flux-loading">{t("plugins.searching", "Searching the plugin stores…")}</div>}
      {data && !loading && data.total === 0 && !error && <div className="flux-empty" data-testid="store-empty">{mode === "updates" ? t("plugins.upToDate", "Everything is up to date.") : t("plugins.storeEmpty", "No plugins found.")}</div>}
      {data && data.items.length > 0 && (
        <div className="flux-store-grid" style={{ opacity: loading ? 0.6 : 1 }} data-testid="store-grid">
          {data.items.map((e) => {
            const update = e.updateAvailable;
            return (
              <div key={e.id} className="flux-tile" role="link" tabIndex={0} data-store-entry={e.id} onClick={() => navigate("/plugins/store/" + e.id)} onKeyDown={(ev) => ev.key === "Enter" && navigate("/plugins/store/" + e.id)}>
                <div className="flux-tile-head">
                  <Img className="flux-pm-icon" src={e.iconUrl} base={e.location} alt="" fallback={<span className="flux-pm-icon" style={{ background: "var(--flux-accent)", color: "#fff", alignItems: "center", justifyContent: "center" }}><Icon name="plug" size={24} /></span>} />
                  <div style={{ minWidth: 0 }}><h4>{e.name}</h4><div className="by">{e.author ?? e.id}{e.conflict ? " ⚠" : ""}</div></div>
                </div>
                <p>{e.description}</p>
                <div className="flux-tile-foot" onClick={(ev) => ev.stopPropagation()}>
                  <span className={"flux-pill" + (e.pricing && e.pricing.model !== "free" ? " warn" : " ok")}>{priceLabel(e, t("plugins.free", "Free"))}</span>
                  {e.installedVersion && !update ? <Button size="sm" onClick={() => navigate("/plugins/" + e.id)}>{t("plugins.open", "Open")}</Button>
                    : update ? <Button size="sm" variant="primary" disabled={flows.busy === e.id} onClick={() => void flows.update(e.id, e.name)} data-testid={"update-" + e.id}>{t("plugins.update", "Update")}</Button>
                    : <Button size="sm" variant="primary" disabled={flows.busy === e.id} onClick={() => void flows.install(e)} data-testid={"get-" + e.id}>{flows.busy === e.id ? "…" : e.pricing && e.pricing.model !== "free" ? t("plugins.buyShort", "Buy") : t("plugins.get", "Get")}</Button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {data && data.total > 0 && (
        <div className="flux-pager" data-testid="pager">
          <span className="count" data-testid="pager-count">
            {t("plugins.showing", "{from}–{to} of {total}", { from: first, to: last, total: data.total })}
            {data.total !== data.totalAll ? ` · ${t("plugins.filteredFrom", "filtered from {n}", { n: data.totalAll })}` : ""}
          </span>
          <span className="pages">
            <button className="pg" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)} aria-label="Previous page" data-testid="prev"><Icon name="back" size={16} /></button>
            {numbers.map((n, i) => <React.Fragment key={n}>{i > 0 && numbers[i - 1]! < n - 1 && <span>…</span>}<button className="pg" data-on={n === data.page || undefined} onClick={() => setPage(n)} data-testid={"page-" + n}>{n}</button></React.Fragment>)}
            <button className="pg" disabled={data.page >= data.pages} onClick={() => setPage(data.page + 1)} aria-label="Next page" data-testid="next"><Icon name="chevronRight" size={16} /></button>
          </span>
          <label className="count">{t("plugins.perPage", "Per page")}{" "}
            <select className="flux-select" value={pageSize} data-testid="page-size" onChange={(e) => (setPageSize(Number(e.target.value)), setPage(1))}>{SIZES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
          </label>
        </div>
      )}
      {flows.dialog}
    </div>
  );
}
