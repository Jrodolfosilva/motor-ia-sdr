// Datas sem ano ("21 de janeiro", "15/04", "junho") viram data completa, inferindo o ano:
//  - data no passado (saída do emprego, nascimento): ano atual; se cairia no futuro, ano passado.
//  - data no futuro (previsão do parto): ano atual; se já passou há mais de 2 meses, ano que vem.
//  - "ano passado" / "ano que vem" no texto mandam no ano.
// Só data só com ano ("em 2024") fica como está: a IA pergunta o mês.
import type { Agent, RequiredField } from '../types';
import { parseDate } from './classificationRules';
import { stripAccents } from './duration';

export type DateKind = 'past' | 'future';

const MONTHS: Record<string, number> = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};
const MONTH_RE = '(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*';
const pad = (n: number) => String(n).padStart(2, '0');
const DAY_MS = 86_400_000;

/** Tipo da data do campo: explícito no kit, ou pela chave (saída/nascimento = passado, parto/previsão = futuro). */
export function dateKindFor(field: Pick<RequiredField, 'key'> & { date_kind?: DateKind | null }): DateKind | null {
  if (field.date_kind) return field.date_kind;
  const k = stripAccents(field.key.toLowerCase());
  if (/saida|demiss|deslig|nascimento|admiss/.test(k)) return 'past';
  if (/parto|previsao/.test(k)) return 'future';
  return null;
}

/** Completa o ano de uma data sem ano no texto. Texto sem data incompleta volta igual. */
export function inferYear(value: string, kind: DateKind, now: Date = new Date()): string {
  if (parseDate(value)) return value; // já tem data completa
  const src = value.normalize('NFC');
  const t = stripAccents(src.toLowerCase());
  // parto que já aconteceu ("nasceu dia 10 de outubro") é data passada
  const effective: DateKind = kind === 'future' && /\bnasceu\b/.test(t) && !/\bn(a|ã)o nasceu\b/.test(t) ? 'past' : kind;

  let m: RegExpExecArray | null;
  let day: number | null = null;
  let month: number;
  let at: { index: number; length: number };
  if ((m = new RegExp(`\\b(\\d{1,2})\\s*(?:de\\s+)?${MONTH_RE}\\b(?!\\s*(?:de\\s+|/\\s*)?\\d{4})`).exec(t))) {
    day = +m[1]; month = MONTHS[m[2]];
  } else if ((m = /\b(\d{1,2})[/.](\d{1,2})\b(?![/.]\d)/.exec(t))) {
    day = +m[1]; month = +m[2];
  } else if ((m = new RegExp(`\\b${MONTH_RE}\\b(?!\\s*(?:de\\s+|/\\s*)?\\d{4})`).exec(t))) {
    month = MONTHS[m[1]];
  } else return value;
  at = { index: m.index, length: m[0].length };
  if (!month || month > 12 || (day != null && (day < 1 || day > 31))) return value;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let year = today.getFullYear();
  const build = (y: number) => new Date(y, month - 1, day ?? 1);
  if (/\bano passado\b/.test(t)) year -= 1;
  else if (/\b(ano que vem|proximo ano)\b/.test(t)) year += 1;
  else if (effective === 'past') {
    if (build(year) > today) year -= 1;
  } else if (build(year).getTime() < today.getTime() - 60 * DAY_MS) year += 1;

  const d = build(year);
  if (day != null && d.getDate() !== day) return value; // 31/02 etc.
  const norm = day != null ? `${pad(day)}/${pad(month)}/${year}` : `${pad(month)}/${year}`;
  return src.slice(0, at.index) + norm + src.slice(at.index + at.length);
}

/** Aplica `inferYear` nos campos de data do roteiro. Devolve o mesmo objeto se nada mudou. */
export function normalizeKnownDates(agent: Agent, known: Record<string, unknown>, now?: Date): Record<string, unknown> {
  let out = known;
  for (const f of agent.required_fields) {
    const v = known[f.key];
    const kind = dateKindFor(f);
    if (!kind || typeof v !== 'string' || !v.trim()) continue;
    const next = inferYear(v, kind, now);
    if (next !== v) out = { ...out, [f.key]: next };
  }
  return out;
}
