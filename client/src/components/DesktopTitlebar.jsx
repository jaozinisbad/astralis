import React, { useEffect, useState } from 'react';

export default function DesktopTitlebar() {
  const [title, setTitle] = useState('Astralis');
  useEffect(() => {
    const update = (event) => setTitle(event.detail || 'Astralis');
    window.addEventListener('astralis:navigation', update);
    return () => window.removeEventListener('astralis:navigation', update);
  }, []);
  return <header className="astralis-titlebar">
    <span className="astralis-titlebar__brand"><img src="./astralis-mark.svg" alt=""/><strong>ASTRALIS</strong></span>
    <span className="astralis-titlebar__caption">{title}</span>
    <button type="button" className="astralis-titlebar__settings" aria-label="Abrir configurações" onClick={() => window.dispatchEvent(new Event('astralis:open-settings'))}>Configurações <kbd>Ctrl + ,</kbd></button>
  </header>;
}
