import React, { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';

export function SocialIcon({ name, size = 22 }) {
  const paths = {
    friends: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87" /><circle cx="9" cy="7" r="4" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
    message: <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    hash: <path d="M4 9h16M3 15h16M10 3 6 21M18 3l-4 18" />,
    sound: <><path d="m11 5-6 4H2v6h3l6 4V5Z" /><path d="M16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14" /></>,
    plus: <><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></>,
    send: <path d="m22 2-7 20-4-9-9-4L22 2ZM22 2 11 13" />,
    delete: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H4v13h4" /></>,
    file: <path d="M14 2H4v20h16V8l-6-6ZM14 2v6h6M8 15h8M8 18h5" />,
    id: <path d="M9 4 5 20M19 4l-4 16M3 9h18M1 15h18" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.message}</svg>;
}

export const sameSocialId = (a, b) => a != null && b != null && String(a) === String(b);

export function mergeSocialMessages(history, live) {
  const unique = new Map();
  [...history, ...live].forEach((message) => unique.set(String(message.id), message));
  return [...unique.values()].sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em) || Number(a.id) - Number(b.id));
}

export function useSocialNotifications(preferences) {
  const prefs = useRef(preferences);
  prefs.current = preferences;
  const audio = useRef(null);
  useEffect(() => () => { audio.current?.close?.().catch?.(() => {}); audio.current = null; }, []);
  return (title, message) => {
    if (!globalThis.document?.hidden) return;
    const current = prefs.current;
    if (current.streamerMode) return;
    if (current.desktopNotifications && globalThis.Notification?.permission === 'granted') {
      try {
        const notification = new Notification(current.streamerMode ? 'Astralis' : title, {
          body: current.streamerMode ? 'Você recebeu uma nova mensagem.' : message || 'Novo anexo recebido.',
          icon: './astralis-mark.svg',
        });
        notification.onclick = () => { globalThis.window?.focus?.(); notification.close(); };
      } catch { /* Desktop support can be unavailable. */ }
    }
    if (current.notificationSound) {
      const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Audio) return;
      try {
        const context = audio.current ||= new Audio();
        if (context.state === 'suspended') void context.resume().catch(() => {});
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.frequency.setValueAtTime(660, context.currentTime);
        oscillator.frequency.setValueAtTime(880, context.currentTime + 0.08);
        gain.gain.setValueAtTime(0.06, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.22);
        oscillator.start(); oscillator.stop(context.currentTime + 0.23);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      } catch { /* Browsers may require a user gesture before sound. */ }
    }
  };
}

function formattedTime(value, options) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('pt-BR', options);
}

export function SocialMessageList({ messages, preferences, resolveAuthor, canDelete, onDelete, endRef, emptyTitle, emptyDescription }) {
  const [copyState, setCopyState] = useState('');
  const [copyError, setCopyError] = useState('');
  useEffect(() => { setCopyState(''); setCopyError(''); }, [messages]);
  async function copy(message, idOnly = false) {
    try {
      if (!globalThis.navigator?.clipboard?.writeText) throw new Error('A cópia não está disponível neste navegador. Selecione o texto da mensagem para copiá-lo.');
      await navigator.clipboard.writeText(idOnly ? String(message.id) : message.conteudo || message.anexo_nome || '');
      setCopyState(String(message.id)); setCopyError('');
    } catch (error) { setCopyError(error.message || 'Não foi possível copiar a mensagem.'); }
  }
  return <div className="social-message-list" role="log" aria-label="Mensagens da conversa" aria-live="polite">
    {copyError && <p className="social-feedback social-feedback--error" role="alert">{copyError}</p>}
    {!messages.length && <div className="social-chat-intro"><span className="social-chat-intro__icon"><SocialIcon name="hash" size={38} /></span><h1>{emptyTitle}</h1><p>{emptyDescription}</p></div>}
    {messages.map((message, index) => {
      const author = resolveAuthor(message);
      const name = preferences.streamerMode ? 'Usuário' : author.name || 'Usuário';
      const day = formattedTime(message.criado_em, { day: 'numeric', month: 'long', year: 'numeric' });
      const previousDay = index > 0 && formattedTime(messages[index - 1].criado_em, { day: 'numeric', month: 'long', year: 'numeric' });
      return <React.Fragment key={message.id}>
        {day && day !== previousDay && <div className="social-message-date"><span>{day}</span></div>}
        <article className="social-message" data-message-id={message.id}>
          <div className="social-message__avatar"><Avatar nome={name} avatarUrl={preferences.streamerMode ? null : author.avatarUrl} avatarCor={author.avatarColor || 'var(--as-accent)'} /></div>
          <div className="social-message__body">
            <header className="social-message__meta"><strong>{name}</strong><time className="hora" dateTime={message.criado_em} title={formattedTime(message.criado_em, { dateStyle: 'full', timeStyle: 'short' })}>{formattedTime(message.criado_em, { hour: '2-digit', minute: '2-digit' })}</time></header>
            {preferences.streamerMode ? <p className="social-message__private">Conteúdo oculto no modo streamer</p> : <>
              {message.conteudo && <p className="social-message__text">{message.conteudo}</p>}
              {message.anexo_url && <div className="chat-anexo social-message__attachment">
                {preferences.mediaPreviews && message.anexo_tipo?.startsWith('image/') && <a href={message.anexo_url} download={message.anexo_nome || 'imagem'} tabIndex={-1} aria-hidden="true"><img src={message.anexo_url} alt={message.anexo_nome || 'Imagem enviada'} loading="lazy" /></a>}
                <a className="social-file" href={message.anexo_url} download={message.anexo_nome || 'arquivo'}><SocialIcon name="file" size={24} /><span>{message.anexo_nome || 'Baixar arquivo'}{message.anexo_tamanho > 0 && <small>{Math.ceil(message.anexo_tamanho / 1024)} KB</small>}</span></a>
              </div>}
            </>}
          </div>
          <div className="social-message__tools" aria-label="Ações da mensagem">
            {!preferences.streamerMode && <button type="button" onClick={() => void copy(message)} title={copyState === String(message.id) ? 'Copiado' : 'Copiar mensagem'} aria-label="Copiar mensagem"><SocialIcon name="copy" size={17} /></button>}
            {preferences.developerMode && <button type="button" onClick={() => void copy(message, true)} title="Copiar ID da mensagem" aria-label="Copiar ID da mensagem"><SocialIcon name="id" size={17} /></button>}
            {canDelete?.(message) && <button type="button" className="social-message__delete" onClick={() => onDelete(message.id)} title="Apagar mensagem" aria-label="Apagar mensagem"><SocialIcon name="delete" size={17} /></button>}
          </div>
        </article>
      </React.Fragment>;
    })}
    <div ref={endRef} />
  </div>;
}

export function SocialComposer({ value, onChange, onSubmit, placeholder, preferences, sending, error, attachment, onAttachment, onRemoveAttachment, inputRef, connected = true }) {
  const field = useRef(null);
  useEffect(() => {
    if (!field.current?.style) return;
    field.current.style.height = 'auto';
    field.current.style.height = `${Math.min(field.current.scrollHeight, 180)}px`;
  }, [value]);
  return <div className="social-composer-wrap">
    {error && <p className="social-feedback social-feedback--error" role="alert">{error}</p>}
    {!connected && <p className="social-feedback" role="status">Sem conexão. Sua mensagem permanece como rascunho.</p>}
    {attachment && <div className="social-composer__attachment"><SocialIcon name="file" /><span>{attachment.name}<small>{Math.ceil(attachment.size / 1024)} KB</small></span><button type="button" aria-label="Remover anexo" disabled={sending} onClick={onRemoveAttachment}><SocialIcon name="close" size={18} /></button></div>}
    <form className="social-composer" onSubmit={onSubmit}>
      {onAttachment && <><button type="button" className="social-composer__attach" onClick={() => inputRef.current?.click()} disabled={sending} title="Anexar imagem ou arquivo (até 5 MB)" aria-label="Anexar imagem ou arquivo"><SocialIcon name="plus" size={24} /></button><input ref={inputRef} type="file" hidden onChange={onAttachment} /></>}
      <textarea ref={field} rows={1} className="social-composer__field" aria-label={placeholder} placeholder={placeholder} value={value} disabled={sending} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => {
        if (event.key !== 'Enter' || sending || event.isComposing || event.nativeEvent?.isComposing) return;
        if (!event.shiftKey && (preferences.enterToSend || event.ctrlKey || event.metaKey)) { event.preventDefault(); onSubmit(event); }
      }} />
      <button className="social-composer__send" type="submit" disabled={sending || !connected || (!value.trim() && !attachment)} title={sending ? 'Aguardando confirmação do servidor' : 'Enviar mensagem'} aria-label="Enviar mensagem"><SocialIcon name="send" size={21} /></button>
    </form>
    <div className="social-composer__hint">{sending ? 'Enviando mensagem…' : preferences.enterToSend ? <><strong>Shift + Enter</strong> para uma nova linha</> : <><strong>Ctrl + Enter</strong> ou o botão <strong>Enviar</strong> para enviar</>}</div>
  </div>;
}
