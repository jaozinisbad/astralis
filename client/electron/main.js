const { app, BrowserWindow, clipboard, desktopCapturer, session, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { createManualUpdater } = require('./manualUpdater.cjs');
const { exec } = require('child_process');
const { findSelectedCaptureSource, getWindowHandleFromSourceId, shouldUseSystemLoopback } = require('./screenCapturePolicy.cjs');

app.setName('Astralis');
if (process.platform === 'win32') {
  app.setAppUserModelId('com.appgamers.client');
}

// loopback-capture só funciona no Windows — em qualquer outro sistema
// (dev no Mac/Linux, por exemplo) isso falha ao importar, então
// carregamos com cuidado pra não derrubar o app inteiro por causa disso.
let loopback = null;
try {
  loopback = require('loopback-capture');
} catch (err) {
  console.warn('loopback-capture não disponível (provavelmente não é Windows 10+):', err.message);
}

// Guarda qual fonte (tela/janela) o usuário escolheu no seletor próprio
// do app, pra usar na hora que o Electron de fato pedir a captura.
let fonteEscolhidaId = null;
let capturaProcessoAtual = null;
let geracaoCapturaAudioJanela = 0;

function configurarCompartilhamentoDeTela() {
  // Recebe do renderer qual fonte foi escolhida no ScreenShareSourcePicker,
  // ANTES de getDisplayMedia() ser chamado.
  ipcMain.on('definir-fonte-compartilhamento', (_event, fonteId) => {
    fonteEscolhidaId = fonteId;
  });

  // IMPORTANTE: useSystemPicker precisa ficar desligado — se estiver
  // ligado, o próprio Windows/macOS mostra o seletor nativo dele e essa
  // função nem chega a rodar, ignorando a fonte escolhida no app.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      const fonteId = fonteEscolhidaId;
      fonteEscolhidaId = null;
      try {
        const fontes = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        const escolhida = findSelectedCaptureSource(fontes, fonteId);
        if (!escolhida) {
          callback(null);
          return;
        }
        callback({
          video: escolhida,
          ...(shouldUseSystemLoopback(request, escolhida) ? { audio: 'loopback' } : {}),
        });
      } catch {
        callback(null);
      }
    },
    { useSystemPicker: false },
  );

  // desktopCapturer só pode ser usado no processo main (Electron 17+).
  // Por isso expomos essa chamada via IPC para o preload/renderer usarem.
  ipcMain.handle('listar-fontes-compartilhamento', async () => {
    const fontes = await desktopCapturer.getSources({
      types: ['screen', 'window'],
    });

    return fontes.map((fonte, index) => ({
      id: fonte.id,
      name: fonte.name.includes('Entire')
        ? `Tela ${index}`
        : fonte.name,
      thumbnail: fonte.thumbnail.toDataURL(),
      // "tela" (monitor inteiro) ou "janela" (um app específico) — só
      // janelas têm um processo específico pra isolar o áudio.
      tipo: fonte.id.startsWith('screen') ? 'tela' : 'janela',
    }));
  });
}

// Roda um script PowerShell e devolve o stdout. Usa -EncodedCommand
// (o script inteiro em Base64) em vez de -Command "..." — o jeito
// -Command exige colocar o script inteiro dentro de aspas duplas na
// linha de comando do Windows, e se o PRÓPRIO script também usa aspas
// duplas por dentro (como o filtro do WMI abaixo), elas "fecham" a
// aspa de fora sem querer e o comando quebra silenciosamente (dá erro
// sem exceção nenhuma no lado do Node, só volta vazio). -EncodedCommand
// evita esse problema de vez, porque não passa nenhuma aspa pela linha
// de comando.
function executarPowerShell(script) {
  return new Promise((resolve) => {
    const base64 = Buffer.from(script, 'utf16le').toString('base64');
    exec(
      `powershell -NoProfile -EncodedCommand ${base64}`,
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

// Descobre o PID (identificador do processo) de uma janela pelo título
// dela, usando o PowerShell — assim não precisamos de mais nenhuma
// dependência nativa só pra essa busca.
async function obterPidPorTitulo(tituloJanela) {
  const stdout = await executarPowerShell(
    "Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object Id, MainWindowTitle | ConvertTo-Json -Compress",
  );
  if (!stdout) return null;
  try {
    let lista = JSON.parse(stdout || '[]');
    if (!Array.isArray(lista)) lista = [lista];
    const encontrado = lista.find((p) => p.MainWindowTitle === tituloJanela);
    return encontrado ? encontrado.Id : null;
  } catch (e) {
    return null;
  }
}


// Converte o HWND do ID do Electron no PID do processo dono da janela.
// Não usa o título, que pode se repetir.
async function obterPidPorHandleJanela(handleJanela) {
  if (process.platform !== 'win32' || !handleJanela || !/^\d+$/.test(handleJanela)) return null;
  const script = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AstralisWindowAudioWindow { [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId); }'",
    '$hwnd = [IntPtr][Int64]' + handleJanela,
    '[UInt32]$processId = 0',
    '$threadId = [AstralisWindowAudioWindow]::GetWindowThreadProcessId($hwnd, [ref]$processId)',
    'if ($threadId -gt 0 -and $processId -gt 0) { Write-Output $processId }',
  ].join('\n');
  const stdout = await executarPowerShell(script);
  const pid = Number(stdout?.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}
// Descobre o PID "raiz" de um programa pelo nome do executável (ex:
// "Discord.exe"), em vez de pelo título da janela. Isso importa porque
// programas como o Discord costumam ficar minimizados na bandeja do
// sistema sem nenhuma janela visível — nesse estado eles não têm
// MainWindowTitle nenhum, então obterPidPorTitulo() nunca os acharia.
// Só o nome do processo continua disponível o tempo todo. Como o
// Discord roda vários processos com o mesmo nome (é um app Electron,
// igual o nosso), pegamos o processo "raiz" — aquele cujo pai NÃO é
// outro processo do mesmo nome — pra que o modo "excluir árvore de
// processos" do Windows pegue todos os processos filhos dele também.
async function obterPidRaizPorNomeDeProcesso(nomeExe) {
  const stdout = await executarPowerShell(
    `Get-CimInstance Win32_Process -Filter "Name='${nomeExe}'" | Select-Object ProcessId, ParentProcessId | ConvertTo-Json -Compress`,
  );
  if (!stdout) return null;
  try {
    let lista = JSON.parse(stdout || '[]');
    if (!Array.isArray(lista)) lista = [lista];
    if (!lista.length) return null;
    const pids = new Set(lista.map((p) => p.ProcessId));
    const raiz = lista.find((p) => !pids.has(p.ParentProcessId)) || lista[0];
    return raiz.ProcessId;
  } catch (e) {
    return null;
  }
}

// Captura o áudio de UM app específico (ex: só o jogo, ignorando
// Spotify/YouTube) usando a mesma técnica que Discord e OBS usam no
// Windows (WASAPI Process Loopback Capture) — bem mais avançado que o
// "audio: loopback" de cima, que pega o som do sistema inteiro.
function configurarCapturaPorProcesso() {
  ipcMain.handle('iniciar-captura-audio-janela', async (event, sourceId) => {
    if (process.platform !== 'win32' || !loopback) {
      return { sucesso: false, mensagem: 'A captura isolada dessa janela não está disponível neste computador.' };
    }

    const geracao = ++geracaoCapturaAudioJanela;
    if (capturaProcessoAtual) {
      const capturaAnterior = capturaProcessoAtual;
      capturaProcessoAtual = null;
      try { capturaAnterior.stop(); } catch {}
    }

    let capturaNova = null;
    try {
      const fontes = await desktopCapturer.getSources({ types: ['window'] });
      const fonte = findSelectedCaptureSource(fontes, sourceId);
      const handleJanela = getWindowHandleFromSourceId(fonte?.id);
      const pid = handleJanela ? await obterPidPorHandleJanela(handleJanela) : null;
      if (!pid || geracao !== geracaoCapturaAudioJanela) {
        return { sucesso: false, mensagem: 'Não consegui identificar o processo da janela selecionada.' };
      }

      capturaNova = new loopback.LoopbackCapture();
      capturaProcessoAtual = capturaNova;
      capturaNova.start(pid, true, (chunk) => {
        if (!event.sender.isDestroyed()) event.sender.send('audio-tela-chunk', chunk);
      });
      return { sucesso: true };
    } catch {
      try { capturaNova?.stop(); } catch {}
      if (capturaProcessoAtual === capturaNova) capturaProcessoAtual = null;
      return { sucesso: false, mensagem: 'Não consegui iniciar a captura isolada dessa janela.' };
    }
  });
  ipcMain.handle('iniciar-captura-processo', async (event, tituloJanela) => {
    if (!loopback) {
      return { sucesso: false, mensagem: 'Esse recurso só funciona no Windows 10 (versão 2004) ou mais novo.' };
    }

    try {
      const pid = await obterPidPorTitulo(tituloJanela);
      if (!pid) {
        return { sucesso: false, mensagem: `Não encontrei o processo da janela "${tituloJanela}".` };
      }

      if (capturaProcessoAtual) {
        capturaProcessoAtual.stop();
        capturaProcessoAtual = null;
      }

      capturaProcessoAtual = new loopback.LoopbackCapture();
      // "true" inclui processos-filho (ex: um jogo que abre sub-processos)
      capturaProcessoAtual.start(pid, true, (chunk) => {
        event.sender.send('audio-tela-chunk', chunk);
      });

      return { sucesso: true };
    } catch (err) {
      return { sucesso: false, mensagem: `Erro ao iniciar a captura: ${err.message}` };
    }
  });

  ipcMain.handle('parar-captura-processo', () => {
    geracaoCapturaAudioJanela += 1;
    if (capturaProcessoAtual) {
      capturaProcessoAtual.stop();
      capturaProcessoAtual = null;
    }
    return { sucesso: true };
  });
}

// Modo inverso do de cima: em vez de capturar SÓ um app, captura o
// áudio do sistema INTEIRO exceto um app específico. Serve pro caso de
// "call no Discord, mas compartilhando a tela toda pelo Astralis" —
// sem isso, quem compartilha a tela toda manda o áudio do Discord (as
// vozes de todo mundo) junto, e cada espectador ouve a própria voz de
// volta com delay (eco), porque ela sai pela caixa de som de quem
// compartilha e volta pela captura de tela.
// A mesma biblioteca (loopback-capture) já suporta isso: chamando
// start(pid, false, ...) em vez de start(pid, true, ...), no Windows
// isso ativa o modo "excluir árvore de processos" da WASAPI, em vez de
// "incluir" — captura tudo, menos aquele processo (e os filhos dele).
function configurarCapturaExcluindoProcesso() {
  ipcMain.handle('iniciar-captura-excluindo-processo', async (event, nomeProcesso) => {
    if (!loopback) {
      return { sucesso: false, mensagem: 'Esse recurso só funciona no Windows 10 (versão 2004) ou mais novo.' };
    }

    try {
      const pid = await obterPidRaizPorNomeDeProcesso(nomeProcesso);
      if (!pid) {
        return {
          sucesso: false,
          mensagem: `Não encontrei o ${nomeProcesso} rodando. Ele precisa estar aberto (pode estar minimizado).`,
        };
      }

      if (capturaProcessoAtual) {
        capturaProcessoAtual.stop();
        capturaProcessoAtual = null;
      }

      capturaProcessoAtual = new loopback.LoopbackCapture();
      // "false" aqui é o que liga o modo excluir, não "incluir árvore".
      capturaProcessoAtual.start(pid, false, (chunk) => {
        event.sender.send('audio-tela-chunk', chunk);
      });

      return { sucesso: true };
    } catch (err) {
      return { sucesso: false, mensagem: `Erro ao iniciar a captura: ${err.message}` };
    }
  });
}

function configurarPermissoesDeMidia() {
  // 'fullscreen' precisa estar aqui — sem ela, o Electron nega o pedido de
  // tela cheia (video.requestFullscreen()) em silêncio, sem erro nenhum,
  // o que fazia o botão "Tela cheia" parecer simplesmente não funcionar.
  const permissoesDeMidia = new Set(['media', 'microphone', 'camera', 'fullscreen']);

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permissoesDeMidia.has(permission));
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permissoesDeMidia.has(permission);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    icon: path.join(__dirname, '../build/icon.ico'),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.removeMenu();

  if (!app.isPackaged) {
    // Modo desenvolvimento: aponta pro servidor do Vite
    win.loadURL('http://localhost:5173');
  } else {
    // Modo empacotado (após "npm run build")
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  return win;
}

// Consulta novas publicações automaticamente; baixar e instalar exigem os botões do app.
function configurarAtualizacaoManual(win) {
  const logDirectory = path.join(app.getPath('userData'), 'logs');
  const logPath = path.join(logDirectory, 'updater.log');
  function registrarLogAtualizacao(nivel, ...valores) {
    try {
      fs.mkdirSync(logDirectory, { recursive: true });
      const mensagem = valores.map((valor) => {
        if (valor instanceof Error) return valor.stack || valor.message;
        if (typeof valor === 'string') return valor;
        try { return JSON.stringify(valor); } catch { return String(valor); }
      }).join(' ');
      fs.appendFileSync(logPath, new Date().toISOString() + ' [' + nivel + '] ' + mensagem + '\n');
    } catch {}
  }
  autoUpdater.logger = {
    debug: (...valores) => registrarLogAtualizacao('DEBUG', ...valores),
    info: (...valores) => registrarLogAtualizacao('INFO', ...valores),
    warn: (...valores) => registrarLogAtualizacao('WARN', ...valores),
    error: (...valores) => registrarLogAtualizacao('ERROR', ...valores),
  };
  const atualizador = createManualUpdater({
    autoUpdater,
    logger: autoUpdater.logger,
    publishState: (estado) => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('atualizacao-status', estado);
        if (estado.status === 'downloaded') win.webContents.send('atualizacao-pronta');
      }
    },
  });

  // O ambiente de desenvolvimento expõe o mesmo contrato, sem consultar releases.
  const verificar = (origem, forcar = false) => app.isPackaged
    ? atualizador.check(origem, forcar)
    : Promise.resolve(atualizador.getState());
  ipcMain.handle('obter-status-atualizacao', () => atualizador.getState());
  ipcMain.handle('verificar-atualizacao', () => verificar('manual', true));
  ipcMain.handle('baixar-atualizacao', () => app.isPackaged ? atualizador.download() : atualizador.getState());
  ipcMain.handle('reiniciar-para-atualizar', () => app.isPackaged ? atualizador.install() : atualizador.getState());

  const verificarAoFocar = () => { void verificar('focus'); };
  const intervalo = app.isPackaged ? setInterval(() => {
    void verificar('periodic');
  }, 60 * 60 * 1000) : null;
  intervalo?.unref?.();
  win.on('focus', verificarAoFocar);
  win.once('closed', () => {
    if (intervalo) clearInterval(intervalo);
    win.removeListener('focus', verificarAoFocar);
    atualizador.dispose();
    for (const canal of [
      'obter-status-atualizacao',
      'verificar-atualizacao',
      'baixar-atualizacao',
      'reiniciar-para-atualizar',
    ]) ipcMain.removeHandler(canal);
  });

  void verificar('startup');
}

app.whenReady().then(() => {
  ipcMain.handle('copiar-texto', (_event, texto) => {
    if (typeof texto !== 'string' || !texto) throw new Error('Texto inválido para copiar.');
    clipboard.writeText(texto);
    return true;
  });
  configurarPermissoesDeMidia();
  configurarCompartilhamentoDeTela();
  configurarCapturaPorProcesso();
  configurarCapturaExcluindoProcesso();
  const win = createWindow();
  configurarAtualizacaoManual(win);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
