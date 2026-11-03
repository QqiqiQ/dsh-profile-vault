/**
 * Name normalization.
 *
 * Two people are "the same name" when their normalized forms collide: NFKC
 * (full-width → ASCII), no whitespace, no decorative punctuation, lowercased.
 * Nothing here is stored as the truth — `displayName` keeps what the user typed,
 * and the normalized form is rebuilt on every lookup, so a normalization change
 * can never corrupt the vault (D3).
 */

const STRIPPED = /[\s\u3000「」『』〈〉《》·・,，、;；:：'"“”‘’()（）\[\]【】\-_/\\|]/g;

export function normalizeName(input) {
  if (typeof input !== 'string') return '';
  return input.normalize('NFKC').replace(STRIPPED, '').toLowerCase();
}

/** The human-facing form: trimmed, inner whitespace collapsed, nothing else touched. */
export function presentName(input) {
  if (typeof input !== 'string') return '';
  return input.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

/** Every normalized form this person answers to. */
export function nameForms(person) {
  const forms = new Set();
  const main = normalizeName(person?.displayName);
  if (main !== '') forms.add(main);
  for (const alias of Array.isArray(person?.aliases) ? person.aliases : []) {
    const form = normalizeName(alias);
    if (form !== '') forms.add(form);
  }
  return forms;
}

/** People whose display name or alias matches `input`. */
export function matchPeople(people, input) {
  const wanted = normalizeName(input);
  if (wanted === '') return [];
  return people.filter((person) => nameForms(person).has(wanted));
}

/** The name a person is listed under when several collide. */
export function labelFor(person) {
  const relation = typeof person?.relation === 'string' ? person.relation.trim() : '';
  return relation === '' ? person?.displayName ?? '' : `${person.displayName}（${relation}）`;
}
