/**
 * A tiny lossless JSON parser/serializer + structural reconciler, purpose-built for regen-golden.ts.
 *
 * Python's `json.dumps` writes whole-number floats as `1.0`; JS's `JSON.stringify` always writes
 * `1`, and that type information is gone now that the Python source is gone. Plain re-serialization
 * would therefore rewrite huge swaths of a fixture that didn't actually change, making diffs unreadable.
 *
 * Fix: parse the previous fixture losslessly (every leaf keeps its source text), walk the freshly
 * computed value against it, and reuse the old raw text wherever the value is unchanged (within
 * float tolerance). Only genuinely changed leaves get freshly formatted.
 */

export type JsonPrimitive = string | number | boolean | null;

export type JNode =
  | { kind: 'leaf'; raw: string; value: JsonPrimitive; span: [number, number] }
  | { kind: 'arr'; items: JNode[]; span: [number, number] }
  | { kind: 'obj'; entries: Array<{ key: string; value: JNode }>; span: [number, number] };

const FLOAT_TOLERANCE = 1e-9;

interface ParseState {
  text: string;
  pos: number;
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

function skipWs(s: ParseState): void {
  while (s.pos < s.text.length && WHITESPACE.has(s.text[s.pos] as string)) {
    s.pos++;
  }
}

function fail(s: ParseState, message: string): never {
  throw new Error(`losslessJson: ${message} at position ${s.pos}`);
}

function parseStringToken(s: ParseState): { raw: string; value: string; span: [number, number] } {
  const start = s.pos;
  if (s.text[s.pos] !== '"') {
    fail(s, 'expected string');
  }
  s.pos++;
  while (true) {
    const ch = s.text[s.pos];
    if (ch === undefined) {
      fail(s, 'unterminated string');
    }
    if (ch === '\\') {
      s.pos += 2;
      continue;
    }
    s.pos++;
    if (ch === '"') {
      break;
    }
  }
  const raw = s.text.slice(start, s.pos);
  return { raw, value: JSON.parse(raw) as string, span: [start, s.pos] };
}

function parseLiteral(s: ParseState, literal: string, value: JsonPrimitive): JNode {
  const start = s.pos;
  if (s.text.slice(s.pos, s.pos + literal.length) !== literal) {
    fail(s, `expected literal "${literal}"`);
  }
  s.pos += literal.length;
  return { kind: 'leaf', raw: literal, value, span: [start, s.pos] };
}

function parseNumber(s: ParseState): JNode {
  NUMBER_RE.lastIndex = s.pos;
  const match = NUMBER_RE.exec(s.text);
  if (match === null || match.index !== s.pos) {
    fail(s, 'invalid number');
  }
  const raw = (match as RegExpExecArray)[0];
  const start = s.pos;
  s.pos += raw.length;
  return { kind: 'leaf', raw, value: Number(raw), span: [start, s.pos] };
}

function parseValue(s: ParseState): JNode {
  skipWs(s);
  const ch = s.text[s.pos];
  if (ch === '{') {
    return parseObject(s);
  }
  if (ch === '[') {
    return parseArray(s);
  }
  if (ch === '"') {
    const { raw, value, span } = parseStringToken(s);
    return { kind: 'leaf', raw, value, span };
  }
  if (ch === 't') {
    return parseLiteral(s, 'true', true);
  }
  if (ch === 'f') {
    return parseLiteral(s, 'false', false);
  }
  if (ch === 'n') {
    return parseLiteral(s, 'null', null);
  }
  return parseNumber(s);
}

function parseObject(s: ParseState): JNode {
  const start = s.pos;
  s.pos++;
  const entries: Array<{ key: string; value: JNode }> = [];
  skipWs(s);
  if (s.text[s.pos] === '}') {
    s.pos++;
    return { kind: 'obj', entries, span: [start, s.pos] };
  }
  while (true) {
    skipWs(s);
    const { value: key } = parseStringToken(s);
    skipWs(s);
    if (s.text[s.pos] !== ':') {
      fail(s, "expected ':'");
    }
    s.pos++;
    const value = parseValue(s);
    entries.push({ key, value });
    skipWs(s);
    const ch = s.text[s.pos];
    if (ch === ',') {
      s.pos++;
      continue;
    }
    if (ch === '}') {
      s.pos++;
      break;
    }
    fail(s, "expected ',' or '}'");
  }
  return { kind: 'obj', entries, span: [start, s.pos] };
}

function parseArray(s: ParseState): JNode {
  const start = s.pos;
  s.pos++;
  const items: JNode[] = [];
  skipWs(s);
  if (s.text[s.pos] === ']') {
    s.pos++;
    return { kind: 'arr', items, span: [start, s.pos] };
  }
  while (true) {
    const value = parseValue(s);
    items.push(value);
    skipWs(s);
    const ch = s.text[s.pos];
    if (ch === ',') {
      s.pos++;
      continue;
    }
    if (ch === ']') {
      s.pos++;
      break;
    }
    fail(s, "expected ',' or ']'");
  }
  return { kind: 'arr', items, span: [start, s.pos] };
}

/** Parses `text` into a lossless tree. Every node carries the exact source span it came from. */
export function parseLossless(text: string): JNode {
  const s: ParseState = { text, pos: 0 };
  const node = parseValue(s);
  skipWs(s);
  if (s.pos !== s.text.length) {
    fail(s, 'unexpected trailing content');
  }
  return node;
}

/** Best-effort formatting for a leaf with no previous raw text to reuse; whole-number floats print without Python's trailing `.0` — a known, acceptable gap since these are new values a reviewer must check anyway. */
function formatFreshNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`losslessJson: cannot serialize non-finite number ${value}`);
  }
  if (Object.is(value, -0)) {
    return '-0';
  }
  return String(value);
}

export function freshLeaf(value: JsonPrimitive): JNode {
  if (value === null) {
    return { kind: 'leaf', raw: 'null', value: null, span: [-1, -1] };
  }
  if (typeof value === 'boolean') {
    return { kind: 'leaf', raw: value ? 'true' : 'false', value, span: [-1, -1] };
  }
  if (typeof value === 'string') {
    return { kind: 'leaf', raw: JSON.stringify(value), value, span: [-1, -1] };
  }
  return { kind: 'leaf', raw: formatFreshNumber(value), value, span: [-1, -1] };
}

export interface SerializeOptions {
  style: 'pretty2' | 'compact';
  /** Matches the payload fixture's `json.dumps(sort_keys=True)` origin; parity's `expected` block is NOT sorted, so this defaults to false. */
  sortKeys?: boolean;
}

function orderedEntries(
  node: Extract<JNode, { kind: 'obj' }>,
  sortKeys: boolean,
): Array<{ key: string; value: JNode }> {
  if (!sortKeys) {
    return node.entries;
  }
  return [...node.entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function serializeCompact(node: JNode, opts: SerializeOptions): string {
  if (node.kind === 'leaf') {
    return node.raw;
  }
  if (node.kind === 'arr') {
    return `[${node.items.map((item) => serializeCompact(item, opts)).join(', ')}]`;
  }
  const entries = orderedEntries(node, opts.sortKeys ?? false);
  return `{${entries
    .map((e) => `${JSON.stringify(e.key)}: ${serializeCompact(e.value, opts)}`)
    .join(', ')}}`;
}

function serializePretty(node: JNode, depth: number, opts: SerializeOptions): string {
  const pad = '  '.repeat(depth);
  const childPad = '  '.repeat(depth + 1);
  if (node.kind === 'leaf') {
    return node.raw;
  }
  if (node.kind === 'arr') {
    if (node.items.length === 0) {
      return '[]';
    }
    const items = node.items.map((item) => childPad + serializePretty(item, depth + 1, opts));
    return `[\n${items.join(',\n')}\n${pad}]`;
  }
  const entries = orderedEntries(node, opts.sortKeys ?? false);
  if (entries.length === 0) {
    return '{}';
  }
  const rendered = entries.map(
    (e) => `${childPad}${JSON.stringify(e.key)}: ${serializePretty(e.value, depth + 1, opts)}`,
  );
  return `{\n${rendered.join(',\n')}\n${pad}}`;
}

/** `depth` only matters for `pretty2` (it's the indent level of `node` itself). */
export function serialize(node: JNode, opts: SerializeOptions, depth = 0): string {
  return opts.style === 'compact'
    ? serializeCompact(node, opts)
    : serializePretty(node, depth, opts);
}

export interface Diff {
  path: string;
  kind: 'changed' | 'added' | 'removed';
  old: unknown;
  new: unknown;
}

export interface ReconcileOptions {
  /** Dotted paths (e.g. `expected.factor_weights.factor_decay`) carried over from the previous fixture verbatim -- never compared or recomputed, either because the computed value doesn't cover them or because they're clock-dependent. */
  pinnedPaths: Set<string>;
}

export function toPlain(node: JNode): unknown {
  if (node.kind === 'leaf') {
    return node.value;
  }
  if (node.kind === 'arr') {
    return node.items.map(toPlain);
  }
  const result: Record<string, unknown> = {};
  for (const entry of node.entries) {
    result[entry.key] = toPlain(entry.value);
  }
  return result;
}

function childPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reconcileObject(
  oldNode: JNode | undefined,
  newValue: Record<string, unknown>,
  path: string,
  ctx: { diffs: Diff[] },
  opts: ReconcileOptions,
): JNode {
  if (oldNode !== undefined && oldNode.kind !== 'obj') {
    ctx.diffs.push({ path, kind: 'changed', old: toPlain(oldNode), new: '<object>' });
    oldNode = undefined;
  }
  const oldEntries = oldNode?.kind === 'obj' ? oldNode.entries : [];
  const oldByKey = new Map(oldEntries.map((e) => [e.key, e.value]));
  const newKeys = Object.keys(newValue);
  const newKeySet = new Set(newKeys);

  const entries: Array<{ key: string; value: JNode }> = [];
  for (const entry of oldEntries) {
    const path2 = childPath(path, entry.key);
    // reconcile() short-circuits on pinnedPaths before touching newValue, so undefined is safe
    // here even when a pinned key is entirely absent from the freshly computed value.
    if (newKeySet.has(entry.key) || opts.pinnedPaths.has(path2)) {
      entries.push({
        key: entry.key,
        value: reconcile(entry.value, newValue[entry.key], path2, ctx, opts),
      });
    } else {
      ctx.diffs.push({ path: path2, kind: 'removed', old: toPlain(entry.value), new: undefined });
    }
  }
  for (const key of newKeys) {
    if (oldByKey.has(key)) {
      continue;
    }
    entries.push({
      key,
      value: reconcile(undefined, newValue[key], childPath(path, key), ctx, opts),
    });
  }

  return { kind: 'obj', entries, span: [-1, -1] };
}

function symbolOf(node: JNode): string | undefined {
  if (node.kind !== 'obj') {
    return undefined;
  }
  const entry = node.entries.find((e) => e.key === 'symbol');
  return entry !== undefined && entry.value.kind === 'leaf' && typeof entry.value.value === 'string'
    ? entry.value.value
    : undefined;
}

function reconcileArray(
  oldNode: JNode | undefined,
  newValue: unknown[],
  path: string,
  ctx: { diffs: Diff[] },
  opts: ReconcileOptions,
): JNode {
  if (oldNode !== undefined && oldNode.kind !== 'arr') {
    ctx.diffs.push({ path, kind: 'changed', old: toPlain(oldNode), new: '<array>' });
    oldNode = undefined;
  }
  const oldItems = oldNode?.kind === 'arr' ? oldNode.items : [];

  // Keyed by symbol, not position: index matching would misattribute every diff when a fix reorders rows.
  const useSymbolMatch =
    newValue.length > 0 &&
    newValue.every((v) => isPlainRecord(v) && typeof v.symbol === 'string') &&
    oldItems.length > 0 &&
    oldItems.every((n) => symbolOf(n) !== undefined);

  const items: JNode[] = [];
  if (useSymbolMatch) {
    const oldBySymbol = new Map(oldItems.map((n) => [symbolOf(n) as string, n]));
    const matched = new Set<string>();
    for (const elem of newValue) {
      const symbol = (elem as Record<string, unknown>).symbol as string;
      const oldItem = oldBySymbol.get(symbol);
      if (oldItem !== undefined) {
        matched.add(symbol);
      }
      items.push(reconcile(oldItem, elem, `${path}[symbol=${symbol}]`, ctx, opts));
    }
    for (const [symbol, oldItem] of oldBySymbol) {
      if (!matched.has(symbol)) {
        ctx.diffs.push({
          path: `${path}[symbol=${symbol}]`,
          kind: 'removed',
          old: toPlain(oldItem),
          new: undefined,
        });
      }
    }
  } else {
    newValue.forEach((elem, index) => {
      items.push(reconcile(oldItems[index], elem, `${path}[${index}]`, ctx, opts));
    });
    for (let i = newValue.length; i < oldItems.length; i++) {
      const oldItem = oldItems[i] as JNode;
      ctx.diffs.push({
        path: `${path}[${i}]`,
        kind: 'removed',
        old: toPlain(oldItem),
        new: undefined,
      });
    }
  }

  return { kind: 'arr', items, span: [-1, -1] };
}

/** Recurses into `newValue` at `path`, recording every real change in `ctx.diffs`. */
export function reconcile(
  oldNode: JNode | undefined,
  newValue: unknown,
  path: string,
  ctx: { diffs: Diff[] },
  opts: ReconcileOptions,
): JNode {
  if (opts.pinnedPaths.has(path)) {
    if (oldNode === undefined) {
      throw new Error(`losslessJson: pinned path "${path}" has no previous value to preserve`);
    }
    return oldNode;
  }

  if (newValue === null || newValue === undefined) {
    if (oldNode?.kind === 'leaf' && oldNode.value === null) {
      return oldNode;
    }
    if (oldNode !== undefined) {
      ctx.diffs.push({ path, kind: 'changed', old: toPlain(oldNode), new: null });
    }
    return freshLeaf(null);
  }

  if (typeof newValue === 'number') {
    if (
      oldNode?.kind === 'leaf' &&
      typeof oldNode.value === 'number' &&
      Math.abs(oldNode.value - newValue) <= FLOAT_TOLERANCE
    ) {
      return oldNode;
    }
    ctx.diffs.push({
      path,
      kind: oldNode === undefined ? 'added' : 'changed',
      old: oldNode ? toPlain(oldNode) : undefined,
      new: newValue,
    });
    return freshLeaf(newValue);
  }

  if (typeof newValue === 'string' || typeof newValue === 'boolean') {
    if (oldNode?.kind === 'leaf' && oldNode.value === newValue) {
      return oldNode;
    }
    ctx.diffs.push({
      path,
      kind: oldNode === undefined ? 'added' : 'changed',
      old: oldNode ? toPlain(oldNode) : undefined,
      new: newValue,
    });
    return freshLeaf(newValue);
  }

  if (Array.isArray(newValue)) {
    return reconcileArray(oldNode, newValue, path, ctx, opts);
  }

  if (typeof newValue === 'object') {
    return reconcileObject(oldNode, newValue as Record<string, unknown>, path, ctx, opts);
  }

  throw new Error(`losslessJson: unsupported value type at "${path}": ${typeof newValue}`);
}
