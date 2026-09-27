import React, { useEffect, useState } from 'react';

const PERMISSOES = [
  ['gerenciar_servidor', 'Editar servidor'],
  ['gerenciar_canais', 'Gerenciar canais'],
  ['gerenciar_cargos', 'Gerenciar cargos'],
  ['gerenciar_membros', 'Gerenciar membros'],
  ['banir_membros', 'Banir membros'],
  ['expulsar_call', 'Remover da call'],
  ['gerenciar_mensagens', 'Apagar mensagens'],
];

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

export default function ServerSettingsModal({ servidor, cargos, membros = [], onFechar, onSalvar, onCriarCargo, onAtribuirCargo, onBanir, onExpulsarMembro }) {
  const [nome, setNome] = useState(servidor.nome || '');
  const [descricao, setDescricao] = useState(servidor.descricao || '');
  const [iconeUrl, setIconeUrl] = useState(servidor.icone_url || null);
  const [bannerUrl, setBannerUrl] = useState(servidor.banner_url || null);
  const [cargoNome, setCargoNome] = useState('');
  const [cargoCor, setCargoCor] = useState('#99aab5');
  const [permissoes, setPermissoes] = useState({});
  const [membroSelecionado, setMembroSelecionado] = useState('');
  const [cargoSelecionado, setCargoSelecionado] = useState('');
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    setNome(servidor.nome || '');
    setDescricao(servidor.descricao || '');
    setIconeUrl(servidor.icone_url || null);
    setBannerUrl(servidor.banner_url || null);
  }, [servidor]);

  async function escolherImagem(event, tipo) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (!file.type.startsWith('image/') || file.size > 5 * 1024 * 1024) throw new Error('Use uma imagem de até 5MB.');
      const base64 = await imagemBase64(file, tipo === 'icone' ? 256 : 900, tipo === 'icone' ? 256 : 260);
      if (tipo === 'icone') setIconeUrl(base64);
      else setBannerUrl(base64);
      setErro('');
    } catch (err) {
      setErro(err.message);
    }
  }

  async function salvarServidor(event) {
    event.preventDefault();
    setSalvando(true);
    setErro('');
    setAviso('');
    try {
      await onSalvar({ nome: nome.trim(), descricao: descricao.trim(), icone_url: iconeUrl, banner_url: bannerUrl });
      setAviso('Servidor salvo.');
    } catch (err) {
      setErro(err.message);
    } finally {
      setSalvando(false);
    }
  }

  async function criarCargo(event) {
    event.preventDefault();
    if (!cargoNome.trim()) return;
    try {
      await onCriarCargo({ nome: cargoNome.trim(), cor: cargoCor, permissoes });
      setCargoNome('');
      setPermissoes({});
    } catch (err) {
      setErro(err.message);
    }
  }

  async function atribuirCargo(event) {
    event.preventDefault();
    if (!membroSelecionado || !cargoSelecionado) return;
    try {
      await onAtribuirCargo(Number(membroSelecionado), Number(cargoSelecionado));
      setErro('');
    } catch (err) {
      setErro(err.message);
    }
  }

  return (
    <div className="modal-overlay" onClick={onFechar}>
      <div className="modal servidor-config-modal" role="dialog" aria-modal="true" aria-labelledby="configurar-servidor-titulo" onClick={(event) => event.stopPropagation()}>
        <div className="modal-cabecalho"><div><span className="eyebrow">Administração</span><h2 id="configurar-servidor-titulo">Configurar servidor</h2></div><button type="button" aria-label="Fechar configurações do servidor" onClick={onFechar}>✕</button></div>
        <form onSubmit={salvarServidor}>
          <label className="settings-field">Nome<input value={nome} maxLength="80" onChange={(event) => setNome(event.target.value)} /></label>
          <label className="settings-field">Descrição<textarea value={descricao} maxLength="240" onChange={(event) => setDescricao(event.target.value)} /></label>
          <div className="servidor-imagens">
            <label className="arquivo-botao">Ícone <input type="file" accept="image/*" onChange={(event) => escolherImagem(event, 'icone')} /><span>Escolher imagem</span></label>
            <label className="arquivo-botao">Banner <input type="file" accept="image/*" onChange={(event) => escolherImagem(event, 'banner')} /><span>Escolher imagem</span></label>
          </div>
          <button type="submit" className="modal-botao-primario" disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar servidor'}</button>
          {aviso && <p role="status">{aviso}</p>}
        </form>

        <div className="cargo-configuracao">
          <h3>Cargos</h3>
          <div className="cargo-lista">{cargos.map((cargo) => <span key={cargo.id} className="cargo-chip" style={{ color: cargo.cor }}>{cargo.nome}</span>)}</div>
          <form onSubmit={criarCargo}>
            <div className="cargo-novo-linha"><input placeholder="Nome do cargo" value={cargoNome} onChange={(event) => setCargoNome(event.target.value)} /><input type="color" value={cargoCor} onChange={(event) => setCargoCor(event.target.value)} /></div>
            <div className="cargo-permissoes">{PERMISSOES.map(([id, label]) => <label key={id}><input type="checkbox" checked={permissoes[id] === true} onChange={(event) => setPermissoes((atual) => ({ ...atual, [id]: event.target.checked }))} />{label}</label>)}</div>
            <button type="submit" className="modal-botao-primario">Criar cargo</button>
          </form>

          <div className="cargo-atribuicao">
            <h4>Atribuir cargo a membro</h4>
            <form className="cargo-atribuicao__form" onSubmit={atribuirCargo}>
              <select value={membroSelecionado} onChange={(event) => setMembroSelecionado(event.target.value)}>
                <option value="">Escolha um membro</option>
                {membros.filter((membro) => membro.papel !== 'dono').map((membro) => <option key={membro.id} value={membro.id}>{membro.nome}</option>)}
              </select>
              <select value={cargoSelecionado} onChange={(event) => setCargoSelecionado(event.target.value)}>
                <option value="">Escolha um cargo</option>
                {cargos.filter((cargo) => cargo.nome !== 'Administrador').map((cargo) => <option key={cargo.id} value={cargo.id}>{cargo.nome}</option>)}
              </select>
              <button type="submit" className="modal-botao-primario">Atribuir</button>
            </form>
            <div className="cargo-membros-lista">
              {membros.filter((membro) => membro.papel !== 'dono').map((membro) => (
                <div className="cargo-membro-linha" key={membro.id}>
                  <span>{membro.nome}</span>
                  <div>{membro.cargos?.map((cargo) => <button type="button" className="cargo-chip cargo-chip--remover" style={{ color: cargo.cor }} key={cargo.id} onClick={() => onAtribuirCargo(membro.id, cargo.id, true)} title="Remover cargo">{cargo.nome} ×</button>)}</div>
                  {(onExpulsarMembro || onBanir) && (
                    <div className="cargo-membro-acoes">
                      {onExpulsarMembro && (
                        <button type="button" className="btn-foto-remover" onClick={() => { if (window.confirm(`Expulsar ${membro.nome} do servidor?`)) onExpulsarMembro(membro.id); }}>
                          Expulsar
                        </button>
                      )}
                      {onBanir && (
                        <button type="button" className="btn-foto-remover" onClick={() => { if (window.confirm(`Banir ${membro.nome}? Ele não vai conseguir voltar, nem com um novo convite.`)) onBanir(membro.id); }}>
                          Banir
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
        {erro && <div className="modal-erro">{erro}</div>}
      </div>
    </div>
  );
}
