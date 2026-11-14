import type { PendingItem, PendingStatus, RequiredDocument, RequiredField } from '../types';

/**
 * Quantas vezes a IA reforça e pede de novo antes de o item deixar de travar o roteiro
 * (o item é liberado para a equipe quando o lead dá a mesma resposta `insist + 1` vezes).
 * A cada reforço a IA explica por que precisa (`why`) e orienta como descobrir/conseguir (`help`/`how_to_get`).
 * O item pode trocar o padrão com `insist` (exceto "depois", que só combina de mandar e lembra no fim).
 */
export const DEFAULT_INSIST: Record<PendingStatus, number> = { depois: 1, nao_sabe: 2, vaga: 2, nao_tem: 1, recusou: 1 };

export const PENDING_LABEL: Record<PendingStatus, string> = {
  depois: 'vai enviar/responder depois',
  nao_sabe: 'não sabe / não lembra',
  vaga: 'resposta vaga ou fora do esperado',
  nao_tem: 'não tem / não consegue',
  recusou: 'recusou informar',
};

/** Vezes que a IA insiste no item com esse tipo de resposta. */
export function insistFor(item: { insist?: number | null } | undefined, status: PendingStatus): number {
  if (status === 'depois' || item?.insist == null || !Number.isFinite(item.insist)) return DEFAULT_INSIST[status];
  return Math.max(0, Math.floor(item.insist));
}

export const filled = (v: unknown) => v !== null && v !== undefined && v !== '';

export interface RoteiroProgress {
  /** Perguntas que vieram do formulário (Meta/LP). */
  formKeys?: string[] | null;
  /** Perguntas do formulário que o lead já confirmou/corrigiu. */
  confirmedKeys?: string[];
  /** Itens adiados, sem acesso ou recusados. */
  pending?: Record<string, PendingItem>;
}

export type QuestionState = 'missing' | 'to_confirm' | 'confirmed' | 'collected';

/**
 * Única definição de "roteiro completo", usada pelos 3 sub-agentes.
 * Roteiro = PERGUNTAS (texto) + DOCUMENTOS (arquivos).
 * Pergunta que veio do formulário só conta depois de confirmada pelo lead
 * ou comprovada por um documento recebido que a valida.
 */
export class RequiredFieldsStatus {
  public readonly documents: RequiredDocument[];
  private readonly formKeys: Set<string>;
  private readonly confirmedKeys: Set<string>;
  public readonly pending: Record<string, PendingItem>;

  constructor(
    public readonly fields: RequiredField[],
    public readonly known: Record<string, unknown>,
    documents: RequiredDocument[] = [],
    progress: RoteiroProgress = {},
  ) {
    this.documents = documents;
    this.formKeys = new Set(progress.formKeys ?? []);
    this.confirmedKeys = new Set(progress.confirmedKeys ?? []);
    this.pending = progress.pending ?? {};
  }

  /** Pendência ativa do item (só vale enquanto o item não tem valor). */
  pendingFor(key: string): PendingItem | null {
    const p = this.pending[key];
    return p && !filled(this.known[key]) ? p : null;
  }

  /** Pendência que já não trava o roteiro (a IA já insistiu o quanto devia). */
  isPendingResolved(key: string): boolean {
    const p = this.pendingFor(key);
    return !!p && p.count > insistFor(this.item(key), p.status);
  }

  /** Reforços que ainda restam antes de liberar o item (0 = já liberado). */
  insistLeft(key: string): number {
    const p = this.pendingFor(key);
    return p ? Math.max(0, insistFor(this.item(key), p.status) + 1 - p.count) : 0;
  }

  item(key: string): RequiredField | RequiredDocument | undefined {
    return this.fields.find((f) => f.key === key) ?? this.documents.find((d) => d.key === key);
  }

  /** Itens que ficaram sem resposta/documento mas não travam mais (vão no resumo do handoff). */
  unresolvedButReleased(): { key: string; label: string; item: PendingItem }[] {
    return [...this.fields, ...this.documents]
      .filter((x) => this.isPendingResolved(x.key))
      .map((x) => ({ key: x.key, label: x.label, item: this.pending[x.key] }));
  }

  value(key: string): unknown {
    return this.known[key] ?? null;
  }

  /** Documentos já recebidos que comprovam a pergunta. */
  validatedBy(key: string): RequiredDocument[] {
    return this.documents.filter((d) => d.validates?.includes(key) && filled(this.known[d.key]));
  }

  questionState(f: RequiredField): QuestionState {
    if (!filled(this.known[f.key])) return 'missing';
    if (!this.formKeys.has(f.key)) return 'collected';
    if (this.confirmedKeys.has(f.key) || this.validatedBy(f.key).length) return 'confirmed';
    return 'to_confirm';
  }

  /** Valor firme: preenchido e (se veio do formulário) já confirmado. Documento: recebido. */
  isSettled(key: string): boolean {
    if (!filled(this.known[key])) return false;
    const f = this.fields.find((x) => x.key === key);
    return !f || this.questionState(f) !== 'to_confirm';
  }

  missingQuestions(): RequiredField[] {
    return this.fields.filter((f) => this.questionState(f) === 'missing' && !this.isPendingResolved(f.key));
  }

  toConfirm(): RequiredField[] {
    return this.fields.filter((f) => this.questionState(f) === 'to_confirm');
  }

  missingDocuments(): RequiredDocument[] {
    return this.documents.filter((d) => !filled(this.known[d.key]) && !this.isPendingResolved(d.key));
  }

  /** Itens pendentes do roteiro (perguntas sem resposta ou a confirmar + documentos não recebidos). */
  missing(): (RequiredField | RequiredDocument)[] {
    return [...this.missingQuestions(), ...this.toConfirm(), ...this.missingDocuments()];
  }

  isComplete(): boolean {
    return this.missing().length === 0;
  }

  /** Dados de formulário/anúncio com chaves livres (fora do roteiro). */
  unmatched(): Record<string, unknown> {
    const keys = new Set([...this.fields.map((f) => f.key), ...this.documents.map((d) => d.key)]);
    return Object.fromEntries(
      Object.entries(this.known).filter(([k, v]) => !keys.has(k) && filled(v)),
    );
  }

  /** Perguntas do roteiro preenchidas agora (usado no 1º turno para fixar o que veio do formulário). */
  filledQuestionKeys(): string[] {
    return this.fields.filter((f) => filled(this.known[f.key])).map((f) => f.key);
  }

  /** true = lead de formulário (pré-qualificado); false = lead frio (volume). */
  hasAnyKnownData(): boolean {
    return this.fields.some((f) => filled(this.known[f.key])) || Object.keys(this.unmatched()).length > 0;
  }
}
