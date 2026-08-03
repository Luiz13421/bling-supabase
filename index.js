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
 * 2. Consulta a última data de atualização no Supabase para sincronização incremental
 */
async function getUltimaAtualizacao(tabela) {
  try {
    const { data, error } = await supabase
      .from(tabela)
      .select('updated_at')
      .order('updated_at', { ascending: false })
      .limit(1);

    // 1. Mostra o valor exato que está dentro do array
    console.log(`🔎 Dados brutos da tabela ${tabela}:`, data[0]);

    // 2. Trava de segurança caso a tabela esteja vazia ou a data seja nula
    if (error || !data || data.length === 0 || !data[0].updated_at) {
      return null;
    }

    // 3. Pega a data no formato YYYY-MM-DD
    const dataFormatada = data[0].updated_at.split('T')[0];
    return dataFormatada;

  } catch (error) {
    console.error(`⚠️ Erro ao buscar última atualização da tabela ${tabela}:`, error.message);
    return null;
  }
}

/**
 * 3. Função genérica de paginação para qualquer endpoint do Bling (agora aceita filtros)
 */
async function fetchPaginatedData(accessToken, endpoint, nomeRecurso, filtrosExtras = {}) {
  let pagina = 1;
  let todosItens = [];
  let temMaisPaginas = true;

  console.log(`📦 Buscando ${nomeRecurso} do Bling... ${filtrosExtras.dataAlteracaoInicial ? `(A partir de: ${filtrosExtras.dataAlteracaoInicial})` : '(Tudo)'}`);

  while (temMaisPaginas) {
    try {
      const response = await axios.get(`https://www.bling.com.br/Api/v3/${endpoint}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        params: {
          limite: 100,
          pagina: pagina,
          ...filtrosExtras, // Adiciona filtros como dataAlteracaoInicial aqui
        },
      });

      const itensPagina = response.data.data || [];

      if (itensPagina.length > 0) {
        todosItens = todosItens.concat(itensPagina);
        pagina++;
      } else {
        temMaisPaginas = false;
      }

      // ⏱️ Pausa de 350ms para respeitar o limite de 3 req/seg da API do Bling
      await new Promise((resolve) => setTimeout(resolve, 350));

    } catch (error) {
      console.error(`❌ Erro ao buscar ${nomeRecurso} (página ${pagina}):`, JSON.stringify(error.response?.data, null, 2) || error.message);
      temMaisPaginas = false;
    }
  }

  console.log(`🎯 ${nomeRecurso}: ${todosItens.length} registros encontrados.`);
  return todosItens;
}

/* ==========================================================
 * SINCRONIZAÇÕES (CADASTROS BASE - SEM FILTRO DE DATA)
 * ========================================================== */

async function sincronizarSituacoes(token) {
  try {
    console.log('📦 Buscando Módulos de Situações...');
    
    // 1. Busca todos os módulos que possuem situações na sua conta
    const modulosResponse = await axios.get('https://www.bling.com.br/Api/v3/situacoes/modulos', {
      headers: { Authorization: `Bearer ${token}` }
    });

    const modulos = modulosResponse.data.data || [];
    if (!modulos.length) {
      console.log('🎯 Situações: Nenhum módulo encontrado na conta.');
      return;
    }

    let todasSituacoes = [];
    console.log(`🔎 Encontrados ${modulos.length} módulos. Baixando situações de cada um...`);

    // 2. Loop passando por cada módulo (Vendas, NFe, OS, etc.) para pegar suas situações
    for (const modulo of modulos) {
      try {
        const response = await axios.get(`https://www.bling.com.br/Api/v3/situacoes/modulos/${modulo.id}`, {
          headers: { Authorization: `Bearer ${token}` }
        });

        const situacoes = response.data.data || [];
        
        const formatados = situacoes.map((item) => ({
          id: item.id,
          nome: item.nome,
          id_herdado: item.idHerdado || 0,
          cor: item.cor || null,
          raw_data: { ...item, nome_modulo: modulo.descricao }, // Guarda o nome do módulo no raw_data para referência
          updated_at: new Date().toISOString(),
        }));

        todasSituacoes = todasSituacoes.concat(formatados);

        // ⏱️ Respeitar o limite de 3 requisições por segundo
        await new Promise((resolve) => setTimeout(resolve, 350));
      } catch (err) {
        // Se der erro em um módulo específico, avisa e continua os outros
        console.error(`⚠️ Erro ao buscar situações do módulo ${modulo.descricao || modulo.id}:`, err.response?.data?.error?.message || err.message);
      }
    }

    // 3. Salva tudo no banco de dados de uma vez
    if (todasSituacoes.length > 0) {
      const { error } = await supabase.from('bling_situacoes').upsert(todasSituacoes, { onConflict: 'id' });
      if (error) {
        console.error('❌ Erro ao salvar situações:', error);
      } else {
        console.log(`🚀 ${todasSituacoes.length} Situações (de ${modulos.length} módulos) sincronizadas com sucesso!`);
      }
    } else {
      console.log('🎯 Situações: Nenhuma situação individual encontrada dentro dos módulos.');
    }

  } catch (error) {
    console.error(
      '❌ Erro ao buscar a lista de Módulos de Situações:', 
      JSON.stringify(error.response?.data, null, 2) || error.message
    );
  }
}

async function sincronizarCategorias(token) {
  const dados = await fetchPaginatedData(token, 'categorias/receitas-despesas', 'Categorias');
  if (!dados.length) return;

  const formatados = dados.map((item) => ({
    id: item.id,
    descricao: item.descricao,
    id_categoria_pai: item.idCategoriaPai || 0,
    tipo: item.tipo,
    situacao: item.situacao,
    raw_data: item,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase.from('bling_categorias').upsert(formatados, { onConflict: 'id' });
  if (error) console.error('❌ Erro ao salvar categorias:', error);
  else console.log(`🚀 Categorias sincronizadas com sucesso!`);
}

async function sincronizarVendedores(token) {
  const dados = await fetchPaginatedData(token, 'vendedores', 'Vendedores');
  if (!dados.length) return;

  const formatados = dados.map((item) => ({
    id: item.id,
    contato_id: item.contato?.id || null,
    nome: item.contato?.nome || null,
    situacao: item.contato?.situacao || null,
    loja_id: item.loja?.id || null,
    desconto_limite: item.descontoLimite || 0,
    raw_data: item,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase.from('bling_vendedores').upsert(formatados, { onConflict: 'id' });
  if (error) console.error('❌ Erro ao salvar vendedores:', error);
  else console.log(`🚀 Vendedores sincronizados com sucesso!`);
}

async function sincronizarCaixasBancos(token) {
  const dados = await fetchPaginatedData(token, 'contas-contabeis', 'Caixas e Bancos');
  if (!dados.length) return;

  const formatados = dados.map((item) => ({
    id: item.id,
    descricao: item.descricao,
    tipo: item.tipo,
    situacao: item.situacao,
    raw_data: item,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase.from('bling_caixas_bancos').upsert(formatados, { onConflict: 'id' });
  if (error) console.error('❌ Erro ao salvar caixas e bancos:', error);
  else console.log(`🚀 Caixas e Bancos sincronizados com sucesso!`);
}

/* ==========================================================
 * SINCRONIZAÇÕES PESADAS (COM INTELIGÊNCIA DE DATA)
 * ========================================================== */

async function sincronizarContatos(token) {
  const dataUltima = await getUltimaAtualizacao('contatos');
  const hoje = new Date().toISOString().split('T')[0];
  const filtros = dataUltima ? { 
  dataAlteracaoInicial: dataUltima, 
  dataAlteracaoFinal: hoje 
} : {};

  const dados = await fetchPaginatedData(token, 'contatos', 'Contatos', filtros);
  if (!dados.length) return;

  const formatados = dados.map((item) => ({
    id: item.id,
    nome: item.nome,
    codigo: item.codigo || null,
    situacao: item.situacao || null,
    numero_documento: item.numeroDocumento || null,
    telefone: item.telefone || null,
    celular: item.celular || null,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase.from('contatos').upsert(formatados, { onConflict: 'id' });
  if (error) console.error('❌ Erro ao salvar contatos:', error);
  else console.log(`🚀 Contatos sincronizados com sucesso!`);
}

async function sincronizarProdutos(token) {
  const dataUltima = await getUltimaAtualizacao('produtos');
  const hoje = new Date().toISOString().split('T')[0];
  const filtros = dataUltima ? { 
    dataAlteracaoInicial: dataUltima, 
    dataAlteracaoFinal: hoje 
  } : {};

  const dados = await fetchPaginatedData(token, 'produtos', 'Produtos', filtros);
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

/* ==========================================================
 * CONTAS A PAGAR E RECEBER (BUSCA DETALHADA PARA EXTRAIR CATEGORIA)
 * ========================================================== */

async function sincronizarContasPagar(token) {
  const dataUltima = await getUltimaAtualizacao('bling_contas_pagar');
  const hoje = new Date().toISOString().split('T')[0];
  const filtros = dataUltima ? { 
  dataAlteracaoInicial: dataUltima, 
  dataAlteracaoFinal: hoje 
} : {};

  // 1. Busca o resumo para pegar os IDs
  const resumoContas = await fetchPaginatedData(token, 'contas/pagar', 'Contas a Pagar', filtros);
  if (!resumoContas.length) return;

  console.log(`🔎 Buscando detalhes de ${resumoContas.length} contas a pagar (para extrair Categoria)...`);
  
  const formatados = [];

  for (const itemResumo of resumoContas) {
    try {
      // 2. Busca o detalhe da conta
      const responseDetalhe = await axios.get(
        `https://www.bling.com.br/Api/v3/contas/pagar/${itemResumo.id}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const item = responseDetalhe.data.data;

      formatados.push({
        id: item.id,
        situacao_id: item.situacao,
        vencimento: item.vencimento,
        vencimento_original: item.vencimentoOriginal,
        data_emissao: item.dataEmissao,
        valor: item.valor,
        saldo: item.saldo,
        contato_id: item.contato?.id || null,
        forma_pagamento_id: item.formaPagamento?.id || null,
        categoria_id: item.categoria?.id || null, // <- AQUI ESTÁ A CATEGORIA!
        portador_id: item.portador?.id || null,
        competencia: item.competencia || null,
        numero_documento: item.numeroDocumento || null,
        historico: item.historico || null,
        raw_data: item,
        updated_at: new Date().toISOString(),
      });

      // 3. Pausa para respeitar o limite (Rate Limit)
      await new Promise((resolve) => setTimeout(resolve, 350));

    } catch (error) {
      console.error(
        `⚠️ Erro ao buscar detalhe da conta a pagar ${itemResumo.id}:`,
        JSON.stringify(error.response?.data, null, 2) || error.message
      );
    }
  }

  if (formatados.length > 0) {
    const { error } = await supabase.from('bling_contas_pagar').upsert(formatados, { onConflict: 'id' });
    if (error) console.error('❌ Erro ao salvar contas a pagar:', error);
    else console.log(`🚀 ${formatados.length} Contas a Pagar (com categoria) sincronizadas com sucesso!`);
  }
}

async function sincronizarContasReceber(token) {
  const dataUltima = await getUltimaAtualizacao('bling_contas_receber');
  const hoje = new Date().toISOString().split('T')[0];
  const filtros = dataUltima ? { 
    dataAlteracaoInicial: dataUltima, 
    dataAlteracaoFinal: hoje 
  } : {};

  const resumoContas = await fetchPaginatedData(token, 'contas/receber', 'Contas a Receber', filtros);
  if (!resumoContas.length) return;

  console.log(`🔎 Buscando detalhes de ${resumoContas.length} contas a receber (para extrair Categoria)...`);
  
  const formatados = [];

  for (const itemResumo of resumoContas) {
    try {
      const responseDetalhe = await axios.get(
        `https://www.bling.com.br/Api/v3/contas/receber/${itemResumo.id}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const item = responseDetalhe.data.data;

      formatados.push({
        id: item.id,
        situacao_id: item.situacao,
        vencimento: item.vencimento,
        vencimento_original: item.vencimentoOriginal,
        data_emissao: item.dataEmissao,
        valor: item.valor,
        saldo: item.saldo,
        contato_id: item.contato?.id || null,
        contato_nome: item.contato?.nome || null,
        forma_pagamento_id: item.formaPagamento?.id || null,
        categoria_id: item.categoria?.id || null, // <- CATEGORIA GARANTIDA
        vendedor_id: item.vendedor?.id || null,
        origem_id: item.origem?.id || null,
        origem_tipo: item.origem?.tipoOrigem || null,
        raw_data: item,
        updated_at: new Date().toISOString(),
      });

      await new Promise((resolve) => setTimeout(resolve, 350));

    } catch (error) {
      console.error(
        `⚠️ Erro ao buscar detalhe da conta a receber ${itemResumo.id}:`,
        JSON.stringify(error.response?.data, null, 2) || error.message
      );
    }
  }

  if (formatados.length > 0) {
    const { error } = await supabase.from('bling_contas_receber').upsert(formatados, { onConflict: 'id' });
    if (error) console.error('❌ Erro ao salvar contas a receber:', error);
    else console.log(`🚀 ${formatados.length} Contas a Receber (com categoria) sincronizadas com sucesso!`);
  }
}

/* ==========================================================
 * MÓDULO DE ESTOQUE (POR LOTES DE PRODUTOS)
 * ========================================================== */

async function sincronizarEstoques(token) {
  console.log('📦 Consultando IDs de produtos no banco local para buscar estoque...');
  
  // 1. Puxa todos os IDs de produtos que já foram salvos no Supabase
  const { data: produtos, error } = await supabase.from('produtos').select('id');

  if (error || !produtos || produtos.length === 0) {
    console.log('🎯 Estoque ignorado: Nenhum produto encontrado no banco de dados para checar.');
    return;
  }

  const ids = produtos.map(p => p.id);
  const chunkSize = 50; // A API aceita vários IDs por vez. 50 é um número seguro.
  const estoquesFormatados = [];

  console.log(`🔎 Buscando saldos de estoque para ${ids.length} produtos (em lotes de ${chunkSize})...`);

  // 2. Divide os IDs em lotes e faz a requisição
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    
    // Monta a querystring: idsProdutos[]=1&idsProdutos[]=2...
    const queryParams = chunk.map(id => `idsProdutos[]=${id}`).join('&');

    try {
      const response = await axios.get(
        `https://www.bling.com.br/Api/v3/estoques/saldos?${queryParams}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const dados = response.data.data || [];

      for (const item of dados) {
        estoquesFormatados.push({
          id: item.produto?.id, // O ID do produto será a chave primária na tabela de estoque
          produto_id: item.produto?.id,
          saldo_fisico: item.saldoFisico,
          saldo_virtual: item.saldoVirtual,
          updated_at: new Date().toISOString(),
        });
      }

      // Pausa entre os lotes
      await new Promise((resolve) => setTimeout(resolve, 350));

    } catch (err) {
      console.error(
        `⚠️ Erro ao buscar lote de estoque:`, 
        JSON.stringify(err.response?.data, null, 2) || err.message
      );
    }
  }

  // 3. Salva no banco
  if (estoquesFormatados.length > 0) {
    const { error: errUpsert } = await supabase.from('estoques').upsert(estoquesFormatados, { onConflict: 'id' });
    if (errUpsert) console.error('❌ Erro ao salvar estoques:', errUpsert);
    else console.log(`🚀 Saldos de ${estoquesFormatados.length} produtos sincronizados com sucesso!`);
  }
}

async function sincronizarVendas(token) {
  const dataUltima = await getUltimaAtualizacao('vendas');
  const hoje = new Date().toISOString().split('T')[0];
  const filtros = dataUltima ? { 
  dataAlteracaoInicial: dataUltima, 
  dataAlteracaoFinal: hoje 
} : {};


  const resumoVendas = await fetchPaginatedData(token, 'pedidos/vendas', 'Vendas', filtros);
  if (!resumoVendas.length) return;

  console.log(`🔎 Buscando detalhes e PRODUTOS de ${resumoVendas.length} vendas...`);
  
  const vendasFormatadas = [];
  const itensFormatados = []; // Array para guardar os produtos vendidos

  for (const itemResumo of resumoVendas) {
    try {
      // 2. Chama o endpoint da sua imagem para pegar os detalhes completos
      const responseDetalhe = await axios.get(
        `https://www.bling.com.br/Api/v3/pedidos/vendas/${itemResumo.id}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const venda = responseDetalhe.data.data;

      // 3. Formata os dados principais da Venda
      vendasFormatadas.push({
        id: venda.id,
        numero: String(venda.numero),
        data: venda.data,
        valor: venda.total || venda.valor,
        situacao: venda.situacao?.id || venda.situacao,
        id_contato: venda.contato?.id || null,
        id_loja: venda.loja?.id || null,
        id_vendedor: venda.vendedor?.id || null,
        id_unidade_negocio: venda.unidadeNegocio?.id || null,
        updated_at: new Date().toISOString(),
      });

      // 4. Extrai a lista de produtos (itens) de dentro do pedido
      if (venda.itens && venda.itens.length > 0) {
        for (const item of venda.itens) {
          itensFormatados.push({
            id: item.id, // ID exclusivo da linha do item no Bling
            id_venda: venda.id, // Relacionamento com a venda pai
            id_produto: item.produto?.id || null, // Relacionamento com o cadastro de produtos
            codigo: item.codigo,
            descricao: item.descricao,
            quantidade: item.quantidade,
            valor_unitario: item.valor,
            updated_at: new Date().toISOString(),
          });
        }
      }

      // Respeitar o limite de requisições do Bling
      await new Promise((resolve) => setTimeout(resolve, 350));

    } catch (error) {
      console.error(
        `⚠️ Erro ao buscar detalhe da venda ${itemResumo.id}:`,
        JSON.stringify(error.response?.data, null, 2) || error.message
      );
    }
  }

  // 5. Salva as Vendas no Supabase
  if (vendasFormatadas.length > 0) {
    const { error: errVendas } = await supabase.from('vendas').upsert(vendasFormatadas, { onConflict: 'id' });
    if (errVendas) console.error('❌ Erro ao salvar vendas:', errVendas);
    else console.log(`🚀 ${vendasFormatadas.length} vendas sincronizadas com sucesso!`);
  }

  // 6. Salva os Itens das Vendas no Supabase
  if (itensFormatados.length > 0) {
    const { error: errItens } = await supabase.from('itens_venda').upsert(itensFormatados, { onConflict: 'id' });
    if (errItens) console.error('❌ Erro ao salvar itens das vendas:', errItens);
    else console.log(`🚀 ${itensFormatados.length} produtos vendidos sincronizados com sucesso!`);
  }
}

/**
 * Fluxo Principal
 */
async function main() {
  try {
    console.log('🔄 Iniciando pipeline completo Bling -> Supabase...');
    const token = await getAccessToken();

    // 1. Tabelas auxiliares / cadastros base (Sempre puxa tudo, costuma ser leve)
    await sincronizarSituacoes(token);
    await sincronizarCategorias(token);
    await sincronizarVendedores(token);
    await sincronizarCaixasBancos(token);
    
    // 2. Tabelas pesadas (Com filtro inteligente de data)
    await sincronizarContatos(token);
    await sincronizarProdutos(token);
    await sincronizarEstoques(token);
    await sincronizarContasPagar(token);
    await sincronizarContasReceber(token);
    await sincronizarVendas(token);

    console.log('✨ Pipeline executado de ponta a ponta com sucesso!');
  } catch (error) {
    console.error('💥 Falha na execução geral:', error.message);
  }
}

main();