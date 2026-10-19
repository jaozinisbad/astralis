import React, { useEffect, useRef, useState } from 'react';
import { version } from '../../package.json';
import { applyInterfacePreferences, INTERFACE_DEFAULTS, loadInterfacePreferences, saveInterfacePreferences } from '../interfacePreferences.mjs';
import './SettingsModal.css';

const AUDIO_DEFAULTS = Object.freeze({ microfoneId: '', foneId: '', volumeEntrada: 100, volumeSaida: 100, perfilEntrada: 'isolamento', supressaoRuido: 'rnnoise', cancelamentoEco: true, ganhoAutomatico: true });
const SECTIONS = [
  { group: 'Configurações de usuário', items: [['account', 'Minha conta'], ['profile', 'Perfis'], ['privacy', 'Privacidade e segurança'], ['devices', 'Dispositivos'], ['connections', 'Conexões']] },
  { group: 'Configurações do aplicativo', items: [['appearance', 'Aparência'], ['accessibility', 'Acessibilidade'], ['voice', 'Voz e vídeo'], ['chat', 'Chat'], ['notifications', 'Notificações'], ['shortcuts', 'Atalhos do teclado'], ['advanced', 'Avançado']] },
  { group: 'Astralis', items: [['about', 'Sobre o Astralis']] },
];

function loadAudio() {
  try { return { ...AUDIO_DEFAULTS, ...JSON.parse(localStorage.getItem('configuracoesAudio') || '{}') }; }
  catch { return { ...AUDIO_DEFAULTS }; }
}

function Icon({ name, size = 20 }) {
  const paths = {
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    monitor: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></>,
    mic: <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8" /></>,
    logout: <path d="M9 4H4v16h5m5-12 5 4-5 4m-5-4h10" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Toggle({ label, description, checked, onChange }) {
  const id = React.useId();
  return <div className="as-settings-toggle"><div><label htmlFor={id}>{label}</label>{description && <p id={`${id}-help`}>{description}</p>}</div><label className="as-settings-switch"><input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} aria-describedby={description ? `${id}-help` : undefined} /><span aria-hidden="true"><svg viewBox="0 0 16 16"><path d={checked ? 'm4 8 3 3 5-6' : 'm5 5 6 6m0-6-6 6'} /></svg></span></label></div>;
}

function Section({ title, children, description }) {
  return <section className="as-settings-section"><h3>{title}</h3>{description && <p className="as-settings-description">{description}</p>}{children}</section>;
}

/** User settings, preserving the existing audio storage and callback contract. */
export default function SettingsModal({ onFechar, onSalvarConfiguracao, usuario = {}, onAbrirPerfil, onSair, initialSection = 'account' }) {
  const [section, setSection] = useState(() => SECTIONS.some((group) => group.items.some(([id]) => id === initialSection)) ? initialSection : 'account');
  const [search, setSearch] = useState('');
  const [audio, setAudio] = useState(loadAudio);
  const [prefs, setPrefs] = useState(loadInterfacePreferences);
  const [savedAudio, setSavedAudio] = useState(loadAudio);
  const [savedPrefs, setSavedPrefs] = useState(loadInterfacePreferences);
  const [devices, setDevices] = useState({ input: [], output: [] });
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [testingMic, setTestingMic] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const modalRef = useRef(null);
  const contentRef = useRef(null);
  const currentPrefs = useRef(savedPrefs);
  const microphoneRef = useRef(null);
  const dirty = JSON.stringify(audio) !== JSON.stringify(savedAudio) || JSON.stringify(prefs) !== JSON.stringify(savedPrefs);
  const name = prefs.streamerMode ? 'Usuário Astralis' : (usuario.nome || usuario.username || 'Seu perfil');
  const avatarUrl = prefs.streamerMode ? null : usuario.avatar_url;
  const bannerUrl = prefs.streamerMode ? null : usuario.banner_url;
  const avatarColor = prefs.streamerMode ? 'var(--as-accent, #9270f4)' : (usuario.avatar_cor || 'var(--as-accent, #9270f4)');
  const profileStatus = prefs.streamerMode ? 'Oculto no modo streamer' : (usuario.status || 'Disponível');
  const sectionName = SECTIONS.flatMap((group) => group.items).find(([id]) => id === section)?.[1];
  const changePref = (key, value) => { setPrefs((current) => ({ ...current, [key]: value })); setNotice(''); };
  const changeAudio = (key, value) => { setAudio((current) => ({ ...current, [key]: value })); setNotice(''); };

  useEffect(() => { currentPrefs.current = savedPrefs; }, [savedPrefs]);
  useEffect(() => { applyInterfacePreferences(prefs); }, [prefs]);
  useEffect(() => () => { applyInterfacePreferences(currentPrefs.current); }, []);
  useEffect(() => {
    const previous = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    modalRef.current?.querySelector('[data-settings-initial]')?.focus();
    function keydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); onFechar?.(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...(modalRef.current?.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]') || [])].filter((element) => element.getClientRects().length);
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || !modalRef.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !modalRef.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', keydown); previous?.focus?.(); };
  }, [onFechar]);

  useEffect(() => {
    let active = true;
    async function enumerate() {
      try {
        if (!navigator.mediaDevices?.enumerateDevices) throw new Error('Dispositivos de áudio indisponíveis neste navegador.');
        const list = await navigator.mediaDevices.enumerateDevices();
        if (active) setDevices({ input: list.filter((device) => device.kind === 'audioinput'), output: list.filter((device) => device.kind === 'audiooutput') });
      } catch (cause) { if (active) setError(cause.message); }
      finally { if (active) setLoadingDevices(false); }
    }
    enumerate(); navigator.mediaDevices?.addEventListener?.('devicechange', enumerate);
    return () => { active = false; navigator.mediaDevices?.removeEventListener?.('devicechange', enumerate); };
  }, []);

  function stopMic() {
    const session = microphoneRef.current;
    if (session) { session.active = false; if (session.frame) cancelAnimationFrame(session.frame); session.stream?.getTracks().forEach((track) => track.stop()); session.context?.close().catch(() => {}); microphoneRef.current = null; }
    setTestingMic(false); setMicLevel(0);
  }
  useEffect(() => () => {
    const session = microphoneRef.current;
    if (session) { session.active = false; if (session.frame) cancelAnimationFrame(session.frame); session.stream?.getTracks().forEach((track) => track.stop()); session.context?.close().catch(() => {}); microphoneRef.current = null; }
  }, []);
  useEffect(() => { if (section !== 'voice') stopMic(); contentRef.current?.scrollTo?.({ top: 0 }); }, [section]);

  async function testMic() {
    if (microphoneRef.current) { stopMic(); return; }
    const session = { active: true }; microphoneRef.current = session; setTestingMic(true); setError('');
    try {
      session.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: audio.microfoneId ? { exact: audio.microfoneId } : undefined, echoCancellation: audio.cancelamentoEco !== false, autoGainControl: audio.ganhoAutomatico !== false, noiseSuppression: audio.supressaoRuido !== 'desligada' }, video: false });
      if (!session.active) { session.stream.getTracks().forEach((track) => track.stop()); return; }
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      session.context = new AudioContext();
      const analyser = session.context.createAnalyser(); analyser.fftSize = 256;
      session.context.createMediaStreamSource(session.stream).connect(analyser); await session.context.resume();
      const samples = new Uint8Array(analyser.fftSize);
      function measure() { if (!session.active) return; analyser.getByteTimeDomainData(samples); const level = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length); setMicLevel(Math.min(100, Math.round(level * 350))); session.frame = requestAnimationFrame(measure); }
      measure();
    } catch (cause) { if (session.active) setError(`Não foi possível testar o microfone: ${cause.message}`); if (microphoneRef.current === session) stopMic(); }
  }

  function save() {
    let previousAudio;
    let wroteAudio = false;
    let updated;
    try {
      previousAudio = localStorage.getItem('configuracoesAudio');
      localStorage.setItem('configuracoesAudio', JSON.stringify(audio));
      wroteAudio = true;
      updated = saveInterfacePreferences(prefs);
    } catch (cause) {
      // A failed interface write must not leave audio silently changed on disk.
      if (wroteAudio) {
        try { if (previousAudio === null) localStorage.removeItem('configuracoesAudio'); else localStorage.setItem('configuracoesAudio', previousAudio); } catch { /* Preserve the original, actionable failure. */ }
      }
      setError(`Não foi possível salvar: ${cause.message}`);
      return;
    }
    setSavedAudio({ ...audio }); setSavedPrefs(updated); currentPrefs.current = updated;
    onSalvarConfiguracao?.(audio); setError(''); setNotice('Suas configurações foram salvas.');
  }
  function reset() { setAudio({ ...savedAudio }); setPrefs({ ...savedPrefs }); setError(''); setNotice('Alterações descartadas.'); }
  async function enableNotifications(checked) {
    if (!checked) { changePref('desktopNotifications', false); return; }
    if (!('Notification' in window)) { setNotice('Este navegador não oferece notificações da área de trabalho.'); return; }
    try {
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      changePref('desktopNotifications', permission === 'granted');
      if (permission !== 'granted') setNotice('Permita notificações nas configurações do sistema ou do navegador para ativar esta opção.');
    } catch { setNotice('Não foi possível solicitar permissão para notificações.'); }
  }

  function account() {
    return <><div className="as-account-card"><div className="as-account-banner" style={bannerUrl ? { backgroundImage: `url(${bannerUrl})` } : undefined}><img src="./astralis-mark.svg" alt="" /></div><div className="as-account-identity"><div className="as-account-avatar" style={{ backgroundColor: avatarColor }}>{avatarUrl ? <img src={avatarUrl} alt="" /> : name.slice(0, 1).toUpperCase()}<span /></div><strong>{name}</strong>{onAbrirPerfil && <button type="button" className="as-settings-button as-settings-button--accent" onClick={onAbrirPerfil}>Editar perfil de usuário</button>}</div><div className="as-account-fields"><div><span>NOME EXIBIDO</span><p>{name}</p></div><div><span>NOME DE USUÁRIO</span><p>{prefs.streamerMode ? 'Oculto no modo streamer' : (usuario.username || usuario.nome || 'Não informado')}</p></div><div><span>E-MAIL</span><p>{prefs.streamerMode ? 'Oculto no modo streamer' : (usuario.email || 'Não informado nesta sessão')}</p></div><div><span>STATUS</span><p>{profileStatus}</p></div></div></div><Section title="Personalize sua presença" description="Sua foto, faixa e status acompanham você nas salas e conversas do Astralis.">{onAbrirPerfil && <button type="button" className="as-settings-button" onClick={onAbrirPerfil}>Personalizar perfil</button>}</Section><Section title="Segurança da conta" description="A autenticação e a recuperação da conta continuam sendo gerenciadas pelo Astralis. Suas credenciais não são compartilhadas com outros serviços."><div className="as-settings-info"><Icon name="lock" /><p>Nunca compartilhe sua senha ou um código de recuperação.</p></div></Section>{onSair && <Section title="Sessão neste dispositivo"><button type="button" className="as-settings-button as-settings-button--danger" onClick={onSair}>Sair da conta</button></Section>}</>;
  }

  function voice() {
    return <><Section title="Configurações de voz"><div className="as-settings-columns"><label className="as-settings-field">DISPOSITIVO DE ENTRADA<select value={audio.microfoneId} onChange={(event) => changeAudio('microfoneId', event.target.value)}><option value="">Padrão do sistema</option>{devices.input.filter((device) => device.deviceId !== '').map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Microfone ${index + 1}`}</option>)}</select></label><label className="as-settings-field">DISPOSITIVO DE SAÍDA<select value={audio.foneId} onChange={(event) => changeAudio('foneId', event.target.value)}><option value="">Padrão do sistema</option>{devices.output.filter((device) => device.deviceId !== '').map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Saída ${index + 1}`}</option>)}</select></label></div>{loadingDevices && <p className="as-settings-description" role="status">Procurando dispositivos de áudio…</p>}<div className="as-settings-columns"><label className="as-settings-field">VOLUME DE ENTRADA <span>{audio.volumeEntrada}%</span><input type="range" min="0" max="200" value={audio.volumeEntrada} onChange={(event) => changeAudio('volumeEntrada', Number(event.target.value))} /></label><label className="as-settings-field">VOLUME DE SAÍDA <span>{audio.volumeSaida}%</span><input type="range" min="0" max="200" value={audio.volumeSaida} onChange={(event) => changeAudio('volumeSaida', Number(event.target.value))} /></label></div></Section><Section title="Teste de microfone" description="Veja se seu microfone está recebendo sua voz. O teste é local e não transmite áudio para ninguém."><div className="as-mic-test"><button type="button" className="as-settings-button as-settings-button--accent" onClick={testMic}><Icon name="mic" size={16} />{testingMic ? 'Parar teste' : 'Vamos verificar'}</button><div className="as-mic-meter" role="meter" aria-label="Nível do microfone" aria-valuemin={0} aria-valuemax={100} aria-valuenow={micLevel}><span style={{ width: `${micLevel}%` }} /></div></div></Section><Section title="Perfil de entrada" description="Escolha como o Astralis processa a sua voz."><div className="as-settings-radios">{[['isolamento', 'Isolamento de voz', 'Reduz teclado e ruído ambiente com RNNoise.'], ['estudio', 'Estúdio', 'Áudio sem processamento para música ou um microfone já tratado.'], ['personalizado', 'Personalizado', 'Ajuste cada processamento de áudio.']].map(([value, title, description]) => <label key={value} className={audio.perfilEntrada === value ? 'selected' : ''}><input type="radio" name="as-input-profile" checked={audio.perfilEntrada === value} onChange={() => setAudio((current) => ({ ...current, perfilEntrada: value, ...(value === 'isolamento' ? { supressaoRuido: 'rnnoise', cancelamentoEco: true, ganhoAutomatico: true } : value === 'estudio' ? { supressaoRuido: 'desligada', cancelamentoEco: false, ganhoAutomatico: false } : {}) }))} /><span><strong>{title}</strong><small>{description}</small></span></label>)}</div></Section>{audio.perfilEntrada === 'personalizado' && <Section title="Processamento de voz"><label className="as-settings-field">SUPRESSÃO DE RUÍDO<select value={audio.supressaoRuido} onChange={(event) => changeAudio('supressaoRuido', event.target.value)}><option value="rnnoise">RNNoise avançado</option><option value="nativa">Padrão do navegador</option><option value="desligada">Desligada</option></select></label><Toggle label="Cancelamento de eco" description="Evita que o áudio da chamada retorne pelo seu microfone." checked={audio.cancelamentoEco !== false} onChange={(value) => changeAudio('cancelamentoEco', value)} /><Toggle label="Controle automático de ganho" description="Equilibra o volume da sua voz durante a chamada." checked={audio.ganhoAutomatico !== false} onChange={(value) => changeAudio('ganhoAutomatico', value)} /></Section>}<Section title="Transmissão de tela" description="A qualidade é ajustada automaticamente para a conexão. As transmissões usam até 1080p a 60 FPS."><div className="as-settings-info"><Icon name="monitor" /><p>O áudio do Discord fica sempre excluído. Se não for possível isolar o áudio com segurança, a transmissão continua sem áudio.</p></div></Section><button type="button" className="as-settings-button as-settings-button--danger" onClick={() => { setAudio({ ...AUDIO_DEFAULTS }); setNotice('Padrões de voz restaurados. Salve para aplicar.'); }}>Redefinir configurações de voz</button></>;
  }

  function body() {
    switch (section) {
      case 'account': return account();
      case 'profile': return <><div className="as-profile-preview"><div className="as-account-banner" style={bannerUrl ? { backgroundImage: `url(${bannerUrl})` } : undefined} /><div className="as-profile-preview__body"><div className="as-account-avatar" style={{ backgroundColor: avatarColor }}>{avatarUrl ? <img src={avatarUrl} alt="" /> : name.slice(0, 1).toUpperCase()}</div><h3>{name}</h3><p>{profileStatus}</p><div><span>MEMBRO DO ASTRALIS</span><p>Seu espaço para conversar, jogar e assistir junto.</p></div></div></div><Section title="Perfil de usuário" description="Escolha sua foto, cor do avatar, faixa do perfil e status.">{onAbrirPerfil && <button type="button" className="as-settings-button as-settings-button--accent" onClick={onAbrirPerfil}>Editar perfil</button>}</Section></>;
      case 'privacy': return <><Section title="Sua privacidade"><Toggle label="Modo streamer" description="Oculta os dados de perfil nestas configurações e na barra de usuário e silencia os avisos de novas mensagens. Outras telas podem continuar mostrando nomes e conteúdo das conversas." checked={prefs.streamerMode} onChange={(value) => changePref('streamerMode', value)} /></Section><Section title="Conteúdo das conversas"><Toggle label="Mostrar prévias de mídia" description="Exibe imagens e vídeos compartilhados no chat. Desative para ver apenas os links." checked={prefs.mediaPreviews} onChange={(value) => changePref('mediaPreviews', value)} /></Section><div className="as-settings-info"><Icon name="lock" /><p>Salas privadas continuam exigindo convite. Estas preferências ficam somente neste dispositivo e não alteram as permissões das suas salas.</p></div></>;
      case 'devices': return <><Section title="Dispositivo atual" description="Você está usando o Astralis neste dispositivo."><div className="as-device-card"><Icon name="monitor" size={36} /><div><strong>{window.electronAPI ? 'Astralis para computador' : 'Astralis no navegador'}</strong><p>{navigator.userAgent.includes('Windows') ? 'Windows' : navigator.userAgent.includes('Mac') ? 'macOS' : 'Navegador'} · Este dispositivo</p><span className="as-settings-status">Em uso agora</span></div></div></Section><Section title="Outras sessões" description="O Astralis ainda não oferece uma lista de sessões remotas ou encerramento de sessão em outros dispositivos." /></>;
      case 'connections': return <><div className="as-settings-empty"><img src="./astralis-mark.svg" alt="Astralis" /><h3>Suas conexões, no seu espaço</h3><p>O Astralis usa a própria conta. Integrações de perfil com Discord, Spotify, Steam e outros serviços ainda não estão disponíveis.</p></div><Section title="Assistir junto" description="Compartilhe um vídeo do YouTube nas salas do Astralis. Não é necessário conectar uma conta do YouTube." /></>;
      case 'appearance': return <><Section title="Tema" description="Escolha o visual do seu Astralis."><div className="as-theme-options">{[['dark', 'Escuro'], ['light', 'Claro'], ['midnight', 'Meia-noite']].map(([value, title]) => <label key={value} className={`as-theme-option as-theme-option--${value}${prefs.theme === value ? ' selected' : ''}`}><input type="radio" name="as-theme" checked={prefs.theme === value} onChange={() => changePref('theme', value)} /><span className="as-theme-preview"><i /><i /><i /><i /></span><strong>{title}</strong><span className="as-radio-dot" /></label>)}</div></Section><Section title="Exibição de mensagens"><div className="as-settings-radios">{[['default', 'Confortável', 'Espaço equilibrado entre as mensagens.'], ['compact', 'Compacto', 'Mais conversa em menos espaço.'], ['spacious', 'Espaçoso', 'Dê mais espaço a cada mensagem.']].map(([value, title, description]) => <label key={value} className={prefs.density === value ? 'selected' : ''}><input type="radio" name="as-density" checked={prefs.density === value} onChange={() => changePref('density', value)} /><span><strong>{title}</strong><small>{description}</small></span></label>)}</div></Section><Section title="Tamanho da fonte do chat"><label className="as-settings-field">TAMANHO: {prefs.fontSize} PX<input type="range" min="14" max="20" step="1" value={prefs.fontSize} onChange={(event) => changePref('fontSize', Number(event.target.value))} /><span className="as-settings-range-labels"><span>14 px</span><span>16 px</span><span>20 px</span></span></label><div className="as-message-preview" style={{ fontSize: `${prefs.fontSize}px` }}><div className="as-message-preview__avatar">A</div><div><strong>Astralis <time>Hoje às 19:30</time></strong><p>Um lugar para reunir a sua galera. 💜</p></div></div></Section></>;
      case 'accessibility': return <><Section title="Visual"><Toggle label="Alto contraste" description="Aumenta o contraste dos textos, contornos e controles." checked={prefs.highContrast} onChange={(value) => changePref('highContrast', value)} /><Toggle label="Reduzir movimento" description="Desativa animações e transições da interface." checked={prefs.reducedMotion} onChange={(value) => changePref('reducedMotion', value)} /></Section><Section title="Leitura das conversas"><Toggle label="Mostrar avatares" description="Exibe as fotos de quem participa da conversa." checked={prefs.showAvatars} onChange={(value) => changePref('showAvatars', value)} /><Toggle label="Mostrar horários" description="Exibe o horário de envio ao lado das mensagens." checked={prefs.showTimestamps} onChange={(value) => changePref('showTimestamps', value)} /></Section><Section title="Navegação por teclado" description="Use Tab para mover o foco e Enter ou Espaço para ativar um controle. Pressione Esc para fechar as configurações." /></>;
      case 'voice': return voice();
      case 'chat': return <><Section title="Como enviar mensagens"><Toggle label="Enviar mensagem com Enter" description="Quando ativado, Shift + Enter adiciona uma linha. Quando desativado, use Ctrl + Enter ou o botão de enviar." checked={prefs.enterToSend} onChange={(value) => changePref('enterToSend', value)} /></Section><Section title="Conteúdo e visualização"><Toggle label="Mostrar prévias de mídia" description="Exibe imagens e vídeos recebidos diretamente na conversa." checked={prefs.mediaPreviews} onChange={(value) => changePref('mediaPreviews', value)} /><Toggle label="Mostrar avatares nas mensagens" checked={prefs.showAvatars} onChange={(value) => changePref('showAvatars', value)} /><Toggle label="Mostrar horários das mensagens" checked={prefs.showTimestamps} onChange={(value) => changePref('showTimestamps', value)} /></Section></>;
      case 'notifications': return <><Section title="Notificações da área de trabalho"><Toggle label="Ativar notificações da área de trabalho" description="Receba um aviso quando chegar uma mensagem enquanto o Astralis estiver em segundo plano. Sua permissão será solicitada ao ativar." checked={prefs.desktopNotifications} onChange={enableNotifications} /></Section><Section title="Sons"><Toggle label="Som de mensagem recebida" description="Reproduz um aviso suave para novas mensagens enquanto o aplicativo está em segundo plano." checked={prefs.notificationSound} onChange={(value) => changePref('notificationSound', value)} /></Section><div className="as-settings-info"><Icon name="lock" /><p>O modo streamer silencia os avisos de novas mensagens. Você pode ativá-lo em Privacidade e segurança.</p></div></>;
      case 'shortcuts': return <><p className="as-settings-description">Navegue e converse sem tirar as mãos do teclado.</p><div className="as-shortcut-table">{[['Fechar configurações ou janela de diálogo', ['Esc']], ['Ir para o próximo controle', ['Tab']], ['Voltar ao controle anterior', ['Shift', 'Tab']], [prefs.enterToSend ? 'Enviar mensagem' : 'Inserir nova linha', ['Enter']], [prefs.enterToSend ? 'Inserir nova linha' : 'Enviar mensagem', prefs.enterToSend ? ['Shift', 'Enter'] : ['Ctrl', 'Enter']]].map(([title, keys]) => <div key={title}><span>{title}</span><span>{keys.map((key) => <kbd key={key}>{key}</kbd>)}</span></div>)}</div><p className="as-settings-description">Atalhos globais personalizados ainda não estão disponíveis. Os atalhos acima funcionam com a janela do Astralis em foco.</p></>;
      case 'advanced': return <><Section title="Opções de desenvolvimento"><Toggle label="Modo desenvolvedor" description="Exibe identificadores de mensagens para facilitar o suporte e a investigação de problemas." checked={prefs.developerMode} onChange={(value) => changePref('developerMode', value)} /></Section><Section title="Preferências locais" description="Restaure somente as preferências de aparência, acessibilidade, chat e notificações deste dispositivo. Sua conta, conversas e configurações de voz são mantidas."><button type="button" className="as-settings-button" onClick={() => { setPrefs({ ...INTERFACE_DEFAULTS }); setNotice('Preferências restauradas. Salve para aplicar.'); }}>Restaurar preferências da interface</button></Section><Section title="Atualizações" description="O Astralis avisa quando existe uma nova versão. O download e a instalação dependem da sua ação na faixa de atualização do aplicativo." /></>;
      case 'about': return <><div className="as-about-brand"><img src="./astralis-mark.svg" alt="Astralis" /><h3>Astralis</h3><p>Converse. Jogue. Compartilhe.</p><span>Versão {version}</span></div><Section title="Feito para a sua galera" description="Salas, conversas, voz e transmissões em um só lugar. O Astralis tem sua própria conta e sua própria infraestrutura de comunicação." /><Section title="Tecnologias"><dl className="as-settings-facts"><div><dt>Interface</dt><dd>React</dd></div><div><dt>Comunicação em tempo real</dt><dd>WebRTC e Socket.IO</dd></div><div><dt>Aplicativo para computador</dt><dd>Electron</dd></div></dl></Section></>;
      default: return null;
    }
  }

  const filtered = SECTIONS.map((group) => ({ ...group, items: group.items.filter(([, title]) => title.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR').trim())) })).filter((group) => group.items.length);
  return <div className="as-settings" role="dialog" aria-modal="true" aria-labelledby="as-settings-title" ref={modalRef}><div className="as-settings-sidebar-wrap"><aside className="as-settings-sidebar"><label className="as-settings-search"><span className="as-sr-only">Buscar configurações</span><input data-settings-initial type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar" /><Icon name="search" size={17} /></label><nav aria-label="Categorias de configurações">{filtered.map((group) => <div className="as-settings-nav-group" key={group.group}><h3>{group.group}</h3>{group.items.map(([id, title]) => <button type="button" key={id} className={section === id ? 'selected' : ''} aria-current={section === id ? 'page' : undefined} onClick={() => { setSection(id); setNotice(''); }}>{title}</button>)}</div>)}{!filtered.length && <p className="as-settings-search-empty">Nenhuma configuração encontrada.</p>}</nav>{onSair && <button type="button" className="as-settings-logout" onClick={onSair}>Sair <Icon name="logout" size={18} /></button>}<div className="as-settings-sidebar-brand"><img src="./astralis-mark.svg" alt="" /><span>Astralis <small>{version}</small></span></div></aside></div><main className="as-settings-content" ref={contentRef}><div className="as-settings-content-inner"><h2 id="as-settings-title">{sectionName}</h2>{error && <div className="as-settings-alert" role="alert">{error}</div>}{notice && <div className="as-settings-notice" role="status">{notice}</div>}{body()}</div><div className="as-settings-close"><button type="button" onClick={onFechar} aria-label="Fechar configurações"><Icon name="close" size={24} /></button><span>ESC</span></div></main>{dirty && <div className="as-settings-savebar" role="status"><span>Cuidado! Você tem alterações não salvas.</span><div><button type="button" onClick={reset}>Redefinir</button><button type="button" className="as-settings-button as-settings-button--save" onClick={save}>Salvar alterações</button></div></div>}</div>;
}
