// Porte de ClassificationRuleEvaluator.
import type { Rule } from '../types';
import { stripAccents, toMonths } from './duration';

const MONTHS: Record<string, number> = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};

const norm = (s: string) => stripAccents(s.toLowerCase());

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function parseDate(value: string): Date | null {
  const t = norm(value);
  let d: number, mo: number, y: number;
  let m: RegExpExecArray | null;

  if ((m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(t))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = /\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})\b/.exec(t))) [d, mo, y] = [+m[1], +m[2], +m[3]];
  else if ((m = /\b(\d{1,2})[/.\-](\d{4})\b/.exec(t))) [d, mo, y] = [1, +m[1], +m[2]];
  else if ((m = /\b(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*\.?\s*(?:de\s+|\/\s*)?(\d{4})\b/.exec(t)))
    [d, mo, y] = [1, MONTHS[m[1]], +m[2]];
  else return null;

  if (y < 100) y += 2000;
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

/** Meses inteiros desde a data no texto. Data futura ou sem data → null. */
export function monthsSinceDate(value: string, today: Date = new Date()): number | null {
  const date = parseDate(value);
  if (!date) return null;
  const t = startOfDay(today);
  if (date > t) return null;
  let months = (t.getFullYear() - date.getFullYear()) * 12 + (t.getMonth() - date.getMonth());
  if (t.getDate() < date.getDate()) months -= 1;
  return months;
}

export function monthsSince(value: string, today?: Date): number | null {
  return parseDate(value) === null ? toMonths(value) : monthsSinceDate(value, today);
}

function containsAny(value: unknown, needles: unknown): boolean {
  if (typeof value !== 'string' || value === '') return false;
  const hay = norm(value);
  const list = Array.isArray(needles) ? needles : [needles];
  return list.some((n) => typeof n === 'string' && n !== '' && hay.includes(norm(n)));
}

function cmp(months: number | null, threshold: unknown, f: (a: number, b: number) => boolean): boolean {
  const n = Number(threshold);
  return months !== null && !Number.isNaN(n) && f(months, n);
}

function conditionMatches(rule: Rule, known: Record<string, unknown>, today?: Date): boolean {
  const v = known[rule.field];
  const s = typeof v === 'string' ? v : null;
  switch (rule.operator) {
    case 'present': return v !== null && v !== undefined && v !== '';
    case 'contains_any': return containsAny(v, rule.value);
    case 'not_contains_any': return v != null && v !== '' && !containsAny(v, rule.value);
    case 'gte_months': return s !== null && cmp(toMonths(s), rule.value, (a, b) => a >= b);
    case 'lt_months': return s !== null && cmp(toMonths(s), rule.value, (a, b) => a < b);
    case 'months_since_gte': return s !== null && cmp(monthsSince(s, today), rule.value, (a, b) => a >= b);
    case 'months_since_lt': return s !== null && cmp(monthsSince(s, today), rule.value, (a, b) => a < b);
    default: return false;
  }
}

/** Todas as regras precisam casar. Lista vazia nunca casa. */
export function rulesMatch(rules: Rule[] | undefined, known: Record<string, unknown>, today?: Date): boolean {
  if (!rules || rules.length === 0) return false;
  return rules.every((r) => conditionMatches(r, known, today));
}

/**
 * Anotação de tempo para datas do roteiro. Data no passado vira "(essa data já passou - há N dias/meses)",
 * para a IA não tratar como futura uma previsão que já venceu (ex: previsão do parto).
 */
export function elapsedNote(value: string, now?: Date): string {
  const date = parseDate(value);
  const today = now ?? new Date();
  if (!date) return '';
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (date > t) return '';
  const months = monthsSinceDate(value, today);
  const days = Math.round((t.getTime() - date.getTime()) / 86_400_000);
  if (months !== null && months >= 1) return ` (essa data já passou - há ${months} ${months === 1 ? 'mês' : 'meses'})`;
  return days === 0 ? ' (é hoje)' : ` (essa data já passou - há ${days} ${days === 1 ? 'dia' : 'dias'})`;
}
