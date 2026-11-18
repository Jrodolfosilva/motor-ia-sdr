// Telefones do Brasil: o WhatsApp às vezes entrega o número sem o 9º dígito (wa_id) e o CRM guarda
// com +, espaço, traço. Canônico aqui = só dígitos, com 55 e com o 9 (13 dígitos) quando é celular.

export const digits = (v: unknown) => String(v ?? '').replace(/\D+/g, '');

/** "+55 (11) 95944-4456" / "551195944445" / "11959444456" → "5511959444456". */
export function canonicalPhone(v: unknown): string {
  let d = digits(v);
  if (!d) return '';
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  // 55 + DDD + 8 dígitos começando em 6-9 = celular sem o 9 → acrescenta
  if (d.startsWith('55') && d.length === 12 && /[6-9]/.test(d[4])) d = `${d.slice(0, 4)}9${d.slice(4)}`;
  return d;
}

/** Formas em que o número pode estar gravado no CRM (busca por duplicidade). */
export function phoneVariants(v: unknown): string[] {
  const c = canonicalPhone(v);
  if (!c) return [];
  const out = new Set([c, `+${c}`]);
  if (c.startsWith('55')) {
    const local = c.slice(2);
    out.add(local);
    if (c.length === 13) {
      const no9 = `${c.slice(0, 4)}${c.slice(5)}`;
      out.add(no9);
      out.add(`+${no9}`);
      out.add(no9.slice(2));
    }
  }
  return [...out];
}

export const samePhone = (a: unknown, b: unknown) => !!canonicalPhone(a) && canonicalPhone(a) === canonicalPhone(b);
