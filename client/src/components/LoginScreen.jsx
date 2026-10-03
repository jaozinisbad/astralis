import React, { useEffect, useState } from 'react';
import { SERVER_URL } from '../api.js';

export default function LoginScreen({ onAutenticado }) {
  const [modo, setModo] = useState('login');
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [codigo, setCodigo] = useState('');
  const [novaSenha, setNovaSenha] = useState('');
  const [confirmarSenha, setConfirmarSenha] = useState('');
  const [erro, setErro] = useState('');
  const [sucesso, setSucesso] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [demorando, setDemorando] = useState(false);

  useEffect(() => {
    // Uma chamada por abertura da tela, sem polling para manter o servidor ativo.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    fetch(`${SERVER_URL}/health`, { signal: controller.signal })
      .catch(() => {})
      .finally(() => clearTimeout(timeout));
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!carregando) {
      setDemorando(false);
      return;
    }
    const timeout = setTimeout(() => setDemorando(true), 4000);
    return () => clearTimeout(timeout);
  }, [carregando]);

  async function enviar(event) {
    event.preventDefault();
    setErro('');
    setCarregando(true);

    const cadastro = modo === 'cadastro';
    const recuperacao = modo === 'recuperacao';
    if (recuperacao && novaSenha !== confirmarSenha) {
      setErro('As senhas não coincidem.');
      setCarregando(false);
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      const endpoint = recuperacao ? '/api/redefinir-senha' : cadastro ? '/api/cadastro' : '/api/login';
      const resposta = await fetch(`${SERVER_URL}${endpoint}`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(recuperacao
          ? { email, codigo, novaSenha }
          : cadastro ? { nome, email, senha } : { email, senha }),
      });
      const dados = await resposta.json();
      if (!resposta.ok) {
        setErro(dados.erro || 'Não foi possível concluir. Tente novamente.');
        return;
      }
      if (recuperacao) {
        setModo('login');
        setSenha('');
        setCodigo('');
        setNovaSenha('');
        setConfirmarSenha('');
        setSucesso('Senha redefinida com sucesso. Faça login com sua nova senha.');
      } else {
        onAutenticado(dados.token, dados.usuario);
      }
    } catch (error) {
      setErro(error.name === 'AbortError'
        ? 'O servidor demorou para responder. Tente novamente em alguns instantes.'
        : 'Não foi possível conectar ao servidor. Confira sua internet e tente novamente.');
    } finally {
      clearTimeout(timeout);
      setCarregando(false);
    }
  }

  function alternarModo() {
    setModo((atual) => atual === 'login' ? 'cadastro' : 'login');
    setErro('');
    setSucesso('');
  }

  function abrirRecuperacao() {
    setModo('recuperacao');
    setErro('');
    setSucesso('');
    setSenha('');
  }

  function voltarLogin() {
    setModo('login');
    setErro('');
    setSucesso('');
    setCodigo('');
    setNovaSenha('');
    setConfirmarSenha('');
  }

  const cadastro = modo === 'cadastro';
  const recuperacao = modo === 'recuperacao';

  return (
    <main className="auth-shell">
      <div className="auth-glow auth-glow--one" aria-hidden="true" />
      <div className="auth-glow auth-glow--two" aria-hidden="true" />

      <div className="auth-layout">
        <aside className="auth-story" aria-label="Sobre o Astralis">
          <div className="auth-brand">
            <img className="auth-brand__mark" src="./astralis-mark.svg" alt="" />
            <span>ASTRALIS</span>
          </div>
          <div className="auth-story__copy">
            <span className="auth-eyebrow"><span aria-hidden="true" /> SUA TELA, SUA SALA</span>
            <h2>Transmita sua tela. <span>Compartilhe o momento.</span></h2>
            <p>Crie uma sala para transmitir. Quem estiver no celular acompanha pelo navegador.</p>
            <div className="auth-highlights" aria-label="Recursos do Astralis">
              <span>Salas ao vivo</span>
              <span>Convites privados</span>
              <span>Transmissão de tela</span>
            </div>
          </div>
        </aside>

      <section className="auth-card" aria-labelledby="auth-form-title">
        <div className="auth-brand">
          <img className="auth-brand__mark" src="./astralis-mark.svg" alt="" />
          <span>ASTRALIS</span>
        </div>

        <div className="auth-card__heading">
          <h1 id="auth-form-title">{cadastro ? 'Criar conta' : recuperacao ? 'Recuperar senha' : 'Entrar'}</h1>
          {recuperacao && <p>Peça ao suporte o e-mail da sua conta e um código temporário.</p>}
        </div>

        <form className="auth-form" onSubmit={enviar}>
          {cadastro && (
            <label className="auth-field">
              <span>Nome</span>
              <input
                type="text"
                name="name"
                placeholder="Seu nome"
                autoComplete="name"
                maxLength={32}
                value={nome}
                onChange={(event) => setNome(event.target.value)}
                required
                disabled={carregando}
              />
            </label>
          )}
          <label className="auth-field">
            <span>E-mail</span>
            <input
              type="email"
              name="email"
              placeholder="voce@exemplo.com"
              autoComplete="email"
              autoCapitalize="none"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              disabled={carregando}
            />
          </label>
          {recuperacao ? <>
            <label className="auth-field">
              <span>Código de recuperação</span>
              <input type="text" name="codigo" placeholder="Código enviado pelo suporte" autoComplete="one-time-code" value={codigo} onChange={(event) => setCodigo(event.target.value)} required disabled={carregando} />
            </label>
            <label className="auth-field">
              <span>Nova senha</span>
              <input type="password" name="novaSenha" placeholder="Crie uma nova senha" autoComplete="new-password" minLength={8} maxLength={128} value={novaSenha} onChange={(event) => setNovaSenha(event.target.value)} required disabled={carregando} />
            </label>
            <label className="auth-field">
              <span>Confirmar nova senha</span>
              <input type="password" name="confirmarSenha" placeholder="Digite a nova senha novamente" autoComplete="new-password" minLength={8} maxLength={128} value={confirmarSenha} onChange={(event) => setConfirmarSenha(event.target.value)} required disabled={carregando} />
            </label>
          </> : <label className="auth-field">
            <span>Senha</span>
            <input
              type="password"
              name="password"
              placeholder="Sua senha"
              autoComplete={cadastro ? 'new-password' : 'current-password'}
              minLength={cadastro ? 6 : undefined}
              value={senha}
              onChange={(event) => setSenha(event.target.value)}
              required
              disabled={carregando}
            />
          </label>}

          {erro && <div className="auth-error" role="alert">{erro}</div>}
          {sucesso && <div className="auth-success" role="status">{sucesso}</div>}

          {carregando && demorando && (
            <p role="status">A conexão está demorando. O servidor pode estar iniciando após um período sem uso. Aguarde mais alguns instantes.</p>
          )}

          <button className="auth-submit" type="submit" disabled={carregando}>
            {carregando ? 'Aguarde…' : cadastro ? 'Criar conta' : recuperacao ? 'Redefinir senha' : 'Entrar'}
          </button>
        </form>

        {recuperacao ? <div className="auth-switch"><button type="button" onClick={voltarLogin} disabled={carregando}>Voltar ao login</button></div> : <>
          {!cadastro && <div className="auth-switch"><button type="button" onClick={abrirRecuperacao} disabled={carregando}>Esqueceu a senha?</button></div>}
          <div className="auth-switch">
            <span>{cadastro ? 'Já tem uma conta?' : 'Não tem uma conta?'}</span>
            <button type="button" onClick={alternarModo} disabled={carregando}>
              {cadastro ? 'Entrar' : 'Criar conta'}
            </button>
          </div>
        </>}
      </section>
      </div>
    </main>
  );
}
