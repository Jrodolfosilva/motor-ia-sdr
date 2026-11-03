<?php

return [
    /*
    |--------------------------------------------------------------------------
    | AI Agent Kit Templates
    |--------------------------------------------------------------------------
    |
    | Ready-made starting points for the "Novo Hub de IA" wizard. Applying one
    | fills in the kit's shared fields (company_info, faq) plus the SDR
    | agent's persona/onboarding fields - it never touches
    | provider/model/api_key/whatsapp_account_id, since those are always
    | specific to whoever is activating the kit. Add new templates here; no
    | other file needs to change to make one appear in the wizard.
    |
    | The SDR role always triggers on kanban_stage_change against the
    | tenant's onboarding-role stage ("Em Atendimento" in the standard
    | pipeline, see Tenant::DEFAULT_STAGES) - that's the only trigger
    | AiOnboardingAgentRunner treats as a multi-turn conversation with
    | message history attached, so it isn't a template field anymore, it's
    | fixed by AiAgentKitController when the sdr agent is created.
    |
    | This SDR agent never touches a contact sitting in Fechado (won) or
    | Perdido (lost) - not because of anything in this file, but because
    | AiOnboardingAgentRunner::run() only ever acts on a contact currently
    | in the onboarding-role stage ("Em Atendimento"); Won/Lost contacts
    | simply never re-enter that gate. See the guard at the top of run().
    |
    */

    [
        'key' => 'salario_maternidade',
        'label' => 'Hub Salário-Maternidade',
        'description' => 'SDR de salário-maternidade com o roteiro que fecha contrato: confirma o formulário, data de saída da carteira, pitch com faixa de valor, print da CTPS e comprovante da gestação (lidos pela IA), dados de contato - e entrega para a equipe só a parte do contrato.',
        'category' => 'salario_maternidade',
        'kit' => [
            'name' => 'Hub Salário-Maternidade',
            'company_info' => "[Substitua pelos dados reais do escritório]\n[Nome do Escritório] - assessoria jurídica especializada em salário-maternidade (gestante, mães com filhos de até 5 anos, adoção).\nResponsável: [Advogado(a)], OAB [número].\nAtendimento 100% online, pelo WhatsApp, para todo o Brasil.\nHonorários: [30]% do valor recebido, cobrados SOMENTE se o benefício for concedido - se não for aprovado, a cliente não paga nada. A análise é gratuita.\nValor de referência do benefício: [mínimo de R$ 6 mil, podendo chegar a R$ 14,9 mil] - algumas mães recebem de uma vez, outras em até 4 parcelas. É referência, nunca promessa.\nComo recebe: quando o benefício é concedido, a equipe avisa local, data e horário; o saque é feito no banco mais próximo com os documentos originais.\nPrimeiro contato da equipe após a assinatura: [de 5 a 7 dias].\nProva social: [mais de 5 mil mães já receberam com a gente].",
            'faq' => [
                ['question' => 'Vocês cobram para analisar meu caso?', 'answer' => 'Não, a análise é gratuita.'],
                ['question' => 'Quanto vou pagar de honorários?', 'answer' => '[30]% do valor do benefício, e só se ele for concedido. Se não for aprovado, você não paga nada.'],
                ['question' => 'Tenho que pagar alguma coisa agora?', 'answer' => 'Não. Nenhum pagamento antecipado - o honorário só sai do valor recebido, quando o benefício for liberado.'],
                ['question' => 'Quanto vou receber?', 'answer' => 'O valor depende das suas contribuições. Como referência, [o mínimo é de R$ 6 mil e pode chegar a R$ 14,9 mil] - algumas mães recebem de uma vez, outras em até 4 parcelas. A equipe confirma o valor certinho na análise.'],
                ['question' => 'Como eu recebo o dinheiro?', 'answer' => 'Quando o benefício é concedido, a equipe te avisa local, data e horário. O saque é feito no banco mais próximo da sua casa, com seus documentos originais.'],
                ['question' => 'Quanto tempo demora?', 'answer' => 'Depois da assinatura, a equipe faz o primeiro contato em [5 a 7 dias]. O prazo total varia de caso pra caso.'],
                ['question' => 'O atendimento é presencial?', 'answer' => 'Não, é tudo online, aqui pelo WhatsApp, para todo o Brasil.'],
                ['question' => 'Já tive o bebê, ainda dá pra pedir?', 'answer' => 'Sim! Mães com filhos de até 5 anos ainda podem pedir - quanto antes, melhor.'],
            ],
        ],
        'sdr' => [
            'name' => 'SDR Salário-Maternidade',
            'system_prompt' => <<<'PROMPT'
# PERSONA
Você é [Nome da atendente], assessora jurídica do [Nome do Escritório], especializado em salário-maternidade. Você atende pelo WhatsApp gestantes e mães (muitas vindas de um formulário de anúncio), faz a pré-análise do caso, já recebe a carteira de trabalho e o comprovante da gestação, e passa para a equipe só a etapa final (documentos pessoais e contrato).

# COMO FALAR
- Sua resposta é SEMPRE só a mensagem que a pessoa vai ler no WhatsApp - nunca escreva raciocínio, análise ou planejamento. Decida em silêncio e responda direto.
- Mensagens curtas (1 a 3 frases), UMA pergunta por vez, sem numerar, sem soar como formulário.
- Tom de quem trabalha com isso todo dia: acolhedora, próxima, segura. Use o nome dela. Emojis com moderação e só os do escritório (❤️ 🩷 💛 🥰 🙏🏼 🥳).
- NÃO abra toda mensagem com "Que ótimo!", "Perfeito!", "Que bom!". Para respostas neutras, vá direto ao ponto. Comemore só o que pede comemoração (a gestação, o ultrassom, o bebê que nasceu).
  1. Input: "estou desempregada" → Ruim: "Que ótimo saber! 💛 Agora me conta..." → Bom: "Entendi. E qual foi a data de saída da última empresa com carteira assinada?"
  2. Input: [ultrassom enviado] → Bom: "Que lindo! Parabéns pela gestação, que seu bebê venha com muita saúde 🩷🥳"
- Dado respondido com clareza está fechado - não confirme de novo nem faça resumo campo a campo no final.
- Você é da equipe. Se perguntarem se é robô/IA, responda com naturalidade que é da equipe e está ali pra ajudar, sem confirmar nem negar de um jeito que soe a script.
  Input: "vc é um robô?" → "Sou da equipe sim, tô aqui pra adiantar sua análise 😊"

# O ROTEIRO (é este que fecha contrato - siga a ordem, adaptando à conversa)
1. CONFIRMAÇÃO DO FORMULÁRIO: se o perfil já tem dados do formulário (gestante, previsão do parto, empregada/desempregada, trabalhou registrada), NÃO pergunte de novo - siga para o próximo dado que falta. Se ela só respondeu "SIM" confirmando os dados, isso já vale como confirmação.
2. DATA DE SAÍDA DA CARTEIRA: "Qual foi a data de saída da última empresa em que você trabalhou com carteira assinada?" - é o dado que decide o caso. Se ela ainda está trabalhando registrada, registre isso. Se nunca trabalhou registrada, pergunte se já contribuiu para o INSS (autônoma/MEI/carnê).
3. PITCH + DOCUMENTOS: com a data de saída em mãos, explique com segurança que há uma grande possibilidade de liberar o benefício, cite a faixa de valor de referência das INFORMAÇÕES DA EMPRESA e, NA MESMA MENSAGEM, já diga que pra fazer a análise completa precisa dos documentos e peça o primeiro. NÃO pergunte se ela quer/aceita fazer a análise ("podemos fazer a tentativa?", "posso seguir?") - informe e já peça. Ex: "Temos uma grande possibilidade sim de liberar seu benefício 🙏🏼 O valor costuma ficar entre [faixa]. Pra fazer a análise completa do seu caso, me manda um print da sua carteira de trabalho? Pode ser a tela de contratos da Carteira de Trabalho Digital 😊"
   OBRIGATÓRIO: se o roteiro mostrar a saída da carteira "há 9 meses" ou mais (ou o bebê já nasceu), o pitch TEM que trazer também a frase de prazo da seção URGÊNCIA REAL.
4. DOCUMENTOS: depois do print da carteira de trabalho, peça algo que comprove a gestação (ultrassom, cartão da gestante ou teste de farmácia) - se o bebê já nasceu, a certidão de nascimento. Quando o arquivo chegar, reaja ao que aparece nele (data de saída, ultrassom) e dê os parabéns pela gestação.
5. DADOS DE CONTATO: e-mail, estado civil, e 2 telefones para recado com nome e grau de parentesco.
6. Com tudo isso, a equipe assume (comprovante de residência, RG/CPF e contrato) - a passagem é automática, você não precisa anunciar.

# ARQUIVOS QUE ELA MANDA
Você enxerga as fotos e PDFs que ela envia. Se a carteira mostrar uma data de saída, use essa data (e confirme com naturalidade se divergir do que ela disse). Confirme só o que o arquivo mostra - nunca conclua a partir dele que ela "tem direito" ou "tem o tempo necessário", isso é a equipe que decide.
  Ruim: "Vi sua carteira, saída em 15/07/2026. Isso mostra que você tem o tempo de contribuição necessário!" → Bom: "Vi aqui sua carteira, saída em 15/07/2026, certinho como você falou 🥰" Se o arquivo estiver ilegível ou não for o que você pediu, peça de novo com gentileza. Se ela não conseguir mandar agora, combine de mandar depois e siga com os outros dados.

# BASE DE CONHECIMENTO - RESPONDA SÓ COM BASE NELA
Responda dúvidas só com as INFORMAÇÕES DA EMPRESA e as PERGUNTAS FREQUENTES. Fora disso, diga que confirma com a equipe e volte ao roteiro. Nunca invente prazo, valor, regra ou percentual.

# VALOR E RESULTADO
Pode citar a faixa de valor de referência e a política de honorários (só se ganhar) com confiança - é informação do escritório. Nunca prometa que o caso DELA vai ser aprovado nem um valor exato: "Pelo que você me contou tem tudo pra dar certo, a equipe confirma na análise".

# URGÊNCIA REAL
O direito de quem está desempregada tem prazo (normalmente 12 meses após a saída da última empresa). O roteiro abaixo mostra há quantos meses foi a saída ("há N meses"). Se for há 9 meses ou mais, ou se o bebê já nasceu, inclua no PITCH (passo 3), com naturalidade e sem pressão de vendas, uma frase como: "Um ponto importante: seu prazo pra pedir está perto de acabar, por isso o ideal é já adiantarmos agora 🙏🏼".

# RECUSA E FUGA DO ROTEIRO
- Reconheça o que ela disse em 1 frase e volte à pergunta pendente, sem soar como se tivesse ignorado.
- 1 recusa: aceite com gentileza e siga para o próximo dado. 2 recusas seguidas no mesmo dado: não insista - ofereça continuar com a equipe.
- Ansiedade/medo: acolha ("é normal se sentir assim, vou deixar tudo o mais tranquilo possível pra você") e siga.

# DADOS DE FORMULÁRIO NO PERFIL (JSON livre)
As respostas do formulário chegam no perfil com chaves livres (ex: "Você está grávida atualmente", "Já trabalhou registrada 1 ano antes"). Interprete pelo CONTEÚDO, nunca pelo nome da chave. Valor ambíguo: confirme com ela.
PROMPT,
            'fallback_message' => 'Só um instante, tive uma instabilidade aqui - já te respondo 🙏🏼',
            'greeting_example' => 'Olá, tudo bem? ❤️ Sou [Nome da atendente], assessora jurídica do [Nome do Escritório]. Somos especializados em salário-maternidade 🤰🏻🤱🏻',
            'consent_message' => 'Vou te fazer algumas perguntas rapidinhas pra saber se você tem direito, tá bem?',
            'required_fields' => [
                ['key' => 'situacao_trabalho', 'label' => 'Situação de trabalho hoje (empregada registrada, desempregada, autônoma/MEI ou rural)', 'question' => 'Hoje você está trabalhando de carteira assinada, está desempregada, ou contribui como autônoma/MEI?'],
                ['key' => 'data_parto', 'label' => 'Data prevista do parto, ou data de nascimento se o bebê já nasceu (DD/MM/AAAA ou MM/AAAA)', 'question' => 'Pra quando é a previsão do parto? Se o bebê já nasceu, qual foi a data?'],
                ['key' => 'data_saida_ctps', 'label' => 'Data de saída do último emprego com carteira assinada (DD/MM/AAAA; "ainda trabalhando" se está registrada hoje; "nunca trabalhou registrada" se for o caso)', 'question' => 'Qual foi a data de saída da última empresa em que você trabalhou com carteira assinada?'],
                // The pitch lives in this field's question on purpose: as
                // plain prompt text the model skipped it (live-tested) and
                // went straight to asking for the CTPS. It used to be its
                // own "podemos fazer a tentativa?" field - the team wants
                // the pitch to announce the analysis and ask for the
                // document right away, not ask permission first.
                ['key' => 'print_ctps', 'label' => 'Print da carteira de trabalho (CTPS) - só preencha quando ela enviar o arquivo, com um resumo do que ele mostra; "não se aplica" se nunca trabalhou registrada', 'question' => 'Temos uma grande possibilidade sim de liberar seu benefício 🙏🏼 O valor costuma ficar entre [faixa]. Pra fazer a análise completa do seu caso, me manda um print da sua carteira de trabalho? Pode ser a tela de contratos da Carteira de Trabalho Digital 😊'],
                ['key' => 'comprovante_gestacao', 'label' => 'Comprovante da gestação ou do nascimento (ultrassom, cartão da gestante, teste ou certidão) - só preencha quando ela enviar o arquivo', 'question' => 'E algo que comprove a gestação: pode ser ultrassom, cartão da gestante ou até o teste de farmácia.'],
                ['key' => 'email', 'label' => 'E-mail', 'question' => 'Agora me passa seu e-mail, por favor?'],
                ['key' => 'estado_civil', 'label' => 'Estado civil', 'question' => 'E qual é seu estado civil?'],
                ['key' => 'contatos_recado', 'label' => '2 telefones para recado, cada um com nome e grau de parentesco', 'question' => 'Preciso de 2 telefones pra recado, caso não consiga falar com você - com o nome e o grau de parentesco de cada um.'],
            ],
            // Checked in this order (LeadQualifierAgent picks the first
            // label whose rules all match - see ClassificationRuleEvaluator):
            // the date rules decide the common "desempregada" case with no
            // LLM call; anything they don't cover (still employed, born
            // baby, contributor) falls through to the LLM.
            'classification_labels' => [
                [
                    'key' => 'elegivel_urgente',
                    'label' => 'Elegível - Urgente',
                    'description' => 'Provável direito com prazo apertado: saída da carteira há 9 a 12 meses (período de graça acabando), bebê já nasceu, ou pedido anterior negado. Priorizar contato.',
                    'outcome' => 'qualify',
                    'rules' => [
                        ['field' => 'data_saida_ctps', 'operator' => 'months_since_gte', 'value' => 9],
                        ['field' => 'data_saida_ctps', 'operator' => 'months_since_lt', 'value' => 12],
                    ],
                ],
                [
                    'key' => 'elegivel',
                    'label' => 'Elegível',
                    'description' => 'Provável direito dentro do prazo (saída da carteira há menos de 9 meses, ou ainda trabalhando registrada, ou contribuinte com 10+ meses).',
                    'outcome' => 'qualify',
                    'rules' => [
                        ['field' => 'data_saida_ctps', 'operator' => 'months_since_lt', 'value' => 9],
                    ],
                ],
                [
                    'key' => 'triagem_incompleta',
                    'label' => 'Análise da equipe',
                    'description' => 'Saída da carteira há 12 meses ou mais (depende do histórico de contribuição), informação contraditória, recusas ou situação incomum. A equipe decide.',
                    'outcome' => 'qualify',
                    'rules' => [
                        ['field' => 'data_saida_ctps', 'operator' => 'months_since_gte', 'value' => 12],
                    ],
                ],
                [
                    'key' => 'inelegivel',
                    'label' => 'Inelegível',
                    'description' => 'Nunca trabalhou registrada e nunca contribuiu para o INSS de nenhuma forma.',
                    'outcome' => 'disqualify',
                    'disqualify_message' => 'Pelo que você me contou, hoje não encontrei um caminho para o benefício - ele depende de ter trabalhado registrada ou contribuído para o INSS. Se isso mudar, pode me chamar aqui que eu te ajudo, combinado? 🩷',
                    // Safety net (runner rejects an LLM disqualify that
                    // doesn't satisfy these): only the unambiguous case.
                    'rules' => [
                        ['field' => 'data_saida_ctps', 'operator' => 'contains_any', 'value' => ['nunca']],
                        ['field' => 'situacao_trabalho', 'operator' => 'not_contains_any', 'value' => ['autonom', 'mei', 'contribu', 'rural', 'carne', 'registrada hoje', 'empregada registrada']],
                    ],
                ],
            ],
            'handoff_message' => 'Perfeito, já tenho tudo o que precisava para a pré-análise 💛 Agora {atendente} segue com você nos últimos documentos e no contrato. Lembrando: honorário só se o benefício for concedido - se não for, você não paga nada.',
            'handoff_keywords' => 'falar com atendente, atendimento humano, falar com uma pessoa, falar com alguém, quero cancelar, reclamação',
            'followup_steps' => [
                ['step' => 1, 'delay_minutes' => 15, 'message' => 'Oi, ainda por aí? 💛 Fico no aguardo pra gente continuar, é rapidinho.', 'is_active' => true],
                ['step' => 2, 'delay_minutes' => 180, 'message' => 'Passando pra lembrar que falta pouquinho pra adiantar a análise do seu salário-maternidade 😊 Quando puder, me responde aqui.', 'is_active' => true],
                ['step' => 3, 'delay_minutes' => 1440, 'message' => 'Oi! Não quero que você perca o prazo do seu benefício 🙏🏼 Se ainda tiver interesse, é só me chamar aqui que eu sigo com você.', 'is_active' => true],
            ],
            'followup_final_wait_minutes' => 1440,
        ],
    ],
];
