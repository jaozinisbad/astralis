import React from 'react';

// Gera uma cor consistente pro servidor a partir do nome/id, pra cada
// servidor ter uma "cara" diferente na barra, parecido com ícones
// customizados (sem precisar de upload de imagem).
const PALETA = ['#7454bb', '#9270f4', '#62548b', '#ac82c5', '#806baa', '#9b71b0', '#68518d', '#8979b7'];

function corDoServidor(servidor) {
  const chave = String(servidor.id ?? servidor.nome);
  let soma = 0;
  for (let i = 0; i < chave.length; i++) soma += chave.charCodeAt(i);
  return PALETA[soma % PALETA.length];
}

export default function ServerSidebar({ servidores = [], servidorAtivoId, viewAtiva = 'salas', onSelecionar, onAbrirAmigos, onAbrirSalas, onAbrirModal }) {
  return (
    <nav className="server-sidebar" aria-label="Servidores e navegação principal">
      <button
        type="button"
        className={`server-icon${viewAtiva === 'amigos' || viewAtiva === 'dm' ? ' active' : ''}`}
        title="Amigos"
        aria-label="Abrir amigos"
        aria-current={viewAtiva === 'amigos' || viewAtiva === 'dm' ? 'page' : undefined}
        onClick={onAbrirAmigos}
      >
        <span className="tooltip-servidor">Amigos</span>
        <img src="./astralis-mark.svg" className="server-icon__brand" alt="Astralis" />
      </button>

      <div className="divider" />

      {servidores.map((s) => (
        <button
          type="button"
          key={s.id}
          className={`server-icon${viewAtiva === 'servidor' && s.id === servidorAtivoId ? ' active' : ''}`}
          style={{ '--server-color': corDoServidor(s) }}
          aria-label={`Abrir servidor ${s.nome}`}
          title={s.nome}
          aria-current={viewAtiva === 'servidor' && s.id === servidorAtivoId ? 'page' : undefined}
          onClick={() => onSelecionar(s.id)}
        >
          <span className="tooltip-servidor">{s.nome}</span>
          {s.icone_url ? <img src={s.icone_url} alt="" className="server-icon__imagem" /> : s.nome.slice(0, 2).toUpperCase()}
        </button>
      ))}

      {onAbrirSalas && <button
        type="button"
        className={`server-icon server-icon--rooms${viewAtiva === 'salas' ? ' active' : ''}`}
        aria-label="Abrir salas de tela"
        aria-current={viewAtiva === 'salas' ? 'page' : undefined}
        title="Salas de tela"
        onClick={onAbrirSalas}
      >
        <span className="tooltip-servidor">Salas de tela</span>
        <svg aria-hidden="true" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
      </button>}

      <div className="divider" />
      <button type="button" className="server-icon add-server" title="Criar ou entrar em servidor" aria-label="Criar ou entrar em servidor" onClick={onAbrirModal}>
        +
      </button>
    </nav>
  );
}
