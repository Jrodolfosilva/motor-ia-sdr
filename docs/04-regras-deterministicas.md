# 04. Regras determinísticas (código, sem LLM)

Fonte: `referencia-laravel/app/Services/Ai/Onboarding/{RequiredFieldsStatus,ClassificationRuleEvaluator}.php`, `referencia-laravel/app/Support/{DurationNormalizer,AiTimeContext,BrazilianDdd}.php`.

Esses módulos são **puros** (sem I/O): porte primeiro e cubra com testes unitários. São os mais fáceis de testar e os que mais protegem o comportamento.

## RequiredFieldsStatus
Entrada: `required_fields[]` + `known` (custom_fields). É a **única** definição de "campo preenchido" usada pelos 3 agentes.

```ts
hasValue(key)       = known[key] != null && known[key] !== ''
missing()           = fields.filter(f => !hasValue(f.key))
isComplete()        = missing().length === 0      // sem roteiro → true
unmatched()         = entries de known cujo key NÃO está no roteiro e valor não vazio
                      // = respostas de formulário/anúncio com chaves livres
hasAnyKnownData()   = algum campo do roteiro preenchido || unmatched() não vazio
                      // true → Fluxo A (lead quente); false → Fluxo B (lead frio)
```

## ClassificationRuleEvaluator
`rules = [{field, operator, value}]`. Lista **vazia nunca casa**. Todas precisam casar (AND).

| operator | casa quando |
|---|---|
| `present` | valor não nulo/vazio |
| `contains_any` | valor string contém algum dos `value[]` (substring, sem acento, case-insensitive) |
| `not_contains_any` | valor **não vazio** e não contém nenhum |
| `gte_months` / `lt_months` | `DurationNormalizer.toMonths(valor)` ≥ / < value |
| `months_since_gte` / `months_since_lt` | meses desde a data no valor ≥ / < value |
| outro | false |

**Usado em 2 pontos:**
1. Qualifier: primeira label (ordem declarada) cujas regras casam → decide sem LLM.
2. Runner: LLM mandou **desqualificar** uma label que tem `rules`, mas as regras não casam → **rejeita** e a conversa continua. (Desqualificar é a única decisão sem volta, então precisa da trava.)

### monthsSince(valor)
- Se achar data → `monthsSinceDate`; senão fallback `DurationNormalizer.toMonths` ("há 8 meses").
- `monthsSinceDate`: data futura → null. Meses inteiros entre data e hoje (startOfDay).

### parseDate (ordem de tentativa, texto sem acento e minúsculo)
1. `AAAA-MM-DD`
2. `DD/MM/AAAA` ou `DD/MM/AA` (separadores `/ . -`); AA<100 → +2000
3. `MM/AAAA` → dia 1
4. `out/2025`, `outubro de 2025`, `out 2025` → dia 1 (jan fev mar abr mai jun jul ago set out nov dez)
5. valida com checkdate; inválida → null

Normalização de acento: `á â ã à→a, é ê→e, í→i, ó ô õ→o, ú→u, ç→c`.

## DurationNormalizer
Regex: `/(?<number>\d+|[a-zà-ú]+(?:\s+e\s+[a-zà-ú]+)?)\s*(?<unit>m[eê]s(?:es)?|semanas?|anos?)/iu`

- `normalize(texto)`: substitui cada duração por forma canônica (`"oito meses"` → `"8 meses"`, `"um ano"` → `"1 ano"`), resto intacto. Número por extenso não reconhecido → mantém original.
- `toMonths(texto)`: primeira duração em meses (`semana` → `floor(n/4)`, `ano` → `n*12`). Nada → null (**nunca 0**).
- Números por extenso até 99: `zero um/uma dois/duas tres quatro ... dezenove vinte trinta ... noventa` e `"vinte e tres"` (dezena ≥20 + unidade <10).

## AiTimeContext.line(phone?)
Fuso `America/Sao_Paulo`. Literal:
```
CONTEXTO ATUAL: hoje é {segunda-feira}, {02/11/2026} ({2 de novembro}), ano atual {2026}, {14:30} no horário de Brasília. País: Brasil{ (lead do DDD de São Paulo - SP)}. Use isso para entender datas relativas ("esse ano", "mês passado", "semana passada", "em julho") - um mês sem ano é a ocorrência mais próxima que faz sentido (saída do emprego já aconteceu, previsão de parto ainda vai acontecer) - e calcular há quanto tempo algo aconteceu ou quanto falta - nunca pergunte o ano se o lead já deu uma referência que permite deduzir.
```
Motivo: sem a data de hoje o modelo não resolve "nasceu semana passada" e chegou a perguntar se a lead "ainda estava grávida".

## BrazilianDdd
- `stateFor(phone)`: só dígitos; precisa começar com `55` e ter ≥4 dígitos; DDD = dígitos[2..4] → `{uf, name}` ou null. Mapa completo em `referencia-laravel/app/Support/BrazilianDdd.php`.
- `inState(state)`: preposição + nome ("na Bahia", "no Rio de Janeiro", "em Minas Gerais"). Copie a tabela `PREPOSITIONS` do arquivo de referência.
- Usado na saudação: `" Atendemos em todo o Brasil, com forte presença {inState}."`. Isso é **concatenado em código**, não pedido ao LLM (modelo barato pulava).

## splitIntoBubbles(text)
```ts
paragraphs = text.trim().split(/\n\s*\n/u).map(trim).filter(nonEmpty)
if (paragraphs.length <= 3) return paragraphs
return [p[0], p[1], paragraphs.slice(2).join('\n\n')]
```

## Typing delay (Evolution)
`delaySeconds = min(6, max(2, ceil(text.length / 20)))`. Envia presence `composing` com esse delay e **espera de verdade** antes de mandar o texto (o `delay` da Evolution não segura o request). Meta Cloud API já mostra "digitando" sozinha.
