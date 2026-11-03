/**
 * Value coercion, masking, and the two pattern checks.
 *
 * Credentials (passwords, API keys, card security codes) are refused outright:
 * storing them buys nothing and leaks irreversibly. Identity numbers are
 * accepted — the real risk is who may read them, not that they exist — but they
 * are flagged so reads default to a masked form and need their own consent tier.
 */
import { parseDateValue, parseDateTimeValue } from './time.js';

export const MAX_TEXT = 2048;
const MAX_PARTS = 20;

export function maskValue(input) {
  const chars = [...String(input)];
  if (chars.length <= 4) return '*'.repeat(Math.max(2, chars.length));
  const head = chars.slice(0, 3).join('');
  const tail = chars.slice(-4).join('');
  return head + '*'.repeat(Math.max(4, chars.length - 7)) + tail;
}

export function tailOf(input, digits = 4) {
  const compact = String(input).replace(/[\s-]/g, '');
  if (compact.length <= digits) return compact;
  return `****${compact.slice(-digits)}`;
}

export function isMasked(value) {
  return typeof value === 'string' && value.includes('****');
}

/**
 * A masked display value ("186****2860", "****1234") is not data. Writing it
 * back would poison the record with asterisks the user cannot see past, so it
 * is refused at the same place credentials are.
 */
export function looksMasked(value) {
  return typeof value === 'string' && /[*＊]{3,}/.test(value);
}

/** Turn a raw argument into the stored shape for this entry kind. */
export function coerceValue(entry, raw) {
  const kind = entry.kind;

  if (kind === 'credential') {
    return {
      ok: false,
      code: 'value_rejected',
      message: '密码、密钥、卡安全码这类凭证不存进资料库（存了没有收益，泄露不可撤销）。改存“有没有/放在哪”这类描述。',
    };
  }

  if (kind === 'date') {
    const parts = parseDateValue(String(raw));
    if (parts === null) {
      return { ok: false, code: 'invalid_value', message: `不是合法日期：${String(raw).slice(0, 40)}。用 1968-05-12、1968-05 或 1968 这种写法。` };
    }
    return { ok: true, value: parts.text, precision: parts.precision };
  }

  if (kind === 'datetime') {
    const parts = parseDateTimeValue(String(raw));
    if (parts === null) {
      return { ok: false, code: 'invalid_value', message: `不是合法时间：${String(raw).slice(0, 40)}。用 2026-05-12 18:30 这种写法。` };
    }
    return { ok: true, value: parts.text };
  }

  if (kind === 'number') {
    const numeric = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(/[,\s]/g, ''));
    if (!Number.isFinite(numeric)) {
      return { ok: false, code: 'invalid_value', message: `不是数字：${String(raw).slice(0, 40)}` };
    }
    return { ok: true, value: numeric };
  }

  if (kind === 'bool') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    const text = String(raw).trim().toLowerCase();
    if (['true', 'yes', 'y', '1', '是', '对'].includes(text)) return { ok: true, value: true };
    if (['false', 'no', 'n', '0', '否', '不'].includes(text)) return { ok: true, value: false };
    return { ok: false, code: 'invalid_value', message: `不是是/否：${String(raw).slice(0, 40)}` };
  }

  // text / enum share the same storage shape.
  const text = typeof raw === 'string' ? raw.normalize('NFKC').trim() : String(raw).trim();
  if (text === '') return { ok: false, code: 'invalid_value', message: '值不能为空' };
  if (looksMasked(text)) {
    return {
      ok: false,
      code: 'value_rejected',
      message: '这个值里有连续星号，像是加密显示后的样子（如 186****2860）。掩码只是展示，存进去就成了真的星号，请填完整内容。',
    };
  }
  if (text.length > MAX_TEXT) {
    return { ok: false, code: 'too_large', message: `值超过 ${MAX_TEXT} 字，请截短后重试。` };
  }
  return { ok: true, value: text };
}

/** Multi-valued entries accept an array and store one observation per item. */
export function coerceMany(entry, raw) {
  const items = Array.isArray(raw) ? raw : [raw];
  if (items.length === 0) return { ok: false, code: 'invalid_value', message: '至少要给一个值' };
  if (items.length > MAX_PARTS) {
    return { ok: false, code: 'too_large', message: `一次最多写 ${MAX_PARTS} 个值` };
  }
  const values = [];
  const seen = new Set();
  for (const item of items) {
    const coerced = coerceValue(entry, item);
    if (!coerced.ok) return coerced;
    const key = String(coerced.value).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(coerced.value);
  }
  return { ok: true, values };
}

const CREDENTIAL_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/,
  /(密码|口令|验证码|动态码|CVV|安全码|私钥|助记词|密钥)\s*[:：=]?\s*\S{4,}/,
];

const ID_CARD = /(^|[^0-9])(\d{17}[0-9Xx]|\d{15})([^0-9]|$)/;
const BANK_CARD = /(^|[^0-9])\d{16,19}([^0-9]|$)/;
const PHONE = /(^|[^0-9])1[3-9]\d{9}([^0-9]|$)/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** True when a value looks like a credential we must not store. */
export function looksLikeCredential(text) {
  if (typeof text !== 'string' || text.length < 8) return false;
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text));
}

/** True when a value looks like an identity number / contact detail. */
export function looksLikeIdentity(text) {
  if (typeof text !== 'string') return false;
  const compact = text.replace(/[\s-]/g, '');
  return ID_CARD.test(text) || BANK_CARD.test(compact) || PHONE.test(compact) || EMAIL.test(text);
}

/** Value with any obvious credential redacted, for warnings and logs. */
export function redact(value) {
  const text = String(value);
  if (text.length <= 6) return '***';
  return `${text.slice(0, 3)}***`;
}
