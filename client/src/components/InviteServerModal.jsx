import React, { useMemo, useState } from 'react';

export default function InviteServerModal({ servidorNome, codigoConvite, onFechar }) {
  const [feedback, setFeedback] = useState('');
  const [valorSelecionado, setValorSelecionado] = useState(codigoConvite);
  const mensagemConvite = useMemo(
    () => `Venha jogar comigo no servidor ${servidorNome} do Astralis! Use este código para entrar: ${codigoConvite}`,
    [servidorNome, codigoConvite],
  );

  async function copiar(texto, tipo) {
    setValorSelecionado(texto);
    try {
      if (window.electronAPI?.copiarTexto) {
        await window.electronAPI.copiarTexto(texto);
      } else if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(texto);
        } catch {
          if (!copiarComSelecao(texto)) throw new Error('A área de transferência não aceitou o texto.');
        }
      } else if (!copiarComSelecao(texto)) {
        throw new Error('A área de transferência não está disponível.');
      }
      setFeedback(tipo === 'mensagem' ? 'Mensagem pronta para enviar.' : 'Código copiado. Agora envie para seu amigo.');
    } catch (error) {
      console.error('Não foi possível copiar o convite:', error);
      setFeedback('Não foi possível copiar automaticamente. Selecione o texto abaixo e copie manualmente.');
    }
  }

  function copiarComSelecao(texto) {
    const campo = document.querySelector('[data-invite-copy-fallback]');
    if (!campo) return false;
    campo.value = texto;
    campo.focus();
    campo.select();
    return document.execCommand('copy');
  }

  return (
    <div className="modal-overlay" onClick={onFechar}>
      <section className="modal invite-modal" role="dialog" aria-modal="true" aria-labelledby="invite-modal-title"
        onClick={(event) => event.stopPropagation()}>
        <h2 id="invite-modal-title">Convidar para {servidorNome}</h2>
        <p>Envie o código para seu amigo. No Astralis, ele deve escolher “Entrar com convite”.</p>
        <label className="settings-field">
          Código do convite
          <input className="modal-input" data-invite-copy-fallback readOnly value={valorSelecionado}
            onFocus={(event) => event.target.select()} onClick={(event) => event.target.select()} />
        </label>
        {feedback && <div role="status" aria-live="polite" className="invite-modal__feedback">{feedback}</div>}
        <div className="invite-modal__actions">
          <button type="button" className="modal-botao-secundario" onClick={() => copiar(codigoConvite, 'codigo')}>
            Copiar código
          </button>
          <button type="button" className="modal-botao-primario" onClick={() => copiar(mensagemConvite, 'mensagem')}>
            Copiar mensagem pronta
          </button>
        </div>
        <div className="modal-acoes">
          <button type="button" className="modal-botao-secundario" onClick={onFechar}>Fechar</button>
        </div>
      </section>
    </div>
  );
}
