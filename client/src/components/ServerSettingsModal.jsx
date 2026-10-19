import React, { useEffect, useState } from 'react';
import Avatar from './Avatar.jsx';
import { useDialogFocus } from '../useDialogFocus.mjs';
import './ServerSettingsModal.css';

const PERMISSOES = [
  ['gerenciar_servidor', 'Editar servidor', 'Alterar o nome, a descrição e as imagens do servidor.'],
  ['gerenciar_canais', 'Gerenciar canais', 'Criar e apagar canais de texto e de voz.'],
  ['gerenciar_cargos', 'Gerenciar cargos', 'Criar cargos e atribuir permissões aos membros.'],
  ['gerenciar_membros', 'Gerenciar membros', 'Remover membros do servidor.'],
  ['banir_membros', 'Banir membros', 'Impedir que um membro entre novamente com um convite.'],
  ['expulsar_call', 'Remover da chamada', 'Desconectar participantes dos canais de voz.'],
  ['gerenciar_mensagens', 'Gerenciar mensagens', 'Apagar mensagens de outros membros nos canais.'],
];
const ABAS = [['overview', 'Visão geral'], ['roles', 'Cargos'], ['members', 'Membros']];

async function imagemBase64(file, largura, altura) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const imagem = new Image();
      imagem.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = largura;
        canvas.height = altura;
        const escala = Math.max(largura / imagem.width, altura / imagem.height);
        const w = imagem.width * escala;
        const h = imagem.height * escala;
        canvas.getContext('2d').drawImage(imagem, (largura - w) / 2, (altura - h) / 2, w, h);
        canvas.toBlob((blob) => {
          if (!blob) return reject(new Error('Não foi possível preparar a imagem.'));
          const finalReader = new FileReader();
          finalReader.onload = () => resolve(finalReader.result);
          finalReader.onerror = () => reject(new Error('Não foi possível preparar a imagem.'));
          finalReader.readAsDataURL(blob);
        }, 'image/jpeg', 0.72);
      };
      imagem.onerror = () => reject(new Error('Imagem inválida.'));
      imagem.src = event.target.result;
    };
    reader.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
    reader.readAsDataURL(file);
  });
}

export default function ServerSettingsModal({ servidor, cargos = [], membros = [], onFechar, onSalvar, onCriarCargo, onAtribuirCargo, onBanir, onExpulsarMembro }) {
  const [aba, setAba] = useState('overview');
  const [nome, setNome] = useState(servidor.nome || '');
  const [descricao, setDescricao] = useState(servidor.descricao || '');
  const [iconeUrl, setIconeUrl] = useState(servidor.icone_url || null);
  const [bannerUrl, setBannerUrl] = useState(servidor.banner_url || null);
  const [cargoNome, setCargoNome] = useState('');
  const [cargoCor, setCargoCor] = useState('#9270f4');
  const [permissoes, setPermissoes] = useState({});
  const [buscaCargo, setBuscaCargo] = useState('');
  const [buscaMembro, setBuscaMembro] = useState('');
  const [membroSelecionado, setMembroSelecionado] = useState('');
  const [cargoSelecionado, setCargoSelecionado] = useState('');
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [pendente, setPendente] = useState('');
  const dialogRef = useDialogFocus(onFechar);
  const alterado = nome !== (servidor.nome || '') || descricao !== (servidor.descricao || '')
    || iconeUrl !== (servidor.icone_url || null) || bannerUrl !== (servidor.banner_url || null);
  const cargosVisiveis = cargos.filter((cargo) => cargo.nome.toLocaleLowerCase('pt-BR').includes(buscaCargo.toLocaleLowerCase('pt-BR')));
  const membrosVisiveis = membros.filter((membro) => membro.nome.toLocaleLowerCase('pt-BR').includes(buscaMembro.toLocaleLowerCase('pt-BR')));

  function restaurarServidor() {
    setNome(servidor.nome || '');
    setDescricao(servidor.descricao || '');
    setIconeUrl(servidor.icone_url || null);
    setBannerUrl(servidor.banner_url || null);
    setErro(''); setAviso('');
  }
  useEffect(() => { restaurarServidor(); }, [servidor]);

  async function executar(acao, operacao, mensagem) {
    setPendente(acao); setErro(''); setAviso('');
    try { await operacao(); if (mensagem) setAviso(mensagem); return true; }
    catch (err) { setErro(err.message || 'Não foi possível concluir a ação.'); return false; }
    finally { setPendente(''); }
  }

  async function escolherImagem(event, tipo) {
    const file = event.target.files?.[0];
    if (!file) return;
    await executar('imagem', async () => {
      if (!file.type.startsWith('image/') || file.size > 5 * 1024 * 1024) throw new Error('Use uma imagem de até 5MB.');
      const base64 = await imagemBase64(file, tipo === 'icone' ? 256 : 900, tipo === 'icone' ? 256 : 260);
      if (tipo === 'icone') setIconeUrl(base64);
      else setBannerUrl(base64);
    });
    event.target.value = '';
  }

  async function salvarServidor(event) {
    event.preventDefault();
    if (!nome.trim() || pendente) return;
    await executar('servidor', () => onSalvar({ nome: nome.trim(), descricao: descricao.trim(), icone_url: iconeUrl, banner_url: bannerUrl }), 'Servidor salvo.');
  }

  async function criarCargo(event) {
    event.preventDefault();
    if (!cargoNome.trim() || pendente) return;
    if (await executar('cargo', () => onCriarCargo({ nome: cargoNome.trim(), cor: cargoCor, permissoes }), 'Cargo criado.')) {
      setCargoNome('');
      setPermissoes({});
    }
  }

  async function atribuirCargo(event) {
    event.preventDefault();
    if (!membroSelecionado || !cargoSelecionado || pendente) return;
    await executar('atribuir', () => onAtribuirCargo(Number(membroSelecionado), Number(cargoSelecionado)), 'Cargo atribuído.');
  }

  function moderar(membro, tipo) {
    const pergunta = tipo === 'banir' ? `Banir ${membro.nome}? Ele não vai conseguir voltar, nem com um novo convite.` : `Expulsar ${membro.nome} do servidor?`;
    if (!window.confirm(pergunta)) return;
    executar(`${tipo}-${membro.id}`, () => tipo === 'banir' ? onBanir(membro.id) : onExpulsarMembro(membro.id), tipo === 'banir' ? 'Membro banido.' : 'Membro removido.');
  }

  return <section className="as-server-settings" role="dialog" aria-modal="true" aria-labelledby="configurar-servidor-titulo" ref={dialogRef} tabIndex={-1}>
    <aside className="as-server-settings__sidebar"><div className="as-server-settings__navigation">
      <div className="as-server-settings__server">{servidor.nome}</div>
      <nav aria-label="Configurações do servidor">{ABAS.map(([id, label]) => <button type="button" key={id} data-dialog-initial={id === 'overview' ? '' : undefined} className={aba === id ? 'is-active' : ''} aria-current={aba === id ? 'page' : undefined} onClick={() => { setAba(id); setErro(''); setAviso(''); }}>{label}{id === 'members' && <span>{membros.length}</span>}</button>)}</nav>
      <div className="as-server-settings__divider"/><button type="button" className="as-server-settings__back" onClick={onFechar}>Voltar ao servidor</button>
      <div className="as-server-settings__brand"><img src="./astralis-mark.svg" alt=""/><span>ASTRALIS</span></div>
    </div></aside>
    <div className="as-server-settings__main"><div className="as-server-settings__content">
      <header className="as-server-settings__heading"><h2 id="configurar-servidor-titulo">{ABAS.find(([id]) => id === aba)[1]}</h2><p>Configurações de {servidor.nome}</p></header>
      {erro && <div className="as-server-settings__feedback is-error" role="alert">{erro}</div>}
      {aviso && <div className="as-server-settings__feedback" role="status" aria-live="polite">{aviso}</div>}

      {aba === 'overview' && <form className="as-server-settings__overview" onSubmit={salvarServidor}>
        <div className="as-server-settings__identity"><div className="as-server-settings__icon-area">
          <div className="as-server-settings__icon">{iconeUrl ? <img src={iconeUrl} alt={`Ícone de ${nome}`}/> : <span>{nome.slice(0, 2).toUpperCase()}</span>}</div>
          <label className="as-server-settings__upload">Enviar imagem<input type="file" accept="image/*" aria-label="Enviar ícone do servidor" onChange={(event) => escolherImagem(event, 'icone')} disabled={Boolean(pendente)}/></label>
          {iconeUrl && <button type="button" className="as-server-settings__text-button" onClick={() => setIconeUrl(null)} disabled={Boolean(pendente)}>Remover ícone</button>}<small>Recomendado: 256 × 256. Até 5 MB.</small>
        </div><div className="as-server-settings__identity-fields">
          <label className="as-server-settings__field">Nome do servidor<input value={nome} maxLength={80} required onChange={(event) => setNome(event.target.value)}/></label>
          <label className="as-server-settings__field">Descrição do servidor<textarea value={descricao} maxLength={240} rows={4} placeholder="Conte um pouco sobre sua comunidade." onChange={(event) => setDescricao(event.target.value)}/><small>{descricao.length}/240</small></label>
        </div></div>
        <section className="as-server-settings__section"><h3>Banner do servidor</h3><p>Uma imagem que dá identidade ao seu espaço.</p>
          <div className={`as-server-settings__banner${bannerUrl ? ' has-image' : ''}`} style={bannerUrl ? { backgroundImage: `url(${bannerUrl})` } : undefined}>{!bannerUrl && <><img src="./astralis-mark.svg" alt=""/><span>{nome || 'Seu servidor'}</span></>}</div>
          <div className="as-server-settings__inline"><label className="as-server-settings__upload">{bannerUrl ? 'Alterar banner' : 'Enviar banner'}<input type="file" accept="image/*" aria-label="Enviar banner do servidor" onChange={(event) => escolherImagem(event, 'banner')} disabled={Boolean(pendente)}/></label>{bannerUrl && <button type="button" className="as-server-settings__text-button" disabled={Boolean(pendente)} onClick={() => setBannerUrl(null)}>Remover banner</button>}<small>Recomendado: 900 × 260. Até 5 MB.</small></div>
        </section>
        <footer className={`as-server-settings__save${alterado ? ' has-changes' : ''}`}><span>{alterado ? 'Cuidado! Você tem alterações não salvas.' : 'Personalize o seu servidor.'}</span><button type="button" className="as-server-settings__text-button" disabled={!alterado || Boolean(pendente)} onClick={restaurarServidor}>Redefinir</button><button type="submit" className="as-server-settings__primary" disabled={!nome.trim() || Boolean(pendente)}>{pendente === 'servidor' ? 'Salvando…' : 'Salvar alterações'}</button></footer>
      </form>}

      {aba === 'roles' && <div className="as-server-settings__roles"><p className="as-server-settings__description">Use cargos para organizar seus membros e controlar o que cada pessoa pode fazer.</p>
        <section className="as-server-settings__section"><div className="as-server-settings__section-heading"><h3>Cargos — {cargos.length}</h3><input type="search" aria-label="Buscar cargos" placeholder="Buscar cargos" value={buscaCargo} onChange={(event) => setBuscaCargo(event.target.value)}/></div>
          <div className="as-server-settings__role-list">{cargosVisiveis.length ? cargosVisiveis.map((cargo) => <div className="as-server-settings__role" key={cargo.id}><i style={{ backgroundColor: cargo.cor }}/><strong style={{ color: cargo.cor }}>{cargo.nome}</strong><span>{membros.filter((membro) => membro.cargos?.some((item) => item.id === cargo.id)).length} membros</span></div>) : <p className="as-server-settings__empty">{buscaCargo ? 'Nenhum cargo encontrado.' : 'Você ainda não criou cargos.'}</p>}</div>
        </section>
        <form className="as-server-settings__section" onSubmit={criarCargo}><h3>Criar cargo</h3><div className="as-server-settings__new-role"><label className="as-server-settings__field">Nome do cargo<input placeholder="Novo cargo" value={cargoNome} maxLength={80} required onChange={(event) => setCargoNome(event.target.value)}/></label><label className="as-server-settings__field as-server-settings__role-color">Cor<input type="color" value={cargoCor} onChange={(event) => setCargoCor(event.target.value)}/></label></div>
          <h4 className="as-server-settings__label">Permissões gerais do servidor</h4><div className="as-server-settings__permissions">{PERMISSOES.map(([id, label, description]) => <label className="as-server-settings__permission" key={id}><span><strong>{label}</strong><small>{description}</small></span><span className="as-server-settings__switch"><input type="checkbox" aria-label={label} checked={permissoes[id] === true} onChange={(event) => setPermissoes((atual) => ({ ...atual, [id]: event.target.checked }))}/><i aria-hidden="true"/></span></label>)}</div>
          <div className="as-server-settings__form-actions"><button type="submit" className="as-server-settings__primary" disabled={!cargoNome.trim() || Boolean(pendente)}>{pendente === 'cargo' ? 'Criando…' : 'Criar cargo'}</button></div>
        </form>
      </div>}

      {aba === 'members' && <div className="as-server-settings__members">
        <section className="as-server-settings__section"><h3>Atribuir cargo a membro</h3><p>Escolha um membro e um cargo. O proprietário mantém suas permissões.</p><form className="as-server-settings__assign" onSubmit={atribuirCargo}>
          <label className="as-server-settings__field">Membro<select value={membroSelecionado} onChange={(event) => setMembroSelecionado(event.target.value)} required><option value="">Escolha um membro</option>{membros.filter((membro) => membro.papel !== 'dono').map((membro) => <option key={membro.id} value={membro.id}>{membro.nome}</option>)}</select></label>
          <label className="as-server-settings__field">Cargo<select value={cargoSelecionado} onChange={(event) => setCargoSelecionado(event.target.value)} required><option value="">Escolha um cargo</option>{cargos.filter((cargo) => cargo.nome !== 'Administrador').map((cargo) => <option key={cargo.id} value={cargo.id}>{cargo.nome}</option>)}</select></label><button type="submit" className="as-server-settings__primary" disabled={!membroSelecionado || !cargoSelecionado || Boolean(pendente)}>{pendente === 'atribuir' ? 'Atribuindo…' : 'Atribuir'}</button>
        </form></section>
        <section className="as-server-settings__section"><div className="as-server-settings__section-heading"><h3>Membros — {membros.length}</h3><input type="search" aria-label="Buscar membros" placeholder="Buscar membros" value={buscaMembro} onChange={(event) => setBuscaMembro(event.target.value)}/></div>
          <div className="as-server-settings__member-list">{membrosVisiveis.length ? membrosVisiveis.map((membro) => <article className="as-server-settings__member" key={membro.id}>
            <Avatar nome={membro.nome} avatarUrl={membro.avatar_url} avatarCor={membro.avatar_cor || '#9270f4'} tamanho="sm"/><div className="as-server-settings__member-detail"><strong>{membro.nome}{membro.papel === 'dono' && <span className="as-server-settings__owner" title="Proprietário">♛</span>}</strong>
              <div className="as-server-settings__member-roles">{membro.cargos?.map((cargo) => membro.papel === 'dono' ? <span key={cargo.id} className="as-server-settings__role-chip" style={{ color: cargo.cor }}>{cargo.nome}</span> : <button type="button" key={cargo.id} className="as-server-settings__role-chip" style={{ color: cargo.cor }} aria-label={`Remover cargo ${cargo.nome} de ${membro.nome}`} disabled={Boolean(pendente)} onClick={() => executar('remover-cargo', () => onAtribuirCargo(membro.id, cargo.id, true), 'Cargo removido.')}>{cargo.nome} <span aria-hidden="true">×</span></button>)}</div>
            </div>{membro.papel !== 'dono' && <div className="as-server-settings__member-actions">{onExpulsarMembro && <button type="button" disabled={Boolean(pendente)} onClick={() => moderar(membro, 'expulsar')}>Expulsar</button>}{onBanir && <button type="button" disabled={Boolean(pendente)} onClick={() => moderar(membro, 'banir')}>Banir</button>}</div>}
          </article>) : <p className="as-server-settings__empty">{buscaMembro ? 'Nenhum membro encontrado.' : 'Ainda não há membros para mostrar.'}</p>}</div>
        </section>
      </div>}
    </div><div className="as-server-settings__close"><button type="button" aria-label="Fechar configurações do servidor" onClick={onFechar}><svg aria-hidden="true" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg></button><span>ESC</span></div></div>
  </section>;
}
