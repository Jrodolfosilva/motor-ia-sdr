// Porte de App\Support\DurationNormalizer.

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7,
  oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, catorze: 14, quatorze: 14,
  quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20, trinta: 30,
  quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90,
};

const SINGULAR = { mes: 'mês', semana: 'semana', ano: 'ano' } as const;
const PLURAL = { mes: 'meses', semana: 'semanas', ano: 'anos' } as const;

const PATTERN = () =>
  /(?<number>\d+|[a-zà-ú]+(?:\s+e\s+[a-zà-ú]+)?)\s*(?<unit>m[eê]s(?:es)?|semanas?|anos?)/giu;

export function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function unitKey(unit: string): keyof typeof SINGULAR {
  const u = stripAccents(unit.toLowerCase());
  if (u.startsWith('mes')) return 'mes';
  if (u.startsWith('semana')) return 'semana';
  return 'ano';
}

function parseWordNumber(words: string): number | null {
  const parts = stripAccents(words.toLowerCase().trim()).split(' e ');
  if (parts.length === 1) return WORD_NUMBERS[parts[0]] ?? null;
  if (parts.length === 2) {
    const tens = WORD_NUMBERS[parts[0].trim()];
    const units = WORD_NUMBERS[parts[1].trim()];
    return tens !== undefined && units !== undefined && tens >= 20 && units < 10 ? tens + units : null;
  }
  return null;
}

function parseNumber(token: string): number | null {
  return /^\d+$/.test(token) ? parseInt(token, 10) : parseWordNumber(token);
}

/** "oito meses" → "8 meses"; resto do texto intacto. */
export function normalizeDuration(raw: string): string {
  return raw.replace(PATTERN(), (match, ...args) => {
    const groups = args[args.length - 1] as { number: string; unit: string };
    const count = parseNumber(groups.number);
    if (count === null) return match;
    const key = unitKey(groups.unit);
    return `${count} ${count === 1 ? SINGULAR[key] : PLURAL[key]}`;
  });
}

/** Primeira duração em meses. Sem duração → null (nunca 0). */
export function toMonths(raw: string): number | null {
  const m = PATTERN().exec(raw);
  if (!m?.groups) return null;
  const count = parseNumber(m.groups.number);
  if (count === null) return null;
  switch (unitKey(m.groups.unit)) {
    case 'semana': return Math.floor(count / 4);
    case 'ano': return count * 12;
    default: return count;
  }
}
