require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Atualiza o arquivo .env com o novo Refresh Token
 */
function updateEnvRefreshToken(newToken) {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    let envContent = fs.readFileSync(envPath, 'utf8');

    const updatedContent = envContent.replace(
      /BLING_REFRESH_TOKEN=.*/,
      `BLING_REFRESH_TOKEN=${newToken}`
    );

    fs.writeFileSync(envPath, updatedContent, 'utf8');
    process.env.BLING_REFRESH_TOKEN = newToken;
    console.log('🔄 Arquivo .env atualizado com o NOVO Refresh Token!');
  } catch (err) {
    console.error('⚠️ Não foi possível salvar o novo refresh token no .env:', err.message);
  }
}

/**
 * 1. Renova o Access Token do Bling
 */
async function getAccessToken() {
  try {
    const credentials = Buffer.from(
      `${process.env.BLING_CLIENT_ID}:${process.env.BLING_CLIENT_SECRET}`
    ).toString('base64');

    const response = await axios.post(
      'https://www.bling.com.br/Api/v3/oauth/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: process.env.BLING_REFRESH_TOKEN,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${credentials}`,
        },
      }
    );

    if (response.data.refresh_token) {
      updateEnvRefreshToken(response.data.refresh_token);
    }

    console.log('✅ Token do Bling renovado com sucesso!');
    return response.data.access_token;
  } catch (error) {
    console.error('❌ Erro ao renovar token do Bling:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * 2. Função genérica de paginação para qualquer endpoint do Bling
 */
async function fetchPaginatedData(accessToken, endpoint, nomeRecurso) {
  let pagina = 1;
  let todosItens = [];
  let temMaisPaginas = true;

  console.log(`📦 Buscando ${nomeRecurso} do Bling...`);

  while (temMaisPaginas) {
    try {
      const response = await axios.get(`https://www.bling.com.br/Api/v3/${endpoint}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        params: {
          limite: 100,
          pagina: pagina,
        },
      });

      const itensPagina = response.data.data || [];

      if (itensPagina.length > 0) {
        todosItens = todosItens.concat(itensPagina);
        pagina++;
      } else {
        temMaisPaginas = false;
      }
    } catch (error) {
      console.error(`❌ Erro ao buscar ${nomeRecurso} (página ${pagina}):`, error.response?.data || error.message);
      temMaisPaginas = false;
    }
  }

  console.log(`🎯 ${nomeRecurso}: ${todosItens.length} registros encontrados.`);
  return todosItens;
}

/**
 * Sincronização de Produtos
 */
async function sincronizarProdutos(token) {
  const dados = await fetchPaginatedData(token, 'produtos', 'Produtos');
  if (!dados.length) return;

  const formatados = dados.map((item) => ({
    id: item.id,
    nome: item.nome,
    codigo: item.codigo,
    preco: item.preco,
    situacao: item.situacao,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase.from('produtos').upsert(formatados, { onConflict: 'id' });
  if (error) console.error('❌ Erro ao salvar produtos:', error);
  else console.log(`🚀 Produtos sincronizados com sucesso!`);
}

/**
 * Sincronização de Estoques
 */
async function sincronizarEstoques(token) {
  const dados = await fetchPaginatedData(token, 'estoques/saldos', 'Estoques');
  if (!dados.length) return;

  const formatados = dados.map((item, index) => ({
    id: item.produto?.id || index,
    produto_id: item.produto?.id,
    saldo_fisico: item.saldoFisico,
    saldo_virtual: item.saldoVirtual,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase.from('estoques').upsert(formatados, { onConflict: 'id' });
  if (error) console.error('❌ Erro ao salvar estoques:', error);
  else console.log(`🚀 Estoques sincronizados com sucesso!`);
}

/**
 * Sincronização de Vendas (Pedidos de Venda detalhados)
 */
async function sincronizarVendas(token) {
  const resumoVendas = await fetchPaginatedData(token, 'pedidos/vendas', 'Vendas');
  if (!resumoVendas.length) return;

  console.log(`🔎 Buscando detalhes individuais de ${resumoVendas.length} vendas...`);
  
  const formatados = [];

  for (const itemResumo of resumoVendas) {
    try {
      // Busca os detalhes completos de cada pedido
      const responseDetalhe = await axios.get(
        `https://www.bling.com.br/Api/v3/pedidos/vendas/${itemResumo.id}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      const item = responseDetalhe.data.data;

      formatados.push({
        id: item.id,
        numero: String(item.numero),
        data: item.data,
        valor: item.total || item.valor,
        situacao: item.situacao?.id || item.situacao,
        id_contato: item.contato?.id || null,
        id_loja: item.loja?.id || null,
        id_vendedor: item.vendedor?.id || null,
        id_unidade_negocio: item.unidadeNegocio?.id || null,
        updated_at: new Date().toISOString(),
      });

      // Pequena pausa (100ms) para não estourar o limite de requisições por segundo do Bling
      await new Promise((resolve) => setTimeout(resolve, 100));

    } catch (error) {
      console.error(
        `⚠️ Erro ao buscar detalhe da venda ${itemResumo.id}:`,
        error.response?.data || error.message
      );
    }
  }

  if (formatados.length > 0) {
    const { error } = await supabase.from('vendas').upsert(formatados, { onConflict: 'id' });
    if (error) console.error('❌ Erro ao salvar vendas:', error);
    else console.log(`🚀 ${formatados.length} vendas (com detalhes) sincronizadas com sucesso!`);
  }
}

/**
 * Fluxo Principal
 */
async function main() {
  try {
    console.log('🔄 Iniciando pipeline completo Bling -> Supabase...');
    const token = await getAccessToken();

    await sincronizarProdutos(token);
    await sincronizarEstoques(token);
    await sincronizarVendas(token);
    await sincronizarPropostas(token);

    console.log('✨ Pipeline executado de ponta a ponta com sucesso!');
  } catch (error) {
    console.error('💥 Falha na execução geral:', error.message);
  }
}

main();