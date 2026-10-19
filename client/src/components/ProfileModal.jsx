import React, { useRef, useState } from 'react';
import Avatar from './Avatar.jsx';
import { useDialogFocus } from '../useDialogFocus.mjs';

const CORES_AVATAR = ['#f06449', '#e0a458', '#43aa8b', '#4d96ff', '#7b61ff', '#e85d9e'];

export default function ProfileModal({ usuario, onFechar, onSalvar }) {
  const [nome, setNome] = useState(usuario.nome);
  const [status, setStatus] = useState(usuario.status || 'Disponível');
  const [avatarCor, setAvatarCor] = useState(usuario.avatar_cor || '#5865f2');
  const [avatarUrl, setAvatarUrl] = useState(usuario.avatar_url || null);
  const [bannerUrl, setBannerUrl] = useState(usuario.banner_url || null);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  const inputFotoRef = useRef(null);
  const inputBannerRef = useRef(null);
  const dialogRef = useDialogFocus(onFechar, { initialFocus: '[data-profile-name]' });

  async function comprimirFoto(arquivo) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const size = 256; // 256x256px
          canvas.width = size;
          canvas.height = size;

          const ctx = canvas.getContext('2d');
          // Desenha a imagem cortada em quadrado
          const minDim = Math.min(img.width, img.height);
          const sx = (img.width - minDim) / 2;
          const sy = (img.height - minDim) / 2;
          ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size);

          // Comprime com qualidade baixa
          canvas.toBlob((blob) => {
            if (!blob) {
              reject(new Error('Erro ao comprimir foto'));
              return;
            }
            const reader2 = new FileReader();
            reader2.onload = (e2) => resolve(e2.target.result);
            reader2.readAsDataURL(blob);
          }, 'image/jpeg', 0.6);
        };
        img.onerror = () => reject(new Error('Erro ao carregar imagem'));
        img.src = event.target.result;
      };
      reader.onerror = () => reject(new Error('Erro ao ler arquivo'));
      reader.readAsDataURL(arquivo);
    });
  }

  async function selecionarFoto() {
    const arquivo = inputFotoRef.current?.files?.[0];
    if (!arquivo) return;

    try {
      setErro('');
      // Valida tipo
      if (!arquivo.type.startsWith('image/')) {
        setErro('Selecione uma imagem válida');
        return;
      }
      // Valida tamanho (máximo 5MB original)
      if (arquivo.size > 5 * 1024 * 1024) {
        setErro('Imagem muito grande (máximo 5MB)');
        return;
      }

      const base64 = await comprimirFoto(arquivo);
      setAvatarUrl(base64);
    } catch (err) {
      setErro(err.message);
    }
  }

  async function selecionarBanner() {
    const arquivo = inputBannerRef.current?.files?.[0];
    if (!arquivo) return;
    try {
      if (!arquivo.type.startsWith('image/')) throw new Error('Selecione uma imagem válida.');
      if (arquivo.size > 5 * 1024 * 1024) throw new Error('Imagem muito grande (máximo 5MB).');
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = 900;
            canvas.height = 260;
            const ctx = canvas.getContext('2d');
            const escala = Math.max(canvas.width / img.width, canvas.height / img.height);
            const largura = img.width * escala;
            const altura = img.height * escala;
            ctx.drawImage(img, (canvas.width - largura) / 2, (canvas.height - altura) / 2, largura, altura);
            canvas.toBlob((blob) => {
              if (!blob) return reject(new Error('Erro ao comprimir banner.'));
              const readerFinal = new FileReader();
              readerFinal.onload = () => resolve(readerFinal.result);
              readerFinal.readAsDataURL(blob);
            }, 'image/jpeg', 0.72);
          };
          img.onerror = () => reject(new Error('Erro ao carregar imagem.'));
          img.src = event.target.result;
        };
        reader.onerror = () => reject(new Error('Erro ao ler arquivo.'));
        reader.readAsDataURL(arquivo);
      });
      setBannerUrl(base64);
      setErro('');
    } catch (err) {
      setErro(err.message);
    }
  }

  function removerFoto() {
    setAvatarUrl(null);
    if (inputFotoRef.current) {
      inputFotoRef.current.value = '';
    }
  }

  async function salvar(event) {
    event.preventDefault();
    setErro('');
    setSalvando(true);
    try {
      const dados = { nome: nome.trim(), status: status.trim(), avatar_cor: avatarCor };
      if (avatarUrl) {
        dados.avatar_url = avatarUrl;
      }
      dados.banner_url = bannerUrl;
      await onSalvar(dados);
      onFechar();
    } catch (err) {
      setErro(err.message);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onFechar}>
      <form className="modal profile-modal" role="dialog" aria-modal="true" aria-labelledby="astralis-profile-title" ref={dialogRef} tabIndex={-1} onClick={(event) => event.stopPropagation()} onSubmit={salvar}>
        <div className="profile-modal__heading">
          <div>
            <span className="eyebrow">Perfil principal</span>
            <h2 id="astralis-profile-title">Personalize seu perfil</h2>
          </div>
          <div className="profile-modal__preview">
            <div className="profile-banner-preview" style={bannerUrl ? { backgroundImage: `url(${bannerUrl})` } : undefined} />
            <Avatar nome={nome} avatarUrl={avatarUrl} avatarCor={avatarCor} tamanho="lg" />
          </div>
        </div>

        <div className="profile-field">
          Faixa do perfil
          <div className="profile-foto-acoes">
            <input ref={inputBannerRef} type="file" accept="image/*" onChange={selecionarBanner} style={{ display: 'none' }} />
            <button type="button" onClick={() => inputBannerRef.current?.click()} className="btn-foto-upload">
              {bannerUrl ? 'Trocar faixa' : 'Adicionar faixa'}
            </button>
            {bannerUrl && <button type="button" onClick={() => { setBannerUrl(null); inputBannerRef.current.value = ''; }} className="btn-foto-remover">Remover faixa</button>}
          </div>
        </div>

        <label className="profile-field">
          Nome exibido
          <input className="modal-input" data-profile-name maxLength="32" value={nome} onChange={(event) => setNome(event.target.value)} autoFocus />
        </label>

        <label className="profile-field">
          Status
          <input className="modal-input" maxLength="80" placeholder="Disponível" value={status} onChange={(event) => setStatus(event.target.value)} />
        </label>

        <div className="profile-field">
          Foto de Perfil
          <div className="profile-foto-acoes">
            <input
              ref={inputFotoRef}
              type="file"
              accept="image/*"
              onChange={selecionarFoto}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              onClick={() => inputFotoRef.current?.click()}
              className="btn-foto-upload"
            >
              {avatarUrl ? 'Trocar foto' : 'Adicionar foto'}
            </button>
            {avatarUrl && (
              <button
                type="button"
                onClick={removerFoto}
                className="btn-foto-remover"
              >
                Remover foto
              </button>
            )}
          </div>
        </div>

        <div className="profile-field">
          Cor do avatar
          <div className="profile-colors">
            {CORES_AVATAR.map((cor) => (
              <button
                key={cor}
                type="button"
                className={`profile-color${avatarCor === cor ? ' selected' : ''}`}
                style={{ background: cor }}
                aria-label={`Selecionar cor ${cor}`}
                aria-pressed={avatarCor === cor}
                onClick={() => setAvatarCor(cor)}
              />
            ))}
          </div>
        </div>

        {erro && <div className="modal-erro" role="alert">{erro}</div>}
        <div className="modal-acoes">
          <button type="button" onClick={onFechar} className="modal-botao-secundario">
            Cancelar
          </button>
          <button type="submit" disabled={salvando} className="modal-botao-primario">
            {salvando ? 'Salvando...' : 'Salvar perfil'}
          </button>
        </div>
      </form>
    </div>
  );
}
