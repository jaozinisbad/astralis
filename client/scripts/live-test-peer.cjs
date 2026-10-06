const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { io } = require('socket.io-client');

const profile = path.join(app.getPath('appData'), 'Astralis Codex Teste');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let started = false;
let observer;
let win;
const appReady = app.whenReady().then(() => {
  ipcMain.handle('listar-fontes-compartilhamento', () => [
    { id: 'codex-test-pattern', name: 'Tela de teste Codex', thumbnail: '', tipo: 'tela' },
  ]);
  ipcMain.on('definir-fonte-compartilhamento', () => {});
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(['media', 'microphone', 'camera', 'fullscreen'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return ['media', 'microphone', 'camera', 'fullscreen'].includes(permission);
  });
  win = new BrowserWindow({
    width: 1100,
    height: 700,
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
  });
  win.webContents.setAudioMuted(true);
});
const input = readline.createInterface({ input: process.stdin });
const authFile = path.join(__dirname, '..', 'release', 'codex-test-session.json');
const authPoll = setInterval(() => {
  if (started || !fs.existsSync(authFile)) return;
  try {
    const line = fs.readFileSync(authFile, 'utf8');
    fs.unlinkSync(authFile);
    input.emit('line', line);
  } catch (error) {
    console.error('Não foi possível ler a sessão de teste:', error.message);
  }
}, 250);

input.on('line', async (line) => {
  if (line === 'quit') {
    observer?.disconnect();
    app.quit();
    return;
  }
  if (started) return;
  started = true;
  clearInterval(authPoll);
  try {
    const { token, usuario, servidor, canal } = JSON.parse(line);
    if (!token || !usuario?.id || !servidor?.id || !canal?.id) throw new Error('Sessão de teste incompleta.');
    await appReady;
    win.webContents.on('did-fail-load', (_event, code, description) => {
      console.error(`Tela de teste falhou: ${code} ${description}`);
    });
    let seeded = false;
    win.webContents.on('did-finish-load', async () => {
      try {
        if (!seeded) {
          seeded = true;
          const sessao = JSON.stringify({ token, usuario });
          await win.webContents.executeJavaScript(`localStorage.setItem('sessao', ${JSON.stringify(sessao)}); true`);
          win.reload();
          return;
        }
        const deadline = Date.now() + 35000;
        while (Date.now() < deadline) {
          const found = await win.webContents.executeJavaScript(`(() => {
            const canal = [...document.querySelectorAll('.channel-item')].find((item) => item.textContent.includes(${JSON.stringify(canal.nome)}));
            if (!canal) return false;
            canal.click();
            return true;
          })()`);
          if (found) {
            console.log(`Astralis de teste abriu ${canal.nome}.`);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const status = await win.webContents.executeJavaScript(`({
          callVisible: document.body.innerText.includes('Voz conectada'),
          error: document.querySelector('.voz-status-bar__erro')?.textContent || null,
        })`);
        console.log('Interface de voz:', JSON.stringify(status));
        if (status.error || !status.callVisible) return;

        await win.webContents.executeJavaScript(`(() => {
          navigator.mediaDevices.getDisplayMedia = async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 1280;
            canvas.height = 720;
            const context = canvas.getContext('2d');
            let frame = 0;
            const draw = () => {
              context.fillStyle = '#111827';
              context.fillRect(0, 0, canvas.width, canvas.height);
              context.fillStyle = '#8de7db';
              context.font = 'bold 62px sans-serif';
              context.fillText('ASTRALIS • TESTE', 95, 240);
              context.fillStyle = '#c5d0e8';
              context.font = '36px sans-serif';
              context.fillText('Vídeo e áudio gerados para testar o volume', 95, 310);
              context.fillStyle = '#7667df';
              context.fillRect(95 + (frame % 90) * 10, 410, 140, 95);
              frame += 1;
            };
            draw();
            const drawTimer = setInterval(draw, 100);
            const video = canvas.captureStream(15);
            const audioContext = new AudioContext();
            const oscillator = audioContext.createOscillator();
            const gain = audioContext.createGain();
            const destination = audioContext.createMediaStreamDestination();
            oscillator.frequency.value = 440;
            gain.gain.value = 0.08;
            oscillator.connect(gain);
            gain.connect(destination);
            oscillator.start();
            await audioContext.resume();
            const stream = new MediaStream([...video.getVideoTracks(), ...destination.stream.getAudioTracks()]);
            window.__codexTestCapture = { stream, audioContext, oscillator, drawTimer };
            return stream;
          };
          document.querySelector('button[title="Mutar microfone"]')?.click();
          document.querySelector('button[title="Compartilhar tela"]')?.click();
          return true;
        })()`);

        const pickerDeadline = Date.now() + 10000;
        while (Date.now() < pickerDeadline) {
          const ready = await win.webContents.executeJavaScript(`(() => {
            const picker = document.querySelector('.screen-picker-modal');
            const button = [...(picker?.querySelectorAll('button') || [])].find((item) => item.textContent.trim() === 'Compartilhar');
            if (!button || button.disabled) return false;
            button.click();
            return true;
          })()`);
          if (ready) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const shareStatus = await win.webContents.executeJavaScript(`({
          sharing: document.querySelector('button[title="Parar compartilhamento de tela"]') !== null,
          error: document.querySelector('.voz-status-bar__erro')?.textContent || null,
        })`);
        console.log('Transmissão de teste:', JSON.stringify(shareStatus));
      } catch (error) {
        console.error('Falha na interface de teste:', error.message);
      }
    });

    observer = io('https://app-gamers-server.onrender.com', { auth: { token } });
    observer.on('connect', () => {
      observer.emit('obter-presenca-servidor', servidor.id);
    });
    observer.on('presenca-voz-servidor', ({ participantesPorCanal }) => {
      const participantes = participantesPorCanal[canal.id] || [];
      console.log('Participantes em voz:', participantes.map((item) => item.nome).join(', ') || '(nenhum)');
    });
    observer.on('presenca-voz-canal', ({ canalId, participantes }) => {
      if (Number(canalId) === Number(canal.id)) {
        console.log('Participantes em voz:', participantes.map((item) => item.nome).join(', ') || '(nenhum)');
      }
    });
    observer.on('connect_error', (error) => console.error('Conexão de presença:', error.message));
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  } catch (error) {
    console.error(error.message);
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
