import type { SessionCost } from './api';

const nf = (n: number) => n.toLocaleString('pt-BR');
export const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 });
export const usd = (v: number) => `US$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 5 : 2 })}`;

/** Custo da conversa: cada chamada de IA (tokens) e cada áudio transcrito (minutos). */
export default function CostPanel({ cost }: { cost: SessionCost }) {
  const { items, totals, fx, prices } = cost;
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Custo da conversa</h2>
          <p>Preços oficiais do Together, convertidos pelo câmbio do dia.</p>
        </div>
      </div>

      <div className="cost-total">
        <strong>{brl(totals.brl)}</strong>
        <span>{usd(totals.usd)}</span>
      </div>
      <div className="cost-sub">
        {nf(totals.input)} tokens de entrada{totals.cached ? ` (${nf(totals.cached)} em cache)` : ''} · {nf(totals.output)} de saída
        {totals.audioSeconds ? ` · ${totals.audioSeconds.toFixed(0)}s de áudio` : ''}
      </div>

      {items.length ? (
        <table className="cost-table">
          <thead>
            <tr><th>Etapa</th><th className="num">Entrada</th><th className="num">Saída</th><th className="num">R$</th></tr>
          </thead>
          <tbody>
            {items.map((i, n) => (
              <tr key={n}>
                <td>{i.label}<span className="cost-model">{i.model}</span></td>
                <td className="num">{i.kind === 'audio' ? `${i.seconds.toFixed(1)}s` : nf(i.input)}</td>
                <td className="num">{i.kind === 'audio' ? '—' : nf(i.output)}</td>
                <td className="num" title={i.usd !== null ? usd(i.usd) : 'sem preço'}>{i.brl !== null ? brl(i.brl) : '—'}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td>Total</td><td className="num">{nf(totals.input)}</td><td className="num">{nf(totals.output)}</td><td className="num">{brl(totals.brl)}</td></tr>
          </tfoot>
        </table>
      ) : <p className="empty">Nenhuma chamada ainda.</p>}

      {totals.unpriced.length > 0 && (
        <div className="cost-warn">Sem preço na tabela do Together: {[...new Set(totals.unpriced)].join(', ')} (contado como R$ 0).</div>
      )}
      {prices.error && <div className="cost-warn">Não consegui atualizar a tabela de preços: {prices.error}</div>}

      <details className="cost-prices">
        <summary>Câmbio e tabela de preços</summary>
        <ul>
          <li>US$ 1 = R$ {fx.rate.toLocaleString('pt-BR', { minimumFractionDigits: 4 })} · {fx.source}{fx.quotedAt ? ` · ${fx.quotedAt}` : ''}</li>
          {prices.models.map(({ model, price }) => (
            <li key={model}>
              {model}: {price
                ? price.per_minute
                  ? `US$ ${price.per_minute} por minuto`
                  : `US$ ${price.input} entrada · ${price.output} saída · ${price.cached_input} cache (por 1M tokens)`
                : 'sem preço'}
            </li>
          ))}
          {prices.loadedAt && <li>Tabela atualizada em {new Date(prices.loadedAt).toLocaleString('pt-BR')}</li>}
        </ul>
      </details>
    </section>
  );
}
