import React, { useEffect, useState } from 'react';
import './WindowCaptureCompatibilityOption.css';

export default function WindowCaptureCompatibilityOption({ visible }) {
  const api = window.electronAPI;
  const [status, setStatus] = useState({ loading: true, available: false, enabled: false });
  const [selecionada, setSelecionada] = useState(false);
  const [aplicando, setAplicando] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => {
    let ativo = true;
    if (!visible || !api?.obterCompatibilidadeCapturaJanela) {
      setStatus({ loading: false, available: false, enabled: false });
      return () => { ativo = false; };
    }

    api.obterCompatibilidadeCapturaJanela()
      .then((resultado) => {
        if (!ativo) return;
        const enabled = resultado?.enabled === true;
        setStatus({ loading: false, available: resultado?.available === true, enabled });
        setSelecionada(enabled);
      })
      .catch(() => {
        if (ativo) setStatus({ loading: false, available: false, enabled: false });
      });

    return () => { ativo = false; };
  }, [api, visible]);

  async function aplicar() {
    setErro('');
    setAplicando(true);
    try {
      const resultado = await api?.aplicarCompatibilidadeCapturaJanela?.(selecionada);
      if (!resultado?.ok) {
        setErro(resultado?.mensagem || 'Não consegui salvar essa opção.');
        setAplicando(false);
      }
    } catch (error) {
      setErro('Não consegui salvar essa opção: ' + error.message);
      setAplicando(false);
    }
  }

  if (!visible || status.loading || !status.available) return null;
  const alterada = selecionada !== status.enabled;

  return (
    <section className="window-capture-compatibility" aria-label="Compatibilidade de captura de janela">
      <label className="window-capture-compatibility__toggle">
        <input
          type="checkbox"
          checked={selecionada}
          disabled={aplicando}
          onChange={(event) => setSelecionada(event.target.checked)}
        />
        <span>
          <strong>Testar captura de janela sem borda</strong>
          <small>
            Usa uma alternativa de captura de janela e pode remover a borda amarela. Alguns jogos com saída DirectX podem aparecer pretos. O áudio da janela não muda.
          </small>
        </span>
      </label>
      {alterada && (
        <button type="button" onClick={aplicar} disabled={aplicando}>
          {aplicando ? 'Reiniciando…' : 'Aplicar e reiniciar Astralis'}
        </button>
      )}
      {alterada && <small className="window-capture-compatibility__restart-note">O reinício encerra chamadas e transmissões ativas.</small>}
      {erro && <small className="window-capture-compatibility__error" role="alert">{erro}</small>}
    </section>
  );
}
