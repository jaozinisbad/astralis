import React, { useCallback, useEffect, useRef, useState } from 'react';
import { emitirSolicitacaoSala } from '../roomSocket.mjs';
import './RoomLobby.css';

function mensagemDoErro(erro, alternativa) {
  return typeof erro === 'string' && erro.trim() ? erro : alternativa;
}

export default function RoomLobby({ socket, onCriar, onEntrar, onAbrirPerfil, onEntrarNaConta, usuario }) {
  const [salas, setSalas] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erroLista, setErroLista] = useState('');
  const [erroAcao, setErroAcao] = useState('');
  const [nome, setNome] = useState('');
  const [visibilidade, setVisibilidade] = useState('public');
  const [criando, setCriando] = useState(false);
  const [entrando, setEntrando] = useState(false);
  const [salaEmEntrada, setSalaEmEntrada] = useState('');
  const [modalCodigoAberto, setModalCodigoAberto] = useState(false);
  const [codigoAcesso, setCodigoAcesso] = useState('');
  const [codigoConviteCriado, setCodigoConviteCriado] = useState('');
  const requestIdRef = useRef(0);
  const entrandoRef = useRef(entrando);
  const dialogRef = useRef(null);
  entrandoRef.current = entrando;

  const listarSalas = useCallback(() => {
    if (!socket || typeof socket.emit !== 'function') {
      setCarregando(false);
      setErroLista('Não foi possível conectar à lista de salas. Tente novamente.');
      return;
    }

    const requestId = ++requestIdRef.current;
    setCarregando(true);
    setErroLista('');
    emitirSolicitacaoSala(socket, 'salas:listar', {}).then((resultado = {}) => {
      if (requestId !== requestIdRef.current) return;
      setCarregando(false);
      if (!resultado.ok) {
        setErroLista(mensagemDoErro(resultado.error, 'Não foi possível carregar as salas agora.'));
        return;
      }
      setSalas(Array.isArray(resultado.rooms) ? resultado.rooms : []);
    });
  }, [socket]);

  useEffect(() => {
    if (!socket || typeof socket.on !== 'function') {
      listarSalas();
      return undefined;
    }

    const aoAtualizarSalas = (resultado = {}) => {
      if (!Array.isArray(resultado.rooms)) return;
      requestIdRef.current += 1;
      setSalas(resultado.rooms);
      setCarregando(false);
      setErroLista('');
    };

    socket.on('salas:atualizadas', aoAtualizarSalas);
    listarSalas();

    return () => {
      requestIdRef.current += 1;
      if (typeof socket.off === 'function') socket.off('salas:atualizadas', aoAtualizarSalas);
    };
  }, [socket, listarSalas]);

  useEffect(() => {
    if (!modalCodigoAberto) return undefined;
    if (typeof document === 'undefined') return undefined;

    const elementoAnterior = document.activeElement;
    document.getElementById('room-lobby-access-code')?.focus();
    const controlarTeclado = (evento) => {
      if (evento.key === 'Escape' && !entrandoRef.current) {
        setModalCodigoAberto(false);
        return;
      }
      if (evento.key !== 'Tab') return;

      const focaveis = dialogRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])');
      if (!focaveis?.length) return;
      const primeiro = focaveis[0];
      const ultimo = focaveis[focaveis.length - 1];
      if (evento.shiftKey && document.activeElement === primeiro) {
        evento.preventDefault();
        ultimo.focus();
      } else if (!evento.shiftKey && document.activeElement === ultimo) {
        evento.preventDefault();
        primeiro.focus();
      }
    };
    document.addEventListener('keydown', controlarTeclado);

    return () => {
      document.removeEventListener('keydown', controlarTeclado);
      if (typeof elementoAnterior?.focus === 'function') elementoAnterior.focus();
    };
  }, [modalCodigoAberto]);

  async function criarSala(evento) {
    evento.preventDefault();
    const nomeNormalizado = nome.trim();
    if (!nomeNormalizado) {
      setErroAcao('Dê um nome para a sala antes de criar.');
      return;
    }

    setErroAcao('');
    setCodigoConviteCriado('');
    setCriando(true);
    try {
      if (typeof onCriar !== 'function') throw new Error('A criação de salas não está disponível agora.');
      const resultado = await onCriar({ name: nomeNormalizado, visibility: visibilidade });
      if (resultado?.ok === false) {
        setErroAcao(mensagemDoErro(resultado.error, 'Não foi possível criar a sala.'));
        return;
      }
      if (typeof resultado?.accessCode === 'string' && resultado.accessCode) {
        setCodigoConviteCriado(resultado.accessCode);
      }
      setNome('');
    } catch (erro) {
      setErroAcao(mensagemDoErro(erro?.message, 'Não foi possível criar a sala.'));
    } finally {
      setCriando(false);
    }
  }

  async function entrarNaSala(roomId, accessCode = '') {
    if (!roomId && !accessCode.trim()) {
      setErroAcao('Informe o código de acesso.');
      return false;
    }
    setErroAcao('');
    setSalaEmEntrada(roomId || 'codigo');
    setEntrando(true);
    try {
      if (typeof onEntrar !== 'function') throw new Error('A entrada em salas não está disponível agora.');
      const dadosEntrada = roomId ? { roomId, accessCode } : { accessCode };
      const resultado = await onEntrar(dadosEntrada);
      if (resultado?.ok === false) {
        setErroAcao(mensagemDoErro(resultado.error, 'Não foi possível entrar na sala.'));
        return false;
      }
      setModalCodigoAberto(false);
      setCodigoAcesso('');
      return true;
    } catch (erro) {
      setErroAcao(mensagemDoErro(erro?.message, 'Não foi possível entrar na sala.'));
      return false;
    } finally {
      setEntrando(false);
      setSalaEmEntrada('');
    }
  }

  async function entrarComCodigo(evento) {
    evento.preventDefault();
    const accessCode = codigoAcesso.trim().toUpperCase();
    if (!accessCode) {
      setErroAcao('Informe o código de acesso.');
      return;
    }
    await entrarNaSala('', accessCode);
  }

  const nomeUsuario = usuario?.nome?.trim() || 'Visitante';
  const iniciais = nomeUsuario.slice(0, 2).toUpperCase();

  return (
    <main className="room-lobby" aria-labelledby="room-lobby-title">
      <div className="room-lobby__glow room-lobby__glow--violet" aria-hidden="true" />
      <div className="room-lobby__glow room-lobby__glow--teal" aria-hidden="true" />

      <header className="room-lobby__topbar">
        <a className="room-lobby__brand" href="#inicio" aria-label="Astralis, início">
          <span className="room-lobby__brand-mark" aria-hidden="true">✦</span>
          <span>ASTRALIS</span>
        </a>
        <button className="room-lobby__profile" type="button" onClick={() => (usuario ? onAbrirPerfil?.() : onEntrarNaConta?.())} aria-label={usuario ? 'Abrir perfil' : 'Entrar na conta'}>
          <span className="room-lobby__profile-avatar" aria-hidden="true">{iniciais}</span>
          <span className="room-lobby__profile-name">{usuario ? nomeUsuario : 'Entrar'}</span>
          <span className="room-lobby__profile-chevron" aria-hidden="true">⌄</span>
          <span className="room-lobby__sr-only">Abrir perfil</span>
        </button>
      </header>

      <div className="room-lobby__content">
        <section className="room-lobby__intro" aria-labelledby="room-lobby-title">
          <div className="room-lobby__eyebrow"><span aria-hidden="true" /> SALAS DE TELA</div>
          <h1 id="room-lobby-title">Sua próxima sessão começa aqui.</h1>
          <p>Compartilhe uma tela, abra uma sala ao vivo e assista junto — a conversa continua onde você preferir.</p>
          <div className="room-lobby__intro-note">
            <span aria-hidden="true">⌁</span>
            <span>Sem chamadas ou chat dentro da sala. Só a transmissão.</span>
          </div>
        </section>

        <div className="room-lobby__layout">
          <section className="room-lobby__live" aria-labelledby="room-lobby-live-title">
            <div className="room-lobby__section-heading">
              <div>
                <p className="room-lobby__section-kicker">ENCONTRE SUA GALERA</p>
                <h2 id="room-lobby-live-title">Ao vivo agora <span className="room-lobby__live-dot" aria-hidden="true" /></h2>
              </div>
              <button className="room-lobby__refresh" type="button" onClick={listarSalas} disabled={carregando}>
                <span aria-hidden="true">↻</span> Atualizar salas
              </button>
            </div>

            {erroLista && (
              <div className="room-lobby__notice room-lobby__notice--error" role="alert">
                <span>{erroLista}</span>
                <button type="button" onClick={listarSalas}>Tentar novamente</button>
              </div>
            )}
            {erroAcao && !modalCodigoAberto && <p className="room-lobby__notice room-lobby__notice--error" role="alert">{erroAcao}</p>}

            {carregando ? (
              <div className="room-lobby__state" role="status" aria-live="polite">
                <span className="room-lobby__spinner" aria-hidden="true" />
                <span>Buscando transmissões abertas…</span>
              </div>
            ) : erroLista ? null : salas.length === 0 ? (
              <div className="room-lobby__state room-lobby__state--empty" role="status">
                <span className="room-lobby__empty-mark" aria-hidden="true">◌</span>
                <h3>Nenhuma sala pública ao vivo</h3>
                <p>Quando alguém iniciar uma transmissão pública, ela aparece por aqui.</p>
                <button type="button" onClick={listarSalas}>Atualizar lista</button>
              </div>
            ) : (
              <ul className="room-lobby__room-list">
                {salas.map((sala, indice) => {
                  const roomId = sala.id ?? sala.roomId ?? sala.salaId;
                  const quantidade = Number.isFinite(Number(sala.viewerCount)) ? Number(sala.viewerCount) : 0;
                  return (
                    <li className="room-lobby__room-card" key={roomId || `${sala.name}-${indice}`}>
                      <div className="room-lobby__room-art" aria-hidden="true">
                        <span className="room-lobby__room-orbit room-lobby__room-orbit--one" />
                        <span className="room-lobby__room-orbit room-lobby__room-orbit--two" />
                        <span className="room-lobby__room-symbol">✧</span>
                      </div>
                      <div className="room-lobby__room-details">
                        <span className="room-lobby__room-live"><span /> AO VIVO</span>
                        <h3>{sala.name || 'Sala sem nome'}</h3>
                        <p>Transmitindo por <strong>{sala.ownerName || 'Anfitrião'}</strong></p>
                        <span className="room-lobby__viewer-count" aria-label={`${quantidade} espectadores`}>
                          <span aria-hidden="true">◉</span> {quantidade} {quantidade === 1 ? 'assistindo' : 'assistindo'}
                        </span>
                      </div>
                      <button
                        className="room-lobby__join"
                        type="button"
                        onClick={() => entrarNaSala(roomId, '')}
                        disabled={entrando}
                        aria-label={`Assistir ${sala.name || 'sala sem nome'}`}
                      >
                        {entrando && salaEmEntrada === roomId ? 'Entrando…' : 'Assistir'}
                        <span aria-hidden="true">↗</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <aside className="room-lobby__create-panel" aria-labelledby="room-lobby-create-title">
            <div className="room-lobby__create-mark" aria-hidden="true">＋</div>
            <p className="room-lobby__section-kicker">SEJA O ANFITRIÃO</p>
            <h2 id="room-lobby-create-title">Crie sua sala</h2>
            <p className="room-lobby__create-copy">Escolha um nome, defina quem pode entrar e prepare sua tela.</p>

            <form className="room-lobby__create-form" onSubmit={criarSala}>
              <label className="room-lobby__field-label" htmlFor="room-lobby-name">Nome da sala</label>
              <input
                id="room-lobby-name"
                aria-label="Nome da sala"
                className="room-lobby__input"
                type="text"
                value={nome}
                onChange={(evento) => setNome(evento.target.value)}
                maxLength={60}
                placeholder="Ex.: noite de jogos"
                autoComplete="off"
              />

              <fieldset className="room-lobby__visibility">
                <legend>Quem pode assistir?</legend>
                <label className={`room-lobby__visibility-option${visibilidade === 'public' ? ' is-selected' : ''}`}>
                  <input
                    type="radio"
                    name="room-lobby-visibility"
                    value="public"
                    checked={visibilidade === 'public'}
                    onChange={() => setVisibilidade('public')}
                  />
                  <span className="room-lobby__visibility-icon" aria-hidden="true">◎</span>
                  <span><strong>Pública</strong><small>Aparece na lista ao vivo</small></span>
                </label>
                <label className={`room-lobby__visibility-option${visibilidade === 'private' ? ' is-selected' : ''}`}>
                  <input
                    type="radio"
                    name="room-lobby-visibility"
                    value="private"
                    checked={visibilidade === 'private'}
                    onChange={() => setVisibilidade('private')}
                  />
                  <span className="room-lobby__visibility-icon" aria-hidden="true">⌑</span>
                  <span><strong>Privada</strong><small>Entrada com código</small></span>
                </label>
              </fieldset>

              {codigoConviteCriado && (
                <p className="room-lobby__notice room-lobby__notice--success" role="status">
                  Código da sala privada: <strong>{codigoConviteCriado}</strong>
                </p>
              )}
              <button className="room-lobby__create-button" type="submit" disabled={criando || !nome.trim()}>
                {criando ? 'Criando sala…' : 'Criar sala'} <span aria-hidden="true">→</span>
              </button>
            </form>

            <div className="room-lobby__panel-divider"><span>OU</span></div>
            <button
              className="room-lobby__private-entry"
              type="button"
              onClick={() => { setErroAcao(''); setModalCodigoAberto(true); }}
            >
              <span aria-hidden="true">⌑</span> Entrar com código de convite
            </button>
          </aside>
        </div>

        <footer className="room-lobby__footer">
          <span>ASTRALIS <span aria-hidden="true">✦</span></span>
          <span>Compartilhe o que importa.</span>
        </footer>
      </div>

      {modalCodigoAberto && (
        <div className="room-lobby__modal-backdrop">
          <section ref={dialogRef} className="room-lobby__dialog" role="dialog" aria-modal="true" aria-labelledby="room-lobby-dialog-title" aria-describedby="room-lobby-dialog-copy">
            <button
              className="room-lobby__dialog-close"
              type="button"
              onClick={() => setModalCodigoAberto(false)}
              disabled={entrando}
              aria-label="Fechar janela de convite"
            >×</button>
            <div className="room-lobby__dialog-mark" aria-hidden="true">⌑</div>
            <p className="room-lobby__section-kicker">ACESSO PRIVADO</p>
            <h2 id="room-lobby-dialog-title">Entre por convite</h2>
            <p id="room-lobby-dialog-copy">Informe o código de acesso compartilhado por quem está transmitindo.</p>
            <form className="room-lobby__private-form" onSubmit={entrarComCodigo}>
              <label className="room-lobby__field-label" htmlFor="room-lobby-access-code">Código de acesso</label>
              <input
                id="room-lobby-access-code"
                aria-label="Código de acesso"
                className="room-lobby__input room-lobby__input--code"
                type="text"
                value={codigoAcesso}
                onChange={(evento) => setCodigoAcesso(evento.target.value.toUpperCase())}
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck="false"
                maxLength={8}
                required
              />
              {erroAcao && <p className="room-lobby__notice room-lobby__notice--error" role="alert">{erroAcao}</p>}
              <button className="room-lobby__create-button" type="submit" disabled={entrando || !codigoAcesso.trim()}>
                {entrando ? 'Entrando…' : 'Entrar na sala'} <span aria-hidden="true">→</span>
              </button>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}
