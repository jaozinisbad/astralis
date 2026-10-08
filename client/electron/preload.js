const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Listar telas e janelas disponíveis para compartilhamento
  // (desktopCapturer só existe no processo main, por isso usamos IPC)
  listarFontesCompartilhamento: async () => {
    try {
      return await ipcRenderer.invoke('listar-fontes-compartilhamento');
    } catch (err) {
      console.error('Erro ao listar fontes:', err);
      throw err;
    }
  },

  // Avisa o processo principal qual fonte foi escolhida no seletor,
  // ANTES de chamar getDisplayMedia() — sem isso, o Electron não sabe
  // qual tela/janela específica você quis compartilhar.
  definirFonteCompartilhamento: (fonteId) => {
    ipcRenderer.send('definir-fonte-compartilhamento', fonteId);
  },

  // Trocar dispositivo de áudio
  changeAudioDevice: async (kind, deviceId) => {
    try {
      // Envia mensagem para main process, que pode fazer algo com isso
      await ipcRenderer.invoke('change-audio-device', { kind, deviceId });
    } catch (err) {
      console.error('Erro ao trocar dispositivo:', err);
      throw err;
    }
  },

  // Captura de áudio de UM app específico (ex: só o jogo), em vez do
  // sistema inteiro. Só funciona no Windows 10+.
  iniciarCapturaAudioJanela: (fonteId) => ipcRenderer.invoke('iniciar-captura-audio-janela', fonteId),
  iniciarCapturaProcesso: (tituloJanela) => ipcRenderer.invoke('iniciar-captura-processo', tituloJanela),
  // Modo inverso: captura o sistema inteiro, exceto um app específico
  // (ex: ignorar o Discord ao compartilhar a tela toda, pra não vazar
  // o áudio da call pra quem assiste).
  iniciarCapturaExcluindoProcesso: (nomeProcesso) =>
    ipcRenderer.invoke('iniciar-captura-excluindo-processo', nomeProcesso),
  pararCapturaProcesso: () => ipcRenderer.invoke('parar-captura-processo'),

  // Escuta os pedaços de áudio (PCM) chegando do processo escolhido.
  // Retorna uma função para parar de escutar.
  onAudioTelaChunk: (callback) => {
    const ouvinte = (_event, chunk) => callback(chunk);
    ipcRenderer.on('audio-tela-chunk', ouvinte);
    return () => ipcRenderer.removeListener('audio-tela-chunk', ouvinte);
  },

  // Atualização automática: avisa quando uma nova versão já foi baixada
  // e está pronta, e permite pedir pro app reiniciar já atualizado.
  obterStatusAtualizacao: () => ipcRenderer.invoke('obter-status-atualizacao'),
  verificarAtualizacao: () => ipcRenderer.invoke('verificar-atualizacao'),
  onAtualizacaoStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('atualizacao-status', listener);
    return () => ipcRenderer.removeListener('atualizacao-status', listener);
  },
  onAtualizacaoPronta: (callback) => {
    ipcRenderer.on('atualizacao-pronta', callback);
  },
  reiniciarParaAtualizar: () => ipcRenderer.invoke('reiniciar-para-atualizar'),
  copiarTexto: async (texto) => {
    try {
      return await ipcRenderer.invoke('copiar-texto', texto);
    } catch (err) {
      console.error('Erro ao copiar texto:', err);
      throw err;
    }
  },
});
