# 🔄 Pipeline de Sincronização Bling ERP ➔ Supabase

Este projeto consiste em uma integração automatizada entre o **Bling ERP (API v3)** e o **Supabase (PostgreSQL)** escrita em **Node.js**. O script extrai registros de Produtos, Estoques, Vendas e Propostas Comerciais do Bling e os sincroniza com o banco de dados Supabase utilizando o padrão de atualização *Upsert*.

---

## 🛠️ Tecnologias Utilizadas

- **[Node.js](https://nodejs.org/):** Ambiente de execução JavaScript no servidor.
- **[Axios](https://axios-http.com/):** Cliente HTTP baseado em promessas para consumir as APIs do Bling.
- **[@supabase/supabase-js](https://supabase.com/docs/reference/javascript/introduction):** SDK oficial para integração com o banco de dados e serviços do Supabase.
- **[dotenv](https://github.com/motdotla/dotenv):** Gerenciador de variáveis de ambiente a partir de arquivos `.env`.

---

## 🔒 Segurança & Boas Práticas

### 1. Proteção de Credenciais (`.env`)
Chaves de API, senhas do banco de dados e tokens de acesso **nunca devem ser enviados para o Git**. O projeto utiliza o arquivo `.gitignore` para ignorar o `.env` e a pasta `node_modules`.

### 2. Tratamento de Tokens de Acesso OAuth 2.0
A API v3 do Bling exige autenticação via OAuth 2.0. A cada execução, o script renova o `access_token` a partir do `refresh_token` e atualiza automaticamente o novo `refresh_token` no arquivo `.env` local para garantir execuções futuras sem intervenção manual.

### 3. Remoção de arquivos sensíveis do rastreamento Git
Caso arquivos como `.env` ou a pasta `node_modules` tenham sido adicionados ao histórico do Git anteriormente, remova-os executando:

git rm -r --cached node_modules
git rm --cached .env
git commit -m "fix: remove arquivos sensiveis e dependencias do Git"
git push origin main
```

---

## 📋 Pré-requisitos e Configuração no Supabase

Antes de executar o script, certifique-se de atualizar a estrutura da tabela `vendas` no Supabase via **SQL Editor**:

```sql
CREATE TABLE IF NOT EXISTS vendas (
  id BIGINT PRIMARY KEY,
  numero VARCHAR(255),
  data DATE,
  valor NUMERIC(10, 2),
  situacao VARCHAR(50),
  id_contato BIGINT,
  id_loja BIGINT,
  id_vendedor BIGINT,
  id_unidade_negocio BIGINT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

---

## ⚙️ Variáveis de Ambiente (`.env`)

Crie um arquivo chamado `.env` na raiz do projeto contendo a seguinte estrutura:

```env
# Configurações do Supabase
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_KEY=sua-chave-anon-ou-service-role

# Autenticação Bling API v3
BLING_CLIENT_ID=seu_client_id
BLING_CLIENT_SECRET=seu_client_secret
BLING_REFRESH_TOKEN=seu_refresh_token_inicial
```

---

## 🚀 Como Executar o Projeto

1. **Clone o repositório:**
   git clone https://github.com/seu-usuario/seu-repositorio.git
   cd seu-repositorio
   

2. **Instale as dependências:**
   npm install
   

3. **Configure o arquivo `.env`** conforme indicado acima.

4. **Execute o script de sincronização:**
   node index.js
  

---

## 📡 Endpoints do Bling Utilizados

O script consome a **API v3 do Bling** (`https://www.bling.com.br/Api/v3/`):

| Recurso | Endpoint Bling | Descrição / Método |
| :--- | :--- | :--- |
| **OAuth 2.0** | `POST /oauth/token` | Renova o Access Token e atualiza o Refresh Token no `.env`. |
| **Produtos** | `GET /produtos` | Traz a lista paginada de produtos cadastrados. |
| **Estoques** | `GET /estoques/saldos` | Traz o saldo físico e virtual dos produtos. |
| **Vendas (Lista)** | `GET /pedidos/vendas` | Traz a lista paginada com resumo dos pedidos de venda. |
| **Vendas (Detalhes)** | `GET /pedidos/vendas/{id}` | Traz detalhes do pedido (`id_vendedor`, `id_unidade_negocio`, `id_loja`, `id_contato`). |
| **Propostas** | `GET /orcamentos` | Traz a lista paginada de propostas comerciais / orçamentos. |

---

## 🔄 Funcionamento da Sincronização (Upsert)

O script utiliza a operação **Upsert** (`supabase.from(tabela).upsert(dados, { onConflict: 'id' })`):
- **Registro existente:** Se o `id` já constar na tabela, ele atualiza os dados para a versão mais recente trazida do Bling.
- **Novo registro:** Se o `id` for inédito, ele insere a nova linha no Supabase.
- **Segurança:** Nenhum registro antigo é deletado ao executar a sincronização.