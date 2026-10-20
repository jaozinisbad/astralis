import React, { useEffect } from 'react';
import Avatar from './Avatar.jsx';
import { CallIcon } from './VoiceCallStage.jsx';
import { useInterfacePreferences } from '../interfacePreferences.mjs';
import { useDialogFocus } from '../useDialogFocus.mjs';
import { useSocialNotifications } from './SocialMessageParts.jsx';
import './DirectCallNotice.css';

export default function DirectCallNotice({ call, incoming, pending, error, onAccept, onEnd }) {
  const [preferences] = useInterfacePreferences();
  const ref = useDialogFocus(onEnd);
  const friend = incoming ? call.caller : call.callee;
  const name = preferences.streamerMode ? 'Amigo' : friend.nome;
  const notify = useSocialNotifications(preferences);
  useEffect(() => {
    if (incoming) notify(name, 'Está ligando para você no Astralis.');
  }, [call.id]);
  return <div className="direct-call-overlay">
    <section className="direct-call-notice" role="dialog" aria-modal="true" aria-labelledby="direct-call-heading" ref={ref} tabIndex={-1}>
      <img className="direct-call-notice__brand" src="./astralis-mark.svg" alt="" />
      <Avatar nome={name} avatarUrl={preferences.streamerMode ? null : friend.avatar_url} avatarCor={friend.avatar_cor || '#9270f4'} tamanho="xl" />
      <h1 id="direct-call-heading">{name}</h1>
      <p role="status">{incoming ? 'Chamada de voz recebida' : 'Chamando…'}</p>
      <small>Converse e compartilhe sua tela nesta chamada privada.</small>
      {error && <p className="direct-call-notice__error" role="alert">{error}</p>}
      <div className="direct-call-notice__actions">
        <button type="button" className="direct-call-notice__decline" onClick={onEnd} aria-label={incoming ? 'Recusar chamada' : 'Cancelar chamada'}><CallIcon name="disconnect" /><span>{incoming ? 'Recusar' : 'Cancelar'}</span></button>
        {incoming && <button type="button" data-dialog-initial className="direct-call-notice__accept" onClick={onAccept} disabled={pending}><CallIcon name="phone" /><span>{pending ? 'Atendendo…' : 'Atender'}</span></button>}
      </div>
    </section>
  </div>;
}
