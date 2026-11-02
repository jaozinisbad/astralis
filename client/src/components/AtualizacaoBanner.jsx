import React, { useEffect, useRef, useState } from 'react';
import './AtualizacaoBanner.css';

const estadosVisiveis = new Set(['available', 'downloading', 'downloaded', 'error', 'installing']);

export default function AtualizacaoBanner() {
  const [estado, setEstado] = useState(null);
  const [recolhido, setRecolhido] = useState(false);
  const [acaoPendente, setAcaoPendente] = useState(null);
  const [erroAcao, setErroAcao] = useState(null);
  const montado = useRef(false);
  const estadoRef = useRef(null);
  const acaoRef = useRef(null);
  const receberEstadoRef = useRef(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onAtualizacaoStatus) return undefined;
    montado.current = true;
    let recebeuEvento = false;
    let ativo = true;
    const receberEstado = (proximo, snapshot = false) => {
      if (!ativo || !montado.current || !proximo || typeof proximo.status !== 'string') return;
      const atual = estadoRef.current;
      if (Number.isFinite(proximo.revision) && Number.isFinite(atual?.revision)) {
        if (proximo.revision < atual.revision) return;
      } else if (snapshot && recebeuEvento) {
        return;
      }
      estadoRef.current = proximo;
      setEstado(proximo);
      setErroAcao(null);
    };
    receberEstadoRef.current = receberEstado;
    const removerListener = api.onAtualizacaoStatus((proximo) => {
      recebeuEvento = true;
      receberEstado(proximo);
    });
    Promise.resolve().then(() => api.obterStatusAtualizacao?.())
      .then((proximo) => receberEstado(proximo, true))
      .catch(() => {
        if (ativo && montado.current && !recebeuEvento) {
          setErroAcao({ errorStage: 'check', message: 'Não foi possível consultar a atualização. Tente novamente.' });
        }
      });
    return () => {
      ativo = false;
      montado.current = false;
      receberEstadoRef.current = null;
      removerListener?.();
    };
  }, []);

  async function executarAcao(etapa) {
    if (acaoRef.current) return;
    const api = window.electronAPI;
    const metodo = etapa === 'download' ? api?.baixarAtualizacao
      : etapa === 'install' ? api?.reiniciarParaAtualizar : api?.verificarAtualizacao;
    acaoRef.current = etapa;
    setAcaoPendente(etapa);
    setErroAcao(null);
    try {
      if (typeof metodo !== 'function') throw new Error('Ação de atualização indisponível.');
      const proximo = await metodo();
      if (montado.current) receberEstadoRef.current?.(proximo);
    } catch {
      if (montado.current && !(etapa === 'download' && ['downloaded', 'installing'].includes(estadoRef.current?.status))) {
        setErroAcao({
          errorStage: etapa,
          message: etapa === 'download' ? 'Não foi possível baixar a atualização. Confira a conexão e tente novamente.'
            : etapa === 'install' ? 'Não foi possível reiniciar para instalar. Tente novamente quando puder sair da chamada.'
              : 'Não foi possível verificar a atualização. Confira a conexão e tente novamente.',
        });
      }
    } finally {
      acaoRef.current = null;
      if (montado.current) setAcaoPendente(null);
    }
  }

  const exibido = erroAcao ? { ...estado, ...erroAcao, status: 'error' } : estado;
  if (!estadosVisiveis.has(exibido?.status)) return null;

  const { status, version, errorStage } = exibido;
  const versao = version ? ' v' + version : '';
  const percent = Math.floor(Math.max(0, Math.min(100, Number(exibido.percent) || 0)));
  const pronto = status === 'downloaded' || (status === 'error' && errorStage === 'install');
  const titulo = status === 'available' ? 'Atualização' + versao + ' disponível'
    : status === 'downloading' ? 'Baixando atualização: ' + percent + '%'
      : status === 'downloaded' ? 'Atualização' + versao + ' pronta'
        : status === 'installing' ? 'Reiniciando para instalar…' : 'Atualização precisa de atenção';
  const etapa = status === 'available' ? 'download' : pronto ? 'install'
    : status === 'error' ? (errorStage === 'download' ? 'download' : 'check') : null;
  const rotuloAcao = acaoPendente === 'download' ? 'Iniciando download…'
    : acaoPendente === 'install' ? 'Reiniciando…'
      : acaoPendente === 'check' ? 'Verificando…'
        : status === 'available' ? 'Baixar atualização'
          : pronto ? 'Reiniciar e instalar'
            : errorStage === 'download' ? 'Tentar baixar novamente' : 'Tentar novamente';
  const orientacao = pronto ? 'Fechar o Astralis não instala. Reiniciar encerra chamadas e transmissões.'
    : status === 'available' ? 'O download só começa quando você escolher. Pode continuar usando o Astralis.'
      : status === 'downloading' ? 'Continue usando o Astralis. Você decide quando reiniciar e instalar.' : '';

  return (
    <aside className={'atualizacao-controle' + (status === 'error' ? ' atualizacao-controle--erro' : '') + (recolhido ? ' atualizacao-controle--recolhido' : '')} aria-label="Atualização do Astralis">
      <div className="atualizacao-controle__conteudo">
        <div className="atualizacao-controle__estado" role="status" aria-live="polite" aria-atomic="true">
          <span className="atualizacao-controle__sinal" aria-hidden="true">✦</span>
          <strong>{titulo}</strong>
          {recolhido && status === 'error' && <span className="atualizacao-controle__resumo">Abra para tentar novamente.</span>}
        </div>
        {!recolhido && (
          <>
            {status === 'error' && exibido.message && <p>{exibido.message}</p>}
            {orientacao && <p className="atualizacao-controle__orientacao">{orientacao}</p>}
            {status === 'downloading' && <progress max="100" value={percent} aria-label={'Download da atualização: ' + percent + '%'} />}
          </>
        )}
      </div>
      <div className="atualizacao-controle__acoes">
        {recolhido ? (
          <button type="button" className="atualizacao-controle__secundario" aria-expanded="false" onClick={() => setRecolhido(false)}>Ver atualização</button>
        ) : (
          <>
            {etapa && <button type="button" className="atualizacao-controle__primario" disabled={Boolean(acaoPendente)} onClick={() => executarAcao(etapa)}>{rotuloAcao}</button>}
            {status !== 'installing' && <button type="button" className="atualizacao-controle__secundario" aria-expanded="true" onClick={() => setRecolhido(true)}>{status === 'downloading' ? 'Recolher' : 'Mais tarde'}</button>}
          </>
        )}
      </div>
    </aside>
  );
}