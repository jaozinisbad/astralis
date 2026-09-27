const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { app, BrowserWindow, clipboard } = require('electron');

const fixtureCode = 'ASTRALIS-SMOKE-INVITE-ONLY';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'astralis-electron-smoke-'));
app.setPath('userData', path.join(userData, 'profile'));

let windowRef;
let done = false;
const previousClipboard = clipboard.readText();

function finish(error) {
  if (done) return;
  done = true;
  clipboard.writeText(previousClipboard);
  if (error) {
    console.error(`SMOKE FAIL: ${error.message}`);
    app.exit(1);
  } else {
    console.log('SMOKE PASS: convite via IPC, configuração do servidor e criação de canais texto/voz.');
    app.exit(0);
  }
}

app.on('browser-window-created', (_event, win) => {
  windowRef = win;
  win.hide();
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const localVite = details.url.startsWith('http://127.0.0.1:5173/') || details.url.startsWith('http://localhost:5173/');
    callback({ cancel: !localVite });
  });
  win.webContents.on('did-finish-load', async () => {
    try {
      await win.webContents.executeJavaScript(`
        window.__smokeRequests = [];
        window.fetch = async (input, options = {}) => {
          const url = String(input);
          const method = String(options.method || 'GET').toUpperCase();
          window.__smokeRequests.push({ url, method, body: options.body || null });
          let data;
          if (url.endsWith('/api/login')) {
            data = { token: 'fake-smoke-token', usuario: { id: 501, nome: 'Smoke Owner', status: 'Online', avatar_cor: '#5865f2', avatar_url: null } };
          } else if (url.endsWith('/api/servidores')) {
            data = [{ id: 701, nome: 'Smoke Server', codigo_convite: ${JSON.stringify(fixtureCode)}, papel: 'dono', descricao: '' }];
          } else if (url.includes('/api/servidores/701/canais') && method === 'POST') {
            const body = JSON.parse(options.body || '{}');
            data = { id: 800 + window.__smokeRequests.filter((r) => r.method === 'POST' && r.url.endsWith('/canais')).length, ...body };
          } else if (url.endsWith('/api/servidores/701/canais')) {
            data = [{ id: 702, nome: 'geral', tipo: 'texto' }];
          } else if (url.endsWith('/api/servidores/701/membros')) {
            data = [{ id: 501, nome: 'Smoke Owner', papel: 'dono', cargos: [] }];
          } else if (url.endsWith('/api/servidores/701/cargos')) {
            data = [];
          } else if (url.endsWith('/api/amigos')) {
            data = [];
          } else if (url.endsWith('/api/canais/702/mensagens')) {
            data = [];
          } else {
            data = {};
          }
          return { ok: true, status: 200, json: async () => data };
        };
        undefined;
      `);

      const waitFor = async (condition, description) => {
        const started = Date.now();
        while (Date.now() - started < 10000) {
          if (await win.webContents.executeJavaScript(condition)) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`Timeout: ${description}`);
      };
      const clickButton = async (label) => {
        await waitFor(`[...document.querySelectorAll('button')].some((item) => item.textContent.trim().endsWith(${JSON.stringify(label)}))`, `botão ${label}`);
        return win.webContents.executeJavaScript(`(() => {
        const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim().endsWith(${JSON.stringify(label)}));
        if (!button) throw new Error('Botão não encontrado: ' + ${JSON.stringify(label)});
        button.click(); return true;
      })()`);
      };
      const openServerMenu = async () => {
        await win.webContents.executeJavaScript(`(() => {
        const button = document.querySelector('.server-name-trigger');
        if (!button) throw new Error('Menu do servidor não encontrado.');
        button.click(); return true;
      })()`);
        await waitFor(`document.querySelector('.sidebar-popover.server-menu') !== null`, 'menu do servidor');
      };

      await waitFor(`document.querySelector('input[name="email"]') !== null`, 'formulário de login');
      await win.webContents.executeJavaScript(`(() => {
        const email = document.querySelector('input[name="email"]');
        const password = document.querySelector('input[name="password"]');
        const setValue = (input, value) => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        setValue(email, 'smoke@example.invalid');
        setValue(password, 'fake-password');
        document.querySelector('.auth-form').requestSubmit();
      })()`);
      await waitFor(`document.querySelector('.server-name-trigger') !== null`, 'servidor de teste carregado');

      await openServerMenu();
      await clickButton('Copiar código de convite');
      await waitFor(`document.querySelector('[role="status"]')?.textContent.includes('copiado') === true`, 'feedback de cópia');
      const copied = clipboard.readText();
      if (copied !== fixtureCode) throw new Error('Clipboard IPC não recebeu o código de teste.');

      await openServerMenu();
      await clickButton('Convidar para o servidor');
      await waitFor(`document.querySelector('#invite-modal-title') !== null`, 'janela de convite');
      await clickButton('Copiar mensagem pronta');
      await waitFor(`document.querySelector('.invite-modal__feedback')?.textContent.includes('pronta') === true`, 'feedback da mensagem pronta');
      if (!clipboard.readText().includes(fixtureCode)) throw new Error('Mensagem pronta não inclui o código de convite.');
      await clickButton('Fechar');

      await openServerMenu();
      await clickButton('Criar canal de texto');
      await waitFor(`document.querySelector('[role="dialog"] input') !== null`, 'modal de canal texto');
      await win.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('[role="dialog"] input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'smoke-text');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[role="dialog"]').requestSubmit();
      })()`);
      await waitFor(`document.body.innerText.includes('smoke-text')`, 'canal texto criado');

      await openServerMenu();
      await clickButton('Criar canal de voz');
      await waitFor(`document.querySelector('[role="dialog"] input') !== null`, 'modal de canal voz');
      await win.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('[role="dialog"] input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'smoke-voice');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[role="dialog"]').requestSubmit();
      })()`);
      await waitFor(`document.body.innerText.includes('smoke-voice')`, 'canal voz criado');

      await openServerMenu();
      await clickButton('Configurações do servidor');
      await waitFor(`document.body.innerText.includes('Configurar servidor') && document.querySelector('.servidor-config-modal')`, 'modal de configurações servidor');
      finish();
    } catch (error) {
      try {
        const state = await win.webContents.executeJavaScript(`({ text: document.body.innerText.slice(0, 500), requests: window.__smokeRequests || [] })`);
        console.error('SMOKE STATE:', JSON.stringify(state));
      } catch { /* A janela pode ter fechado antes da leitura. */ }
      finish(error);
    }
  });
});

app.on('window-all-closed', () => {
  if (!done) finish(new Error('Janela Electron fechada antes da conclusão do smoke test.'));
});

require('../electron/main.js');
