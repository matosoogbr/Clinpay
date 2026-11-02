# ClinPay — Plataforma de gestão para clínicas odontológicas

Plataforma para várias clínicas parceiras. Cada clínica tem a própria agenda inteligente (consultas e cirurgias), prontuário eletrônico, portal do paciente, financeiro, CRM e vendas, indicadores, termos assinados e lembretes por e-mail e WhatsApp, totalmente separados das demais. A equipe ClinPay administra todas as clínicas por um painel próprio. A interface tem modo claro e escuro.

## Requisitos

Node.js 20 ou superior. Não há bibliotecas para instalar.

## Como iniciar

```
node server.js
```

Abra http://localhost:3000. No Windows, também dá para ligar com dois cliques em `iniciar.bat` (a janela precisa ficar aberta).

No **primeiro acesso**, o sistema pede para criar o **administrador ClinPay** (você). Depois disso:

1. No painel ClinPay, cadastre a clínica parceira e o **médico responsável** (e-mail e senha inicial).
2. Envie esses dados ao médico. Ele entra direto na clínica dele e cadastra os outros médicos, funcionários, salas e preços.

Para rodar os testes automáticos (no PowerShell, se o `npm` for bloqueado, use o segundo comando):

```
npm test
node --test test/api.test.js test/email.test.js test/clinpay.test.js test/tenant.test.js test/features.test.js test/ai.test.js test/persist.test.js test/dre.test.js
```

## Quem acessa o quê

| Perfil | Onde | O que pode fazer |
|---|---|---|
| Administrador ClinPay | Painel da plataforma | Cadastra, edita, suspende e reativa clínicas; cadastra outros administradores ClinPay; entra em qualquer clínica para dar suporte |
| Médico(a) responsável | Na própria clínica | Acesso total à clínica: agenda de todos os médicos, financeiro completo, cadastros, acessos, e-mails e auditoria |
| Médico(a) | Na própria clínica | Dia a dia: a própria agenda, pacientes, termos, checklist, e-mails aos pacientes e o próprio financeiro |
| Funcionário(a) do médico | Na própria clínica | Agenda e financeiro do médico ao qual está vinculado, pacientes, termos e e-mails |
| Recepção da clínica | Na própria clínica | Agenda e financeiro de todos os médicos, pacientes e termos |
| Enfermagem | Na própria clínica | Pacientes, prontuário, termos, checklist e início/fim de cirurgias (sem financeiro) |
| Paciente | Portal do paciente | Só os próprios exames liberados pelo médico e as próprias consultas; confirma ou cancela a presença |

O **prontuário** (evolução, anamnese, odontograma, exames e imagens) só é acessado por médicos, enfermagem e o médico responsável. Funcionários e recepção não veem, por sigilo médico.

As clínicas **não** veem o painel ClinPay, não veem outras clínicas e não conseguem criar administradores ClinPay.

## Separação entre clínicas

A separação é feita na camada de dados (`src/tenant.js`): toda leitura e escrita é filtrada automaticamente pela clínica de quem está logado, e todo registro novo recebe a clínica. Sem clínica definida, o acesso é recusado. Assim, nenhuma tela ou rota consegue, nem por engano, mostrar dados de outra clínica. O arquivo `test/tenant.test.js` confere isso.

- O e-mail de login é único em toda a plataforma.
- O mesmo CPF pode existir em clínicas diferentes (cada clínica tem o próprio cadastro).
- Ao suspender uma clínica, todos os usuários dela perdem o acesso na hora. Os dados continuam guardados.
- Quando um administrador ClinPay entra numa clínica, isso fica registrado na **auditoria da própria clínica**, identificado como "(ClinPay)".

**LGPD:** como a equipe ClinPay pode acessar dados de saúde das clínicas, a ClinPay atua como *operadora* dos dados. Formalize isso no contrato com cada clínica e dê acesso de administrador apenas a quem faz suporte.

## Agenda: consultas e cirurgias

- **Consulta:** médico, data, horário e motivo. Sala é opcional. Não exige termos nem checklist.
- **Cirurgia:** exige sala, lateralidade e anestesia; só começa com os termos assinados e o checklist de Entrada; só termina com Pausa e Saída concluídas.
- Situações: agendada, confirmada, em atendimento, concluída, adiada, cancelada e **paciente faltou**.
- Conflitos de horário são verificados por médico, paciente e sala (com tempo de limpeza quando envolve cirurgia).


## Agenda inteligente

- Cada médico tem o seu **expediente** (dias e horários), em "Salas e equipe". Sem expediente definido, vale segunda a sexta, 8h–12h e 13h–18h.
- No agendamento, **"Sugerir horários livres"** mostra os próximos horários sem conflito de médico, sala e paciente.
- Todo agendamento ganha um **link de confirmação** (`/confirmar.html?t=...`), enviado nos lembretes. O paciente confirma ou cancela pelo celular, sem login; o link não mostra nenhum dado clínico. O cancelamento pelo link cancela a cobrança sem pagamento e avisa a equipe.
- Defina `PUBLIC_URL` com o endereço público do sistema (ex.: `https://app.clinpay.com.br`) para os links funcionarem fora da clínica.

## WhatsApp

- **Automático:** usa a API oficial do WhatsApp Business (Meta). Configure em "Mensagens e lembretes": ID do número, token permanente e o nome de um **modelo aprovado** com 5 variáveis (nome, data, horário, clínica, link). Os lembretes saem para pacientes que autorizaram no cadastro e têm celular com DDD.
- **Manual (sem configurar nada):** o botão "Lembrete por WhatsApp" em cada consulta abre o WhatsApp com a mensagem e o link de confirmação já escritos.

## Prontuário eletrônico

- **Evolução clínica:** registros não podem ser editados nem apagados; correções são feitas por "Adendo", ligado ao registro original.
- **Anamnese:** formulário preenchido e **assinado eletronicamente** pelo paciente.
- **Odontograma:** situação de cada dente (numeração FDI, permanentes e decíduos), com histórico.
- **Exames:** o médico lança o resultado e anexa arquivos; o paciente só vê depois que o médico **libera**. A observação interna nunca aparece para o paciente.
- **Imagens:** fotos clínicas, radiografias e PDFs (PNG, JPG, WEBP ou PDF, até 8 MB). O sistema confere o conteúdo real do arquivo, não só a extensão.
- Toda consulta ao prontuário fica registrada na auditoria.

## Portal do paciente

Na ficha do paciente, aba "Portal do paciente", crie o acesso (e-mail e senha). O paciente entra pelo mesmo endereço do sistema e vê apenas os próprios exames liberados e as próprias consultas.

## CRM e vendas

- **Funil:** oportunidades do primeiro contato até o fechamento (novo, em conversa, avaliação, orçamento enviado, ganho, perdido). Arraste os cartões entre as etapas. Perda exige motivo.
- **Orçamentos:** itens do catálogo (com dente, quantidade e valor), desconto, validade, forma de pagamento e parcelas. Ao aprovar, a cobrança é criada no Financeiro e a oportunidade vira "ganho".

## Indicadores

Faturamento recebido, ticket médio, atendimentos, pacientes novos, taxa de faltas e de cancelamento, conversão de orçamentos, valores em atraso, faturamento por dia, por forma de pagamento e por médico, funil de vendas e **meta do mês** (definida pelo médico responsável, da clínica e por médico). A tela se atualiza sozinha a cada minuto.

## Procedimentos

- Toda clínica nova já começa com o **catálogo odontológico** (146 procedimentos em 17 especialidades: consultas, radiologia, prevenção, dentística, endodontia, periodontia, cirurgia oral, implantodontia, prótese, ortodontia, odontopediatria, estética, harmonização orofacial, DTM, estomatologia e sedação), com duração sugerida e tipo (consulta ou cirurgia).
- Eles vêm **sem preço e sem código TUSS**: defina os preços em "Salas e equipe → Procedimentos". Se atender convênio, importe a tabela TUSS oficial (ANS) por planilha CSV (colunas: nome, codigo, preco, duracao, especialidade).
- No agendamento, a lista vem agrupada por especialidade, com busca. Ao escolher o procedimento, o sistema preenche duração, preço e tipo.

## Assistente de IA

- Usa o **Claude (Anthropic)** pela API oficial. Para liberar na plataforma, defina a variável `ANTHROPIC_API_KEY` com a sua chave (criada em console.anthropic.com) antes de iniciar o servidor. Opcional: `AI_MODEL` (padrão `claude-sonnet-5-5`).
- Cada clínica ativa em "Integrações", com **limite diário de perguntas** (para controlar o custo, que é cobrado na sua conta da Anthropic).
- Contextos: conversa geral (sem dados de pacientes), **indicadores** (números da clínica, botão "Analisar com IA") e **prontuário** (resumo do paciente). O prontuário fica **bloqueado por padrão**; o médico responsável só libera aceitando um termo de LGPD. Mesmo liberado, nunca são enviados nome, CPF, telefone, e-mail ou endereço.
- A IA não faz diagnóstico nem prescrição. Todo uso fica na auditoria.

## DRE gerencial

Menu **DRE gerencial**. Mostra o resultado pelo plano de contas, a partir do que foi **efetivamente recebido e pago** (regime de caixa, na data do pagamento). Cobranças em aberto, contas ainda não pagas, despesas canceladas e pagamentos estornados não entram.

| Conta | Origem dos valores |
|---|---|
| 1 Receita bruta de serviços | Recebimentos, por especialidade do procedimento (orçamentos são divididos pelo valor de cada item, sem perder centavos) |
| 1.99 Outras receitas | Cobranças avulsas e procedimentos sem especialidade |
| 2 (−) Deduções | Despesas "Impostos e taxas" e "Taxas de cartão e bancárias" |
| = Receita líquida | |
| 3 (−) Custos dos serviços | Laboratório, materiais, esterilização, comissões |
| = Lucro bruto | |
| 4 (−) Despesas operacionais | Pessoal, ocupação (aluguel, contas, manutenção), administrativas (software, contabilidade, outras) e comerciais (marketing) |
| = Resultado operacional | |
| 5 (−) Investimentos | Equipamentos |
| = Resultado do período | Geração de caixa |

- **Visões:** "Período", comparado ao período anterior de mesma duração (com variação %), e "Mês a mês do ano", com a coluna Total.
- **Análise vertical:** cada linha como % da receita bruta.
- **Exportar para Excel** (CSV com vírgula decimal) e **Imprimir**.
- Médico e funcionário veem só o próprio resultado; despesas gerais da clínica (sem médico) ficam de fora desse filtro.
- Para o DRE ficar completo, **registre todas as despesas pagas** no Financeiro, com a categoria certa.
- Este é um DRE **gerencial**, para decisão. O DRE contábil oficial (regime de competência) é feito pela contabilidade.

## Financeiro

- **Despesas (contas a pagar):** aluguel, laboratório de prótese, materiais, salários, impostos e outras. Podem ser da clínica ou ligadas a um médico. Com elas, o sistema calcula o **lucro** (recebido − despesas pagas) e a margem.

- Ao agendar, informe o **valor** e a **forma de cobrança** (PIX, dinheiro, cartão de crédito com parcelas, débito, boleto, transferência, convênio). A cobrança é criada automaticamente no Financeiro.
- O valor sugerido vem do preço do procedimento ou do valor de consulta do médico.
- Na hora de receber, clique em **Receber**: dá para receber em partes e por formas diferentes.
- Cancelar um atendimento cancela a cobrança, se nada tiver sido pago. Paciente que faltou: a cobrança continua em aberto.
- Pagamentos não são apagados: o médico responsável pode **estornar**, com motivo, e o estorno fica registrado.
- O painel mostra o recebido no período, o que falta receber, o que está em atraso e o recebido por forma de pagamento e por médico.
- Todos os valores são guardados em centavos, para não haver erro de arredondamento.

**Integração bancária (próxima etapa):** o Financeiro já está organizado em cobranças (`charges`) com pagamentos. A integração com o seu sistema bancário pode criar cobranças (PIX/boleto) a partir delas e registrar pagamentos automaticamente quando o banco confirmar, com uma rota protegida para o seu sistema chamar.

## Avisos e lembretes por e-mail

Cada clínica configura o próprio envio em **E-mails e lembretes** (menu do médico responsável): servidor SMTP, usuário, senha, remetente, endereço e telefone da clínica. Envie um e-mail de teste e marque "Ativar o envio".

- **Gmail:** servidor `smtp.gmail.com`, porta 465, segurança SSL. É preciso uma *senha de app* (myaccount.google.com/apppasswords, exige verificação em duas etapas). Contas gratuitas enviam cerca de 500 e-mails por dia.
- **Outros provedores:** use os dados SMTP do provedor. Porta 465 normalmente usa SSL; porta 587, STARTTLS.

O que é enviado:

| Evento | Quando |
|---|---|
| Agendamento | Na hora em que a cirurgia é marcada |
| Alteração | Quando muda data, horário ou sala, ou quando uma cirurgia adiada é reagendada |
| Adiamento e cancelamento | Na hora (o motivo interno não é enviado ao paciente) |
| Lembretes | Antes da cirurgia, nos horários configurados (padrão: 3 dias e 1 dia antes) |

Quem recebe: pacientes com e-mail e com a autorização marcada no cadastro, e profissionais da equipe da cirurgia com e-mail e a opção "Receber por e-mail" marcada. Sem autorização, ninguém recebe.

Por proteção de dados (LGPD), o e-mail do paciente não mostra o nome do procedimento, a não ser que o administrador ative essa opção. As "orientações pré-operatórias" da cirurgia são enviadas ao paciente.

Se o envio falhar, o sistema tenta de novo até 5 vezes e mostra o erro no histórico. Os lembretes só saem se o servidor estiver ligado; se ele ficar desligado, ao voltar envia o lembrete mais próximo que ainda faz sentido (nunca depois do horário da cirurgia). O relógio do computador servidor precisa estar no horário certo.

A configuração e a fila de e-mails também ficam no armazenamento em memória até a integração com o banco (coleções `settings` e `emails`).

## Configurações (variáveis de ambiente)

| Variável | Padrão | Para que serve |
|---|---|---|
| PORT | 3000 | Porta do servidor |
| DATABASE_URL | (vazio) | Endereço do PostgreSQL. Vazio = salva em arquivo local |
| DATA_FILE | dados/clinpay-dados.jsonl | Arquivo de dados quando não há DATABASE_URL |
| CRON_SECRET | (vazio) | Chave do "despertador" dos lembretes (/api/cron) |
| ANTHROPIC_API_KEY | (vazio) | Chave da API da Anthropic para o assistente de IA |
| AI_MODEL | claude-sonnet-5-5 | Modelo do Claude usado pelo assistente |
| PUBLIC_URL | http://localhost:3000 | Endereço público usado nos links de confirmação |
| CLINIC_NAME | ClinPay | Nome da plataforma (cada clínica tem o próprio nome no cadastro) |
| ROOM_TURNOVER_MIN | 30 | Minutos de limpeza entre cirurgias na mesma sala |
| SESSION_IDLE_MIN | 60 | Minutos sem uso até pedir login de novo |
| SESSION_TTL_MIN | 720 | Duração máxima de uma sessão |
| COOKIE_SECURE | (vazio) | Use 1 quando o sistema estiver em HTTPS |
| TRUST_PROXY | (vazio) | Use 1 se estiver atrás de nginx ou outro proxy |
| LOGIN_MAX_ATTEMPTS | 5 | Tentativas erradas antes de bloquear |
| LOGIN_LOCK_MIN | 15 | Minutos de bloqueio após tentativas erradas |

## Onde os dados ficam salvos

- **No seu computador:** em `dados/clinpay-dados.jsonl`, dentro da pasta do sistema. Os dados **não se perdem mais** ao fechar a janela. Esse arquivo contém dados de saúde: proteja o computador com senha e faça cópia de segurança dele.
- **No ar:** com a variável `DATABASE_URL`, os dados ficam no PostgreSQL (ex.: Neon). Veja o passo a passo em **COLOCAR-NO-AR.md**.
- As sessões de login também ficam salvas, então ninguém precisa entrar de novo depois de um reinício.
- O sistema foi feito para **um servidor por vez**.

## Antes de usar com pacientes

1. Publicar com banco de dados (veja COLOCAR-NO-AR.md) e configurar backup automático.
2. Publicar com HTTPS e usar `COOKIE_SECURE=1`.
3. Revisar os textos dos termos com o responsável técnico e o jurídico de cada clínica.
4. Formalizar no contrato com as clínicas o papel da ClinPay no tratamento dos dados (LGPD).
5. Testar o fluxo completo com uma clínica piloto.

A assinatura do sistema é uma assinatura eletrônica com trilha de auditoria (Lei 14.063/2020). Documentos que exigem certificado ICP-Brasil precisam de integração com um provedor de certificado.

## Estrutura

```
server.js                  inicia o servidor
src/tenant.js              separação de dados entre clínicas
src/auth.js                login, senhas, sessões e perfis
src/routes/api.js          rotas da clínica (agenda, pacientes, usuários, termos, e-mails)
src/routes/finance.js      rotas do financeiro
src/routes/platform.js     painel ClinPay (clínicas e administradores)
src/routes/records.js      prontuário, exames, imagens, odontograma e portal do paciente
src/routes/schedule.js     agenda inteligente e link de confirmação
src/routes/crm.js          funil de vendas e orçamentos
src/routes/analytics.js    indicadores e metas
src/routes/dre.js          DRE gerencial e plano de contas
src/domain/revenue.js      rateio exato da receita por procedimento
src/whatsapp.js            envio pelo WhatsApp Business (Meta)
src/ai.js / routes/ai.js   assistente de IA (Claude, Anthropic)
src/domain/procedures-catalog.js  catálogo padrão de procedimentos
src/domain/surgeries.js    regras de agenda, status, termos e checklist
src/domain/finance.js      regras de cobrança e pagamento
src/notifications.js       avisos e lembretes por e-mail
src/mail/smtp.js           envio de e-mail (SMTP)
src/store/memoryStore.js   armazenamento em memória (usado nos testes)
src/store/persistentStore.js  salvamento em arquivo local ou PostgreSQL
public/                    interface (HTML, CSS, JS, logo, modo claro/escuro, página de confirmação)
test/                      testes automáticos
```
