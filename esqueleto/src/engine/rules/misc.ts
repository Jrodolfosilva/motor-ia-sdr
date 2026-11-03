// DDD, contexto de tempo e balões.

type State = { uf: string; name: string };

// Mapa completo: referencia-laravel/app/Support/BrazilianDdd.php (MAP).
const UF_BY_DDD: Record<number, string> = {
  11: 'SP', 12: 'SP', 13: 'SP', 14: 'SP', 15: 'SP', 16: 'SP', 17: 'SP', 18: 'SP', 19: 'SP',
  21: 'RJ', 22: 'RJ', 24: 'RJ', 27: 'ES', 28: 'ES',
  31: 'MG', 32: 'MG', 33: 'MG', 34: 'MG', 35: 'MG', 37: 'MG', 38: 'MG',
  41: 'PR', 42: 'PR', 43: 'PR', 44: 'PR', 45: 'PR', 46: 'PR', 47: 'SC', 48: 'SC', 49: 'SC',
  51: 'RS', 53: 'RS', 54: 'RS', 55: 'RS', 61: 'DF', 62: 'GO', 64: 'GO', 63: 'TO',
  65: 'MT', 66: 'MT', 67: 'MS', 68: 'AC', 69: 'RO',
  71: 'BA', 73: 'BA', 74: 'BA', 75: 'BA', 77: 'BA', 79: 'SE', 81: 'PE', 87: 'PE', 82: 'AL',
  83: 'PB', 84: 'RN', 85: 'CE', 88: 'CE', 86: 'PI', 89: 'PI', 91: 'PA', 93: 'PA', 94: 'PA',
  92: 'AM', 97: 'AM', 95: 'RR', 96: 'AP', 98: 'MA', 99: 'MA',
};

const NAMES: Record<string, string> = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal',
  ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul',
  MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí',
  RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia',
  RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};

const PREPOSITIONS: Record<string, string> = {
  AC: 'no', AL: 'em', AP: 'no', AM: 'no', BA: 'na', CE: 'no', DF: 'no', ES: 'no', GO: 'em',
  MA: 'no', MT: 'em', MS: 'em', MG: 'em', PA: 'no', PB: 'na', PR: 'no', PE: 'em', PI: 'no',
  RJ: 'no', RN: 'no', RS: 'no', RO: 'em', RR: 'em', SC: 'em', SP: 'em', SE: 'em', TO: 'no',
};

export function stateFor(phone: string): State | null {
  const digits = phone.replace(/\D/g, '');
  if (!digits.startsWith('55') || digits.length < 4) return null;
  const uf = UF_BY_DDD[parseInt(digits.slice(2, 4), 10)];
  return uf ? { uf, name: NAMES[uf] } : null;
}

export function inState(s: State): string {
  return `${PREPOSITIONS[s.uf] ?? 'em'} ${s.name}`;
}

const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const MONTH_NAMES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** Data/hora em America/Sao_Paulo. */
function spNow(now: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { y: +parts.year, m: +parts.month, d: +parts.day, hh: parts.hour, mm: parts.minute, wd };
}

export function timeContextLine(phone?: string | null, now: Date = new Date()): string {
  const t = spNow(now);
  const st = phone ? stateFor(phone) : null;
  const dd = String(t.d).padStart(2, '0');
  const mm = String(t.m).padStart(2, '0');
  return `CONTEXTO ATUAL: hoje é ${WEEKDAYS[t.wd]}, ${dd}/${mm}/${t.y} (${t.d} de ${MONTH_NAMES[t.m - 1]}), ano atual ${t.y}, ${t.hh}:${t.mm} no horário de Brasília. País: Brasil${st ? ` (lead do DDD de ${st.name} - ${st.uf})` : ''}. Use isso para entender datas relativas ("esse ano", "mês passado", "semana passada", "em julho") - um mês sem ano é a ocorrência mais próxima que faz sentido (saída do emprego já aconteceu, previsão de parto ainda vai acontecer) - e calcular há quanto tempo algo aconteceu ou quanto falta - nunca pergunte o ano se o lead já deu uma referência que permite deduzir.`;
}

export function splitIntoBubbles(text: string): string[] {
  const p = text.trim().split(/\n\s*\n/u).map((s) => s.trim()).filter(Boolean);
  return p.length <= 3 ? p : [p[0], p[1], p.slice(2).join('\n\n')];
}

export const DEFAULT_BUBBLE_DELAY = { min_seconds: 2, max_seconds: 6, chars_per_second: 20 };

/** Pausa antes de um balão, como se alguém estivesse digitando. */
export function typingDelaySeconds(
  text: string,
  cfg: { min_seconds: number; max_seconds: number; chars_per_second: number } = DEFAULT_BUBBLE_DELAY,
): number {
  const cps = cfg.chars_per_second > 0 ? cfg.chars_per_second : DEFAULT_BUBBLE_DELAY.chars_per_second;
  return Math.min(cfg.max_seconds, Math.max(cfg.min_seconds, Math.ceil([...text].length / cps)));
}

// ---------------------------------------------------------------------------
// Resposta sem conteúdo (não serve como pendência de item do roteiro)
// ---------------------------------------------------------------------------

const BARE_REPLIES = new Set([
  'nao', 'n', 'nn', 'sim', 's', 'ss', 'ok', 'okay', 'blz', 'beleza', 'ta', 'hum', 'hm', 'hmm', 'ue', 'oi', 'ola',
  'ah', 'aham', 'uhum', 'e', 'eh', 'oxe', 'q', 'que', 'oque', 'o que', '?',
]);

/** Pedaço de teclado: "asdasd", "dasdasda", "qwerty", "xzcv" (sem vogal ou com trecho repetido). */
function isKeyboardMash(token: string): boolean {
  if (token.length < 4) return false;
  if (!/[aeiouy]/.test(token)) return true;
  if (/(.{2,4})\1/.test(token) && !/^(ha|he|hi|rs|kk)+$/.test(token)) return true;
  return /[bcdfghjklmnpqrstvwxz]{4,}/.test(token);
}

/**
 * "não", "ok", "kkkk", "bla bla bla", "asdasdasd"… Sozinhas não dizem que o lead vai mandar depois,
 * não tem ou recusou um item; o extrator às vezes marca pendência nelas e a pergunta some do roteiro.
 */
export function isNoiseReply(text: string): boolean {
  const t = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9?\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || /^\?+$/.test(t)) return true;
  if (BARE_REPLIES.has(t)) return true;
  const tokens = t.split(' ');
  if (tokens.every((w) => /^(k+|(ha)+h?|(he)+|(rs)+|bla|blah)$/.test(w))) return true;
  return tokens.every((w) => isKeyboardMash(w));
}
