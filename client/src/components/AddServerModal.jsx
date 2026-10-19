import React, { useState } from 'react';
import { useDialogFocus } from '../useDialogFocus.mjs';

export default function AddServerModal({ onFechar, onCriar, onEntrar }) {
  const [modo, setModo] = useState('criar'); // 'criar' | 'entrar'
  const [nome, setNome] = useState('');
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(false);
  const dialogRef = useDialogFocus(onFechar);

  async function confirmar(e) {
    e.preventDefault();
    setErro('');
    if (modo === 'criar' && !nome.trim()) {
      setErro('Digite um nome para o servidor.');
      return;
    }
    setCarregando(true);
    try {
      if (modo === 'criar') {
        await onCriar(nome.trim());
      } else {
        await onEntrar(codigo.trim());
      }
      onFechar();
    } catch (err) {
      setErro(err.message);
    } finally {
      setCarregando(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onFechar}>
      <form className="modal" role="dialog" aria-modal="true" aria-label="Criar ou entrar em servidor" ref={dialogRef} tabIndex={-1} onClick={(e) => e.stopPropagation()} onSubmit={confirmar}>
        <div className="modal-tabs">
          <button type="button"
            className={`modal-tab${modo === 'criar' ? ' active' : ''}`}
            aria-pressed={modo === 'criar'}
            style={{ border: 0, background: 'transparent', font: 'inherit' }}
            onClick={() => setModo('criar')}
          >
            Criar servidor
          </button>
          <button type="button"
            className={`modal-tab${modo === 'entrar' ? ' active' : ''}`}
            aria-pressed={modo === 'entrar'}
            style={{ border: 0, background: 'transparent', font: 'inherit' }}
            onClick={() => setModo('entrar')}
          >
            Entrar com convite
          </button>
        </div>

        {modo === 'criar' ? (
          <input
            autoFocus
            placeholder="Nome do servidor"
            aria-label="Nome do servidor"
            data-dialog-initial
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            maxLength={50}
            required
            className="modal-input"
          />
        ) : (
          <input
            autoFocus
            placeholder="Código de convite"
            aria-label="Código de convite"
            value={codigo}
            onChange={(e) => setCodigo(e.target.value)}
            className="modal-input"
          />
        )}

        {erro && <div className="modal-erro" role="alert">{erro}</div>}

        <div className="modal-acoes">
          <button type="button" onClick={onFechar} className="modal-botao-secundario">
            Cancelar
          </button>
          <button type="submit" disabled={carregando} className="modal-botao-primario">
            {carregando ? 'Aguarde...' : modo === 'criar' ? 'Criar' : 'Entrar'}
          </button>
        </div>
      </form>
    </div>
  );
}
