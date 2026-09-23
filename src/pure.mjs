// Pure helpers: usable from Node and Claude's isolated function-hook runtime.
export class BridgeError extends Error {
  constructor(code, message) { super(message); this.name = 'BridgeError'; this.code = code; }
}
export const isRecord = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export const own = (x, k) => Object.prototype.hasOwnProperty.call(x, k);
export const dict = entries => Object.fromEntries(entries);
export function invariant(ok, message, code = 'invalid_input') {
  if (!ok) throw new BridgeError(code, message);
}
export function probability(x) { return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1; }
export function utf8Bytes(s) {
  let n = 0;
  for (const c of s) { const p = c.codePointAt(0); n += p < 128 ? 1 : p < 2048 ? 2 : p < 65536 ? 3 : 4; }
  return n;
}
// Deliberately pessimistic, tokenizer-free upper estimate for byte-based tokenizers.
export const estimateTokens = s => utf8Bytes(typeof s === 'string' ? s : JSON.stringify(s));
export function clip(s, cap) {
  if (s.length <= cap) return s;
  const marker = '[…omitted…]';
  if (cap <= marker.length) return marker.slice(0, cap);
  const n = Math.floor((cap - marker.length) / 2);
  return s.slice(0, n) + marker + s.slice(-(cap - marker.length - n));
}
export const stableRank = (rows, key) => rows.map((r, i) => ({r, i})).sort((a,b) => b.r[key]-a.r[key] || a.i-b.i).map(x=>x.r);
export function confidenceAction(a, threshold = .8) {
  return a?.confidence !== null && a?.confidence !== undefined && a.confidence >= threshold ? 'auto' : 'review';
}
export function margin(p) {
  const xs = Object.values(p).sort((a,b)=>b-a);
  return xs.length > 1 ? xs[0] - xs[1] : 0;
}
export function redact(s) {
  return String(s)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|AKIA[A-Z0-9]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})\b/g, '[REDACTED]')
    .replace(/((?:authorization|api[_-]?key|password|token|secret|credentials?)[\w-]*["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"'&,;]+/gi, '$1[REDACTED]')
    .replace(/(\bBearer\s+)[\w.-]{16,}/gi, '$1[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*:[^\s/@]+@/gi, '$1[REDACTED]@');
}
export function jsonSafe(value, maxDepth = 32) {
  const seen = new Set(); let nodes = 0;
  function visit(v, depth) {
    invariant(++nodes <= 100000 && depth <= maxDepth, 'JSON is too complex');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') { invariant(Number.isFinite(v), 'JSON numbers must be finite'); return; }
    invariant(typeof v === 'object' && !seen.has(v), 'Expected acyclic JSON');
    invariant(Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null, 'Expected a plain JSON object');
    seen.add(v);
    for (const x of Array.isArray(v) ? v : Object.values(v)) visit(x, depth + 1);
    seen.delete(v);
  }
  visit(value, 0); return value;
}
