# Como colocar o ClinPay no ar (gratuito)

Serviços usados (planos gratuitos, conferidos em novembro de 2026):

- **GitHub**: guarda o código.
- **Neon**: banco de dados PostgreSQL. Gratuito e permanente, sem cartão (cerca de 0,5 a 1 GB por projeto).
- **Render**: hospeda o site, com endereço https grátis.
- **cron-job.org** (opcional): "despertador" para os lembretes saírem no horário.

Limites do plano gratuito do Render: o site "dorme" após 15 minutos sem acesso e leva cerca de 1 minuto para acordar. O despertador do passo 5 resolve isso.

## 1. Banco de dados (Neon)

1. Crie uma conta em https://neon.com.
2. Crie um projeto com nome `clinpay` e Postgres 16 ou mais recente. Na região, escolha **AWS US East (Virgínia)**, para ficar perto do Render.
3. Na tela do projeto, clique em **Connect** e copie a **connection string** (começa com `postgresql://` e termina com `sslmode=require`). Guarde-a: é a senha do seu banco.

O ClinPay cria a tabela sozinho na primeira vez que liga.

## 2. Código no GitHub

1. Crie uma conta em https://github.com.
2. Clique em **New repository** e dê o nome `clinpay`. Marque **Private** (importante) e clique em **Create repository**.
3. Na página do repositório, clique em **uploading an existing file**.
4. Abra a pasta `C:\clinpay`, selecione tudo **menos** a pasta `dados` e arraste para o navegador. Se aparecer uma pasta `node_modules`, ela também fica de fora.
5. Clique em **Commit changes**.

## 3. Site no Render

1. Crie uma conta em https://render.com, entrando com a sua conta do GitHub.
2. Clique em **New +** → **Web Service** e escolha o repositório `clinpay`.
3. Preencha:
   - **Region**: Virginia (US East)
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: **Free**
4. Em **Environment Variables**, adicione:

| Nome | Valor |
|---|---|
| `DATABASE_URL` | a connection string do Neon (passo 1) |
| `COOKIE_SECURE` | `1` |
| `TRUST_PROXY` | `1` |
| `NODE_VERSION` | `22` |
| `CRON_SECRET` | uma senha longa inventada por você (mínimo 16 caracteres, só letras e números) |
| `PUBLIC_URL` | deixe para depois (passo 4) |
| `ANTHROPIC_API_KEY` | opcional: a chave da IA |

5. Em **Advanced** → **Health Check Path**, coloque `/api/health`.
6. Clique em **Create Web Service** e aguarde de 2 a 5 minutos. Quando aparecer **Live**, o site está no ar.

## 4. Endereço público

1. No topo da página do serviço aparece o endereço, por exemplo `https://clinpay-abcd.onrender.com`.
2. Vá em **Environment**, adicione `PUBLIC_URL` com esse endereço (sem barra no final) e salve. O Render reinicia sozinho.
3. Abra o endereço: vai aparecer **Primeiro acesso**. Crie a sua conta de administrador ClinPay.

## 5. Despertador dos lembretes (recomendado)

Sem isso, os lembretes de e-mail e WhatsApp só saem quando alguém está usando o site.

1. Crie uma conta gratuita em https://cron-job.org.
2. Clique em **Create cronjob**.
3. Em **URL**, coloque: `https://SEU-ENDERECO.onrender.com/api/cron?key=SUA-CRON_SECRET`
4. Escolha **a cada 10 minutos** e salve.

Isso também mantém o site acordado. Um site acordado o mês todo usa cerca de 744 das 750 horas gratuitas do Render: dá para **um** site no plano gratuito.

## Atualizar o site depois

No GitHub, envie os arquivos novos (Add file → Upload files) e confirme. O Render publica sozinho em poucos minutos. Os dados ficam no Neon e não são afetados.

## Antes de usar com pacientes de verdade

O plano gratuito serve para **demonstração e piloto**. Para clínicas reais, com dados de saúde:

- **Backups:** confira no painel do Neon por quantos dias o plano permite restaurar dados. Faça também cópias periódicas.
- **Hospedagem:** passe o Render para um plano pago (sem "dormir") e o Neon para um plano com mais histórico de restauração.
- **LGPD:** os dados ficam em servidores nos EUA, o que é uma transferência internacional de dados. Formalize isso no contrato com as clínicas.
- **Espaço:** fotos e radiografias ocupam espaço rápido no banco gratuito.
- **Um servidor por vez:** o ClinPay foi feito para rodar em uma única instância. Não aumente o número de instâncias no Render.
