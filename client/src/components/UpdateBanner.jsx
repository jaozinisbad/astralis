import React, { useEffect, useRef, useState } from 'react';

const ESTADOS_OCUPADOS = ['checking', 'downloading', 'installing'];
const ACOES = {
  check: { metodo: 'verificarAtualizacao', label: 'Verificar novamente', pending: 'Verificando…', erro: 'Não foi possível verificar as atualizações.' },
  download: { metodo: 'baixarAtualizacao', label: 'Baixar atualização', pending: 'Iniciando download…', erro: 'Não foi possível iniciar o download.' },
  install: { metodo: 'reiniciarParaAtualizar', label: 'Reiniciar e instalar', pending: 'Preparando reinício…', erro: 'Não foi possível reiniciar para instalar.' },
};

export default function UpdateBanner() {
  const [estado, setEstado] = useState(null);
  const [acaoPendente, setAcaoPendente] = useState(null);
  const versaoEstadoRef = useRef(0);
  const pedidoRef = useRef(null);
  const montadoRef = useRef(false);

  function receberEstado(novoEstado) {
    if (!montadoRef.current || !novoEstado?.status) return;
    versaoEstadoRef.current += 1;
    setEstado(novoEstado);
    if (!ESTADOS_OCUPADOS.includes(novoEstado.status)) {
      pedidoRef.current = null;
      setAcaoPendente(null);
    }
  }

  useEffect(() => {
    const api = globalThis.window?.electronAPI;
    if (!api?.onAtualizacaoStatus) return undefined;
    montadoRef.current = true;
    let removerListener;
    let ativo = true;
    const versaoAntesDoRetrato = versaoEstadoRef.current;

    try {
      // Registre primeiro: um evento mais novo sempre vence um retrato atrasado.
      removerListener = api.onAtualizacaoStatus((novoEstado) => {
        if (ativo) receberEstado(novoEstado);
      });
      Promise.resolve(api.obterStatusAtualizacao?.())
        .then((retrato) => {
          if (ativo && versaoEstadoRef.current === versaoAntesDoRetrato) receberEstado(retrato);
        })
        .catch((erro) => {
          if (ativo && versaoEstadoRef.current === versaoAntesDoRetrato) {
            receberEstado({ status: 'error', retryAction: 'check', message: 'Não foi possível consultar as atualizações.', detail: erro?.message });
          }
        });
    } catch (erro) {
      receberEstado({ status: 'error', retryAction: 'check', message: 'Não foi possível consultar as atualizações.', detail: erro?.message });
    }

    return () => {
      ativo = false;
      montadoRef.current = false;
      removerListener?.();
    };
  }, []);

  async function executarAcao(acao) {
    if (pedidoRef.current || ESTADOS_OCUPADOS.includes(estado?.status)) return;
    const configuracao = ACOES[acao];
    if (!configuracao) return;
    const pedido = {};
    pedidoRef.current = pedido;
    setAcaoPendente(acao);
    const versaoAntesDaAcao = versaoEstadoRef.current;

    try {
      const api = globalThis.window?.electronAPI;
      if (typeof api?.[configuracao.metodo] !== 'function') {
        throw new Error('O controle de atualização não está disponível. Abra o aplicativo novamente e tente de novo.');
      }
      // Download e instalação só são invocados por este clique.
      const resposta = await api[configuracao.metodo]();
      if (versaoEstadoRef.current === versaoAntesDaAcao) receberEstado(resposta);
    } catch (erro) {
      // Um evento final mais novo pode concluir este pedido antes da rejeição IPC.
      if (pedidoRef.current === pedido) {
        receberEstado({ status: 'error', retryAction: acao, message: configuracao.erro, detail: erro?.message });
      }
    } finally {
      // Uma resposta antiga não pode liberar um segundo pedido em andamento.
      if (pedidoRef.current === pedido) {
        pedidoRef.current = null;
        if (montadoRef.current) setAcaoPendente(null);
      }
    }
  }

  if (!estado || ['idle', 'not-available'].includes(estado.status)) return null;

  const erro = estado.status === 'error';
  const baixando = estado.status === 'downloading';
  const pronto = estado.status === 'downloaded';
  const ocupado = !!acaoPendente || ESTADOS_OCUPADOS.includes(estado.status);
  const acao = estado.status === 'available' ? 'download'
    : pronto ? 'install'
      : erro ? (ACOES[estado.retryAction] ? estado.retryAction : 'check') : null;
  const percent = typeof estado.percent === 'number' && Number.isFinite(estado.percent)
    ? Math.min(100, Math.max(0, Math.round(estado.percent))) : null;
  const titulo = {
    available: 'Nova atualização disponível',
    checking: 'Verificando atualizações',
    downloading: 'Baixando atualização',
    downloaded: 'Atualização pronta',
    installing: 'Preparando a instalação',
    error: 'Não foi possível atualizar',
  }[estado.status];

  if (!titulo) return null;

  return (
    <aside className={'atualizacao-banner' + (erro ? ' atualizacao-banner--erro' : '')} aria-label="Atualização do Astralis">
      <div className="atualizacao-banner__content">
        <div role={erro ? 'alert' : 'status'} aria-live={erro ? 'assertive' : 'polite'} aria-atomic="true">
          <div className="atualizacao-banner__heading">
            <h2>{titulo}</h2>
            {estado.version && <span className="atualizacao-banner__version">v{estado.version}</span>}
          </div>
          {estado.message && <p className="atualizacao-banner__message">{estado.message}</p>}
        </div>
        {baixando && (
          <div className="atualizacao-banner__progress">
            <progress max="100" value={percent ?? undefined} aria-label="Progresso do download" />
            <span>{percent === null ? 'Aguardando progresso…' : percent + '%'}</span>
          </div>
        )}
        {['available', 'downloading', 'downloaded'].includes(estado.status) && (
          <p className="atualizacao-banner__hint">
            {pronto ? 'Reiniciar encerra chamadas e transmissões. ' : 'Você pode continuar usando o Astralis. '}
            Fechar o app não instala a atualização.
          </p>
        )}
        {erro && estado.detail && estado.detail !== estado.message && (
          <details className="atualizacao-banner__details">
            <summary>Detalhes do erro</summary>
            <p>{estado.detail}</p>
          </details>
        )}
      </div>
      {acao && (
        <button className="atualizacao-banner__action" type="button" disabled={ocupado} onClick={() => executarAcao(acao)}>
          {acaoPendente ? ACOES[acaoPendente].pending
            : erro && acao === 'download' ? 'Tentar baixar novamente'
              : erro && acao === 'install' ? 'Tentar reiniciar novamente'
                : ACOES[acao].label}
        </button>
      )}
    </aside>
  );
}
