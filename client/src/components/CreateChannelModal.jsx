import React, { useState } from 'react';

export default function CreateChannelModal({ tipo, onCriar, onFechar }) {
  const [nome, setNome] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  async function enviar(event) {
    event.preventDefault();
    if (!nome.trim() || salvando) return;
    setSalvando(true);
    setErro('');
    try {
      await onCriar(nome.trim());
      onFechar();
    } catch (error) {
      setErro(error.message || 'Não foi possível criar o canal. Tente novamente.');
      setSalvando(false);
    }
  }

  function fechar() {
    if (!salvando) onFechar();
  }

  return (
    <div className="modal-overlay" onClick={fechar} onKeyDown={(event) => {
      if (event.key === 'Escape') fechar();
    }}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="criar-canal-titulo"
        onClick={(event) => event.stopPropagation()} onSubmit={enviar}>
        <h2 id="criar-canal-titulo">Criar canal de {tipo === 'voz' ? 'voz' : 'texto'}</h2>
        <label className="settings-field">
          Nome do canal
          <input className="modal-input" autoFocus required maxLength={80} value={nome}
            disabled={salvando} onChange={(event) => setNome(event.target.value)} />
        </label>
        {erro && <div className="modal-erro" role="alert">{erro}</div>}
        <div className="modal-acoes">
          <button className="modal-botao-secundario" type="button" disabled={salvando} onClick={fechar}>Cancelar</button>
          <button className="modal-botao-primario" type="submit" disabled={salvando || !nome.trim()}>
            {salvando ? 'Criando…' : 'Criar canal'}
          </button>
        </div>
      </form>
    </div>
  );
}
