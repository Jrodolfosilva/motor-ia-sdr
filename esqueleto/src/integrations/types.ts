// Módulo de integração: um CANAL (WhatsApp: Fale Fácil) + um CRM (Bitrix24). Cada um é independente,
// para dar para combinar depois com outros (ex: Fale Fácil + outro CRM). A configuração sem segredo
// fica no kit (agent.integration); chaves e tokens ficam na coleção `integration_secrets`.

export type ChannelProvider = 'falefacil';
export type CrmProvider = 'bitrix';

/** Campo do lead no CRM ↔ dado do atendimento. */
export interface FieldMapping {
  /** Código do campo no CRM (ex: UF_CRM_LEAD_1782484149747, NAME). */
  crm_field: string;
  /** Chave da pergunta do roteiro (ex: data_parto), "nome", ou um rótulo livre (vira contexto para a IA). */
  key: string;
  /** Gravar de volta no CRM quando a IA coletar/corrigir o dado. */
  write_back?: boolean;
}

export interface IntegrationConfig {
  /** Atendimento real ligado. Desligado = webhooks chegam e são ignorados. */
  enabled: boolean;
  channel: ChannelProvider;
  crm: CrmProvider;
  /**
   * Quem manda o template de abertura (lead de formulário):
   * engine = o motor, quando o CRM avisa que o lead entrou (robô/webhook do Bitrix chama /hooks/bitrix/...);
   * external = a automação do CRM (robô do Fale Fácil); o motor assume quando a lead responder.
   */
  opening_mode: 'engine' | 'external';
  /** Etapa do kit (agent.crm.stages[].id) → etapa do CRM (STATUS_ID). */
  stage_map: Record<string, string>;
  /** Etapas do CRM (STATUS_ID) em que a IA atende. Vazio = todas. Card fora delas = a equipe assumiu. */
  active_stages: string[];
  field_map: FieldMapping[];
  handoff: {
    /** Transferir o chat do Canal Aberto ao passar para a equipe. */
    transfer_type: 'user' | 'queue';
    transfer_id: string | null;
    /** Trocar o responsável do lead ao passar para a equipe. */
    assign_user_id: string | null;
  };
  /** Copiar as mensagens da IA na timeline do lead (a API oficial não replica no chat do Bitrix). */
  mirror_to_timeline: boolean;
  /** Só atende estes telefones (teste). Vazio = todos. */
  test_phones: string[];
}

export const defaultIntegration = (): IntegrationConfig => ({
  enabled: false,
  channel: 'falefacil',
  crm: 'bitrix',
  opening_mode: 'external',
  stage_map: {},
  active_stages: [],
  field_map: [],
  handoff: { transfer_type: 'user', transfer_id: null, assign_user_id: null },
  mirror_to_timeline: true,
  test_phones: [],
});

export function integrationOf(raw: Record<string, any> | null | undefined): IntegrationConfig | null {
  const i = raw?.agent?.integration;
  if (!i) return null;
  const d = defaultIntegration();
  return { ...d, ...i, handoff: { ...d.handoff, ...(i.handoff ?? {}) }, field_map: i.field_map ?? [], stage_map: i.stage_map ?? {}, active_stages: i.active_stages ?? [], test_phones: i.test_phones ?? [] };
}

/** Segredos por agente (nunca vão para o kit.json nem voltam inteiros para o painel). */
export interface IntegrationSecrets {
  falefacil_api_key?: string | null;
  /** X-Webhook-Token da aba Desenvolvedor da conexão (valida que o webhook veio do Fale Fácil). */
  falefacil_webhook_token?: string | null;
  /** Webhook de entrada do Bitrix (https://<portal>.bitrix24.com.br/rest/<user>/<código>/). */
  bitrix_webhook_url?: string | null;
}

/** Mensagem recebida, já normalizada (Meta Cloud API ou WAPI). */
export interface InboundMessage {
  id: string;
  /** Telefone só com dígitos, como veio. */
  from: string;
  name?: string | null;
  fromMe: boolean;
  isGroup: boolean;
  type: 'text' | 'audio' | 'image' | 'document' | 'video' | 'sticker' | 'reaction' | 'other';
  text: string;
  media?: { id?: string | null; url?: string | null; mime?: string | null; filename?: string | null } | null;
}
