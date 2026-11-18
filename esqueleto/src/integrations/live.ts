// Conversa REAL (WhatsApp via Fale Fácil + lead no Bitrix). Reaproveita a Session do simulador como
// registro (estado, histórico, logs, follow-up) e troca só as pontas: cada envio sai pelo Fale Fácil
// e cada marco do CRM vira mudança de etapa / comentário no lead. O motor (engine/) não sabe disso.
import type { Session } from '../adapters/simulator';
import type { Agent, ChannelPort, ConversationStore, MediaItem, PipelinePort, TurnContext, WhatsAppTemplate } from '../engine/types';
import { templateHistoryText, templateParams, windowOpen } from '../engine/templates';
import type { Bitrix, BitrixField } from './bitrix';
import { leadValue, toBitrixValue } from './bitrix';
import type { FaleFacil } from './falefacil';
import type { IntegrationConfig } from './types';

/** O que a Session guarda de uma conversa real. */
export interface LiveInfo {
  kitKey: string;
  leadId: string | null;
  /** https://<portal>.bitrix24.com.br (link do lead no painel). */
  portal: string | null;
  startedAt: string;
}

export const liveSessionId = (kitKey: string, phone: string) => `live_${kitKey}_${phone}`;

export function lastInboundAt(s: Session): number | null {
  const m = [...s.messages].reverse().find((x) => x.role === 'user');
  return m ? Date.parse(m.createdAt) : null;
}

/** Etapa do kit que corresponde a um STATUS_ID do CRM (para o card só andar para a frente). */
export function kitStageFor(cfg: IntegrationConfig, crmStage: string | null | undefined): string | null {
  if (!crmStage) return null;
  return Object.entries(cfg.stage_map).find(([, v]) => v === crmStage)?.[0] ?? null;
}

/** Dados do lead → dados conhecidos do atendimento (o que veio do formulário). */
export function leadKnownFields(lead: Record<string, any>, cfg: IntegrationConfig, fields: BitrixField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const name = [lead.NAME, lead.LAST_NAME].filter((x) => x && String(x).trim()).join(' ').trim();
  if (name) out.nome = name;
  for (const m of cfg.field_map) {
    if (!m.crm_field || !m.key) continue;
    const v = leadValue(lead, m.crm_field, fields.find((f) => f.code === m.crm_field));
    if (v) out[m.key] = v;
  }
  return out;
}

export interface LiveClients { ff: FaleFacil; bx: Bitrix }

export interface LiveContextDeps {
  /** URL pública e temporária de um arquivo ("media/..." do kit, "live/..." da conversa). */
  publicUrl(path: string): string;
}

const MIRROR_FLUSH_MS = 5000;
const mirrors = new Map<string, { lines: string[]; timer: NodeJS.Timeout | null }>();

function mirror(s: Session, bx: Bitrix, line: string) {
  const leadId = s.live?.leadId;
  if (!leadId) return;
  const m = mirrors.get(s.id) ?? { lines: [], timer: null };
  mirrors.set(s.id, m);
  m.lines.push(line);
  if (m.timer) clearTimeout(m.timer);
  m.timer = setTimeout(() => {
    const text = `💬 IA no WhatsApp:\n\n${m.lines.join('\n\n')}`;
    mirrors.delete(s.id);
    bx.comment(leadId, text).catch((e) => console.error(`timeline do lead ${leadId}`, e.message));
  }, MIRROR_FLUSH_MS);
}

const FF_TYPE: Record<MediaItem['type'], 'image' | 'video' | 'audio' | 'document'> = { image: 'image', video: 'video', audio: 'audio', document: 'document' };

/** Contexto do turno para a conversa real: base (registro na Session) + envio/CRM de verdade. */
export function buildLiveContext(
  s: Session, agent: Agent, base: TurnContext, cfg: IntegrationConfig, { ff, bx }: LiveClients, deps: LiveContextDeps,
): TurnContext {
  const to = s.phone;
  const leadId = s.live?.leadId ?? null;
  const say = (line: string) => { if (cfg.mirror_to_timeline) mirror(s, bx, line); };
  const crmSafe = async (what: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) {
      await base.pipeline.emitEvent({ kind: 'info', message: `⚠️ Bitrix (${what}): ${(e as Error).message.slice(0, 200)}` });
    }
  };

  const channel: ChannelPort = {
    async sendText(text) {
      await ff.sendText(to, text);
      await base.channel.sendText(text);
      say(text);
    },
    async sendMedia(item) {
      const kind = item.video_note ? 'video' : FF_TYPE[item.type];
      await ff.sendMedia(to, kind, deps.publicUrl(item.path), item.video_note ? null : item.caption ?? null);
      await base.channel.sendMedia(item);
      say(`[${item.type === 'audio' ? 'Áudio' : item.type === 'video' ? 'Vídeo' : 'Arquivo'}${item.transcript ? `: "${item.transcript}"` : ''}]`);
    },
    // a API do Fale Fácil não tem reação: só registra
    async sendReaction(toMsg, emoji) { await base.channel.sendReaction(toMsg, emoji); },
    async postInternalNote(text) {
      await base.channel.postInternalNote(text);
      if (leadId) await crmSafe('nota', () => bx.comment(leadId, text));
    },
    async setTyping(on, mode) { await base.channel.setTyping?.(on, mode); },
    async sendTemplate(tpl: WhatsAppTemplate, known) {
      const header = tpl.header ? { type: tpl.header.type, url: tpl.header.url || (tpl.header.path ? deps.publicUrl(tpl.header.path) : '') } : null;
      await ff.sendTemplate(to, tpl.name, tpl.lang || 'pt_BR', templateParams(tpl, known), header?.url ? header : null);
      const text = templateHistoryText(tpl, known);
      await base.channel.sendText(text);
      say(`📨 Template "${tpl.name}":\n${text}`);
    },
    async canSendFreeText() { return windowOpen(lastInboundAt(s)); },
  };

  const stageName = (id: string) => agent.crm?.stages.find((x) => x.id === id)?.name ?? id;
  const labelNames = (ids: string[]) => ids.map((id) => agent.crm?.labels.find((l) => l.id === id)?.name ?? id).join(', ');

  const pipeline: PipelinePort = {
    async isInOnboarding() {
      if (!cfg.enabled || s.state.status !== 'active') return false;
      if (!cfg.active_stages.length || !leadId) return !!leadId;
      try {
        const lead = await bx.getLead(leadId);
        return !!lead && cfg.active_stages.includes(String(lead.STATUS_ID));
      } catch (e) {
        await base.pipeline.emitEvent({ kind: 'info', message: `⚠️ Bitrix (etapa do lead): ${(e as Error).message.slice(0, 200)}` });
        return false; // na dúvida não responde
      }
    },
    async moveToHandoff(note) {
      await base.pipeline.moveToHandoff(note);
      const h = cfg.handoff;
      if (leadId && h.assign_user_id) await crmSafe('responsável', () => bx.updateLead(leadId, { ASSIGNED_BY_ID: h.assign_user_id }));
      if (h.transfer_id) {
        try { await ff.transferChat(to, h.transfer_id, h.transfer_type); } catch (e) {
          await base.pipeline.emitEvent({ kind: 'info', message: `⚠️ Fale Fácil (transferir chat): ${(e as Error).message.slice(0, 200)}` });
        }
      }
    },
    async moveToLost(note, lostReasonId) { await base.pipeline.moveToLost(note, lostReasonId); },
    async attachLabel(id) { await base.pipeline.attachLabel(id); },
    async emitEvent(event) { await base.pipeline.emitEvent(event); },
    async moveToStage(stageId, note) {
      const crmStage = cfg.stage_map[stageId];
      await base.pipeline.moveToStage?.(stageId, note);
      if (!leadId) return;
      if (!crmStage) {
        await base.pipeline.emitEvent({ kind: 'info', message: `⚠️ Etapa "${stageName(stageId)}" sem etapa do Bitrix no mapa (aba Fale Fácil + Bitrix).` });
        return;
      }
      await bx.updateLead(leadId, { STATUS_ID: crmStage });
      await crmSafe('nota', () => bx.comment(leadId, `📌 IA moveu o card para "${stageName(stageId)}"${note ? `\n${note}` : ''}`));
    },
    async addLabels(ids) {
      await base.pipeline.addLabels?.(ids);
      if (leadId && ids.length) await crmSafe('etiquetas', () => bx.comment(leadId, `🏷️ IA: ${labelNames(ids)}`));
    },
    async removeLabels(ids) { await base.pipeline.removeLabels?.(ids); },
  };

  // dado coletado/corrigido na conversa → campo do lead (só os marcados "gravar no CRM")
  const back = cfg.field_map.filter((m) => m.write_back && m.crm_field && m.key);
  const store: ConversationStore = !back.length || !leadId ? base.store : {
    ...base.store,
    async saveKnownFields(next) {
      const prev = await base.store.getKnownFields();
      await base.store.saveKnownFields(next);
      const changed = back.filter((m) => next[m.key] != null && String(next[m.key]) !== String(prev[m.key] ?? ''));
      if (!changed.length) return;
      await crmSafe('campos', async () => {
        const fields = await bx.fields();
        const patch: Record<string, unknown> = {};
        for (const m of changed) {
          const v = toBitrixValue(next[m.key], fields.find((f) => f.code === m.crm_field));
          if (v != null) patch[m.crm_field] = v;
        }
        if (Object.keys(patch).length) await bx.updateLead(leadId, patch);
      });
    },
  };

  return { ...base, store, channel, pipeline };
}
