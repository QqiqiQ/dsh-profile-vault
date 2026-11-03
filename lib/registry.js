/**
 * Built-in entry registry.
 *
 * The registry decides three things the model must not decide for itself:
 * the canonical key, the value kind, and the sensitivity tier. Unknown entries
 * are still accepted (as `x_<normalized>` text) — a registry that blocks real
 * life would just push data out of the vault.
 *
 * tier:
 *   normal     — ordinary facts.
 *   sensitive  — identity data: storable, warned on write, masked on read,
 *                full value needs its own consent tier.
 *   credential — refused: no benefit to storing, irreversible when leaked.
 */
import { normalizeName } from './names.js';

/** [key, label, aliases, kind, cardinality, stability, tier, unit] */
const TABLE = [
  ['birthday', '生日', ['出生日期', '生辰', '生日日期', '出生年月日'], 'date', 'single', 'immutable', 'normal'],
  ['birthday_lunar', '农历生日', ['农历生辰', '阴历生日'], 'date', 'single', 'immutable', 'normal'],
  ['birthplace', '出生地', ['籍贯', '老家', '出生地'], 'text', 'single', 'immutable', 'normal'],
  ['name_full', '全名', ['姓名', '本名'], 'text', 'single', 'immutable', 'normal'],
  ['phone', '手机号', ['电话', '手机', '联系方式', '号码'], 'text', 'multi', 'slow', 'sensitive'],
  ['email', '邮箱', ['邮件', '电子邮件'], 'text', 'multi', 'slow', 'sensitive'],
  ['address', '住址', ['家庭住址', '现居', '地址'], 'text', 'single', 'slow', 'sensitive'],
  ['employer', '工作单位', ['公司', '单位', '就职'], 'text', 'single', 'slow', 'normal'],
  ['title', '职位', ['岗位', '职务'], 'text', 'single', 'slow', 'normal'],
  ['school', '学校', ['母校'], 'text', 'single', 'slow', 'normal'],
  ['major', '专业', [], 'text', 'single', 'immutable', 'normal'],
  ['city', '所在城市', ['现居城市', '常驻地'], 'text', 'single', 'slow', 'normal'],
  ['hobbies', '爱好', ['兴趣', '喜好'], 'text', 'multi', 'slow', 'normal'],
  ['taste', '口味偏好', ['口味', '饮食偏好'], 'text', 'multi', 'slow', 'normal'],
  ['dietary', '饮食禁忌', ['忌口', '不吃'], 'text', 'multi', 'slow', 'normal'],
  ['allergy', '过敏', ['过敏源'], 'text', 'multi', 'slow', 'sensitive'],
  ['health', '健康状况', ['病史', '身体状况'], 'text', 'multi', 'slow', 'sensitive'],
  ['family', '家庭成员', ['家人', '亲属'], 'text', 'multi', 'slow', 'normal'],
  ['pets', '宠物', [], 'text', 'multi', 'slow', 'normal'],
  ['anniversary', '纪念日', ['结婚纪念日'], 'date', 'multi', 'immutable', 'normal'],
  ['height', '身高', [], 'number', 'single', 'volatile', 'normal', 'cm'],
  ['weight', '体重', [], 'number', 'single', 'volatile', 'normal', 'kg'],
  ['blood_type', '血型', [], 'enum', 'single', 'immutable', 'sensitive'],
  ['shoe_size', '鞋码', [], 'number', 'single', 'slow', 'normal'],
  ['clothing_size', '衣服尺码', ['尺码'], 'text', 'single', 'slow', 'normal'],
  ['mbti', 'MBTI', ['性格类型'], 'enum', 'single', 'immutable', 'normal'],
  ['gift_ideas', '礼物想法', ['想收到的礼物', '礼物'], 'text', 'multi', 'slow', 'normal'],
  ['current_project', '当前项目', ['在忙什么'], 'text', 'multi', 'volatile', 'normal'],
  ['id_card', '身份证号', ['证件号', '身份证'], 'text', 'single', 'immutable', 'sensitive'],
  ['passport', '护照号', ['护照'], 'text', 'single', 'immutable', 'sensitive'],
  ['driver_license', '驾照号', ['驾驶证'], 'text', 'single', 'immutable', 'sensitive'],
  ['social_security', '社保号', ['社保'], 'text', 'single', 'immutable', 'sensitive'],
  ['bank_card', '银行卡号', ['卡号'], 'text', 'multi', 'slow', 'sensitive'],
  ['password', '密码', ['口令', '登录密码'], 'credential', 'single', 'immutable', 'credential'],
  ['api_key', '密钥', ['API key', 'token', '访问令牌'], 'credential', 'single', 'immutable', 'credential'],
  ['bank_cvv', '卡安全码', ['CVV', '安全码', '有效期'], 'credential', 'single', 'immutable', 'credential'],
];

/** Derived facts: refused with a pointer to the entry they come from instead. */
const DERIVED = new Map([
  ['age', { label: '年龄', from: 'birthday' }],
  ['zodiac', { label: '生肖', from: 'birthday' }],
  ['constellation', { label: '星座', from: 'birthday' }],
  ['属相', { label: '生肖', from: 'birthday' }],
  ['年龄', { label: '年龄', from: 'birthday' }],
  ['岁数', { label: '年龄', from: 'birthday' }],
  ['星座', { label: '星座', from: 'birthday' }],
  ['生肖', { label: '生肖', from: 'birthday' }],
]);

const BY_FORM = new Map();

function buildEntry(row) {
  const [key, label, aliases, kind, cardinality, stability, tier, unit] = row;
  return Object.freeze({
    key,
    label,
    aliases: Object.freeze(aliases),
    kind,
    cardinality,
    stability,
    tier,
    ...(unit === undefined ? {} : { unit }),
  });
}

for (const row of TABLE) {
  const entry = buildEntry(row);
  for (const form of [entry.key, entry.label, ...entry.aliases]) {
    const normalized = normalizeName(form);
    if (normalized !== '' && !BY_FORM.has(normalized)) BY_FORM.set(normalized, entry);
  }
}

for (const [form, derived] of DERIVED) {
  const normalized = normalizeName(form);
  if (!BY_FORM.has(normalized)) BY_FORM.set(normalized, { derived: true, ...derived });
}

export function registryCatalog() {
  return TABLE.map((row) => {
    const entry = buildEntry(row);
    return {
      key: entry.key,
      label: entry.label,
      kind: entry.kind,
      cardinality: entry.cardinality,
      stability: entry.stability,
      tier: entry.tier,
      ...(entry.unit === undefined ? {} : { unit: entry.unit }),
    };
  });
}

/**
 * Resolve a user-facing entry name to a registry entry, a derived marker, or a
 * fresh custom entry. Custom keys are prefixed so they can never shadow a
 * future built-in key.
 */
export function resolveEntry(input) {
  const label = typeof input === 'string' ? input.normalize('NFKC').trim() : '';
  if (label === '') return { ok: false, code: 'invalid_entry', message: '条目名不能为空' };

  const hit = BY_FORM.get(normalizeName(label));
  if (hit !== undefined) {
    if (hit.derived === true) {
      return {
        ok: false,
        code: 'derived_entry',
        message: `「${hit.label}」由「${hit.from}」推算，不要单独存；请存 ${hit.from}，读取时会给现算结果。`,
      };
    }
    return { ok: true, entry: hit, custom: false };
  }

  const normalized = normalizeName(label).replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  if (normalized === '') return { ok: false, code: 'invalid_entry', message: `条目名「${label}」不可用` };
  const entry = Object.freeze({
    key: `x_${normalized}`,
    label,
    aliases: Object.freeze([]),
    kind: 'text',
    cardinality: 'single',
    stability: 'slow',
    tier: 'normal',
  });
  return { ok: true, entry, custom: true };
}

/** Look up a stored entry definition by its canonical key. */
export function entryByKey(key) {
  for (const row of TABLE) {
    if (row[0] === key) return buildEntry(row);
  }
  return undefined;
}

const CREDENTIAL_TIER = new Set(['password', 'api_key', 'bank_cvv']);

export function isCredentialKey(key) {
  return CREDENTIAL_TIER.has(key);
}
