/**
 * Minimal, dependency-free semver implementation covering what the framework needs:
 * parse, compare, and range satisfaction for `^`, `~`, `>=`, `>`, `<=`, `<`, `=`, `*`, `x`-ranges
 * and space-separated comparator sets (AND) as well as `||` (OR).
 */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(v: string): SemVer | null {
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

export function isValidVersion(v: string): boolean {
  return parseVersion(v) !== null;
}

function cmpIdent(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`Invalid version: ${!x ? a : b}`);
  for (const k of ["major", "minor", "patch"] as const) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (!x.prerelease.length && !y.prerelease.length) return 0;
  if (!x.prerelease.length) return 1;
  if (!y.prerelease.length) return -1;
  const len = Math.max(x.prerelease.length, y.prerelease.length);
  for (let i = 0; i < len; i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const c = cmpIdent(p, q);
    if (c !== 0) return c;
  }
  return 0;
}

interface Comparator {
  op: ">=" | ">" | "<=" | "<" | "=";
  version: string;
}

function parsePartial(token: string): { major: number; minor?: number; patch?: number; pre?: string } | null {
  const m = /^v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-([0-9A-Za-z.-]+))?$/.exec(token);
  if (!m) return null;
  const num = (x: string | undefined) => (x === undefined || /^[xX*]$/.test(x) ? undefined : Number(x));
  const major = num(m[1]);
  if (major === undefined) return { major: -1 }; // wildcard marker
  return { major, minor: num(m[2]), patch: num(m[3]), pre: m[4] };
}

const ver = (a: number, b: number, c: number, pre?: string) => `${a}.${b}.${c}${pre ? `-${pre}` : ""}`;

function expand(token: string): Comparator[] | null {
  token = token.trim();
  if (token === "" || token === "*" || token === "x" || token === "X") return [{ op: ">=", version: "0.0.0" }];
  const prefix = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token);
  if (!prefix) return null;
  const sym = prefix[1] ?? "";
  const p = parsePartial(prefix[2]!);
  if (!p) return null;
  if (p.major === -1) return [{ op: ">=", version: "0.0.0" }];
  const { major, minor, patch, pre } = p;
  const lo = ver(major, minor ?? 0, patch ?? 0, pre);
  switch (sym) {
    case "^": {
      let hi: string;
      if (major > 0 || minor === undefined) hi = ver(major + 1, 0, 0);
      else if (minor > 0 || patch === undefined) hi = ver(0, minor + 1, 0);
      else hi = ver(0, 0, patch + 1);
      return [
        { op: ">=", version: lo },
        { op: "<", version: hi },
      ];
    }
    case "~": {
      const hi = minor === undefined ? ver(major + 1, 0, 0) : ver(major, minor + 1, 0);
      return [
        { op: ">=", version: lo },
        { op: "<", version: hi },
      ];
    }
    case ">=":
      return [{ op: ">=", version: lo }];
    case ">":
      if (minor === undefined) return [{ op: ">=", version: ver(major + 1, 0, 0) }];
      if (patch === undefined) return [{ op: ">=", version: ver(major, minor + 1, 0) }];
      return [{ op: ">", version: lo }];
    case "<=":
      if (minor === undefined) return [{ op: "<", version: ver(major + 1, 0, 0) }];
      if (patch === undefined) return [{ op: "<", version: ver(major, minor + 1, 0) }];
      return [{ op: "<=", version: lo }];
    case "<":
      return [{ op: "<", version: lo }];
    default: {
      // exact or x-range
      if (minor === undefined)
        return [
          { op: ">=", version: ver(major, 0, 0) },
          { op: "<", version: ver(major + 1, 0, 0) },
        ];
      if (patch === undefined)
        return [
          { op: ">=", version: ver(major, minor, 0) },
          { op: "<", version: ver(major, minor + 1, 0) },
        ];
      return [{ op: "=", version: lo }];
    }
  }
}

function tokenize(set: string): string[] {
  // Join "op version" written with spaces (e.g. ">= 1.2.0") into a single token.
  const raw = set.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i]!;
    if (/^(\^|~|>=|<=|>|<|=)$/.test(t) && raw[i + 1]) out.push(t + raw[++i]!);
    else out.push(t);
  }
  return out;
}

export function isValidRange(range: string): boolean {
  try {
    for (const set of range.split("||")) for (const tok of tokenize(set)) if (!expand(tok)) return false;
    return true;
  } catch {
    return false;
  }
}

export function satisfies(version: string, range: string): boolean {
  if (!isValidVersion(version)) return false;
  const v = parseVersion(version)!;
  for (const set of range.split("||")) {
    const tokens = tokenize(set);
    const comparators: Comparator[] = [];
    let valid = true;
    for (const t of tokens.length ? tokens : ["*"]) {
      const e = expand(t);
      if (!e) {
        valid = false;
        break;
      }
      comparators.push(...e);
    }
    if (!valid) continue;
    const allOk = comparators.every((c) => {
      const r = compareVersions(version, c.version);
      switch (c.op) {
        case ">=":
          return r >= 0;
        case ">":
          return r > 0;
        case "<=":
          return r <= 0;
        case "<":
          return r < 0;
        case "=":
          return r === 0;
      }
    });
    // Pre-releases only satisfy ranges that explicitly mention a pre-release on the same tuple.
    const preOk =
      v.prerelease.length === 0 ||
      comparators.some((c) => {
        const cv = parseVersion(c.version)!;
        return cv.prerelease.length > 0 && cv.major === v.major && cv.minor === v.minor && cv.patch === v.patch;
      });
    if (allOk && preOk) return true;
  }
  return false;
}
