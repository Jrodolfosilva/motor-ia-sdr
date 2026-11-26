// Confirmação dos dados do formulário em mensagem pronta (sem IA): depois da recepção do lead de
// formulário, sai uma lista com cada pergunta em negrito e a resposta da lead, uma por linha:
//   Pode confirmar se os dados estão corretos?
//
//   *Você está desempregada hoje:* Estou desempregada!
//   *Data de saída do último emprego:* 07/12/2025
// A resposta dela ("sim", ou uma correção) segue o fluxo normal (extractor confirma/corrige).
import type { Agent, RequiredField } from './types';
import { stripNamePlaceholder } from './followup';

/** Chaves que não entram na lista (identificação da lead, não respostas do formulário). */
const SKIP = new Set(['nome', 'name', 'full_name', 'phone', 'phone_number', 'telefone', 'email', 'e-mail']);

/** Rótulo da pergunta na lista (sem "?" no fim). */
export function confirmLabel(key: string, field?: RequiredField): string {
  const raw = field ? field.confirm_label || field.question || field.key : key;
  return raw.trim().replace(/[?:\s]+$/, '');
}

/** Monta a mensagem, ou null se o agente não usa / não há dado do formulário. Ordem = a do formulário. */
export function buildFormConfirmation(agent: Agent, known: Record<string, unknown>): string | null {
  const cfg = agent.form_confirmation;
  if (!cfg?.enabled) return null;
  const lines: string[] = [];
  for (const [key, value] of Object.entries(known)) {
    if (SKIP.has(key.toLowerCase()) || value == null || String(value).trim() === '') continue;
    const field = agent.required_fields.find((f) => f.key === key);
    lines.push(`*${confirmLabel(key, field)}:* ${String(value).trim()}`);
  }
  if (!lines.length) return null;
  // nunca usa o nome da lead (vem errado com frequência)
  const intro = stripNamePlaceholder(cfg.intro?.trim() || 'Pode confirmar se os dados estão corretos?');
  return [intro, lines.join('\n'), cfg.outro?.trim()].filter(Boolean).join('\n\n');
}
