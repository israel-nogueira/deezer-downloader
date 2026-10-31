// ===== Processo principal do Electron =====
// Janela sem borda + IPC (janela, servidor, API pública, config, login,
// biblioteca, capas). O servidor nativo vive em server.js; a organização
// dos downloads (índice, capas, .m3u8, retry) vive em organizer.js.

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const createOrganizer = require('./organizer');
const createServer = require('./server');

const MINI_W = 560;
const MINI_H = 48;
const NORMAL_MIN_W = 900;
const NORMAL_MIN_H = 600;
const NORMAL_W = 1280;
const NORMAL_H = 800;

const DEEZER_API = 'https://api.deezer.com';
const API_TIMEOUT = 15000;
const MAX_TRACKS = 5000;

let janelaPrincipal = null;
let servidor = null;
let organizerRef = null;

let modoMini = false;
let estadoAntesDeCompactar = null;
let miniSaveTimer = null;
let miniTopmostTimer = null;

const SPLASH_MIN_MS = 5000; // tempo mínimo que o splash fica visível

let splashWin = null;
let splashStartAt = 0;

function createSplash() {
  console.log('[splash] criando…');
  splashStartAt = Date.now();
  splashWin = new BrowserWindow({
    width: 360,
    height: 280,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#0b0b0d',
    icon: path.join(__dirname, 'renderer', 'favicon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  splashWin.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
  splashWin.once('ready-to-show', () => {
    console.log('[splash] ready-to-show');
    splashWin && splashWin.show();
  });
  splashWin.webContents.on('did-fail-load', (e, code, desc) => {
    console.log('[splash] did-fail-load:', code, desc);
  });
  splashWin.on('closed', () => { console.log('[splash] closed'); splashWin = null; });
  return splashWin;
}

function splashSet(pct, msg) {
  if (!splashWin || splashWin.isDestroyed()) return;
  try {
    splashWin.webContents.executeJavaScript(
      `window.splashSet && window.splashSet(${Number(pct) || 0}, ${JSON.stringify(String(msg || ''))})`
    );
  } catch (e) { /* splash sumiu */ }
}

function fecharSplash() {
  const restante = SPLASH_MIN_MS - (Date.now() - splashStartAt);
  const espera = Math.max(0, restante);
  console.log(`[splash] fechar em ${espera}ms`);
  setTimeout(() => {
    console.log('[splash] fechando agora');
    if (splashWin && !splashWin.isDestroyed()) splashWin.close();
    splashWin = null;
    if (janelaPrincipal && !janelaPrincipal.isDestroyed()) {
      janelaPrincipal.show();
      janelaPrincipal.focus();
    }
  }, espera);
}

app.setPath('userData', path.join(app.getPath('appData'), 'Deezer Player'));
// ===== Janela: compactar/descompactar =====
function compactarJanela(win) {
  if (!win || modoMini) return;

  const maximized = win.isMaximized();
  const bounds = win.getBounds();
  estadoAntesDeCompactar = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized
  };

  if (maximized) win.unmaximize();

  const cfg = readConfig();
  const display = screen.getDisplayMatching(bounds);
  const wa = display.workArea;

  let x = Number.isFinite(Number(cfg.miniX)) ? Number(cfg.miniX) : wa.x + wa.width - MINI_W - 12;
  let y = Number.isFinite(Number(cfg.miniY)) ? Number(cfg.miniY) : wa.y + wa.height - MINI_H - 12;

  if (x < wa.x - MINI_W || x > wa.x + wa.width) x = wa.x + wa.width - MINI_W - 12;
  if (y < wa.y - MINI_H || y > wa.y + wa.height) y = wa.y + wa.height - MINI_H - 12;

  win.setMinimumSize(0, 0);

  win.setSize(MINI_W, MINI_H, false);
  win.setPosition(x, y, false);
  win.setAlwaysOnTop(true, 'screen-saver');

  win.setResizable(false);
  win.setMaximizable(false);
  win.setMinimizable(false);

  if (miniTopmostTimer) clearInterval(miniTopmostTimer);
  miniTopmostTimer = setInterval(() => {
    if (modoMini && janelaPrincipal && !janelaPrincipal.isDestroyed()) {
      try {
        janelaPrincipal.setAlwaysOnTop(true, 'screen-saver');
      } catch (e) {
        /* janela sumiu no meio: ignora */
      }
    }
  }, 1500);

  modoMini = true;
  writeConfig({ modoMini: true, miniX: x, miniY: y });

  if (janelaPrincipal) janelaPrincipal.webContents.send('win:modoMini', true);
}

function descompactarJanela(win) {
  if (!win || !modoMini) return;

  if (miniTopmostTimer) {
    clearInterval(miniTopmostTimer);
    miniTopmostTimer = null;
  }

  win.setAlwaysOnTop(false);
  win.setSkipTaskbar(false);
  win.setResizable(true);
  win.setMaximizable(true);
  win.setMinimizable(true);

  const e = estadoAntesDeCompactar;
  if (e) {
    win.setSize(e.width, e.height, false);
    win.setPosition(e.x, e.y, false);
    if (e.maximized) win.maximize();
    estadoAntesDeCompactar = null;
  } else {
    win.setSize(NORMAL_W, NORMAL_H, false);
    win.center();
  }

  win.setMinimumSize(NORMAL_MIN_W, NORMAL_MIN_H);

  modoMini = false;
  writeConfig({ modoMini: false });

  if (janelaPrincipal) janelaPrincipal.webContents.send('win:modoMini', false);
}

// ===== IPC: janela =====
ipcMain.on('win:control', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  if (action === 'min') win.minimize();
  else if (action === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === 'close') win.close();
});

ipcMain.handle('win:compactar', () => {
  if (!janelaPrincipal) return { ok: false };
  compactarJanela(janelaPrincipal);
  return { ok: true };
});

ipcMain.handle('win:descompactar', () => {
  if (!janelaPrincipal) return { ok: false };
  descompactarJanela(janelaPrincipal);
  return { ok: true };
});

ipcMain.handle('win:estadoMini', () => ({ modoMini }));

ipcMain.handle('shell:open', async (event, url) => {
  const target = String(url || '');
  if (!/^https?:\/\//i.test(target)) {
    return { ok: false, error: 'protocolo não permitido' };
  }
  try {
    await shell.openExternal(target);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

async function apiCall(route, body) {
  const base = servidor ? servidor.apiBase() : 'http://127.0.0.1:5000';
  try {
    const res = await fetch(base + route, {
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          }),
      signal: AbortSignal.timeout(API_TIMEOUT)
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return { ok: false, error: 'o servidor não respondeu (timeout)' };
    }
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('api:search', (event, { type, query }) =>
  apiCall('/search', { type, query })
);

ipcMain.handle('api:download', (event, { type, musicId, createZip = false }) =>
  apiCall('/download', {
    type,
    music_id: Number(musicId),
    add_to_playlist: false,
    create_zip: !!createZip
  })
);

ipcMain.handle('api:playlist', (event, { url, createZip = false }) =>
  apiCall('/playlist/deezer', {
    playlist_url: url,
    add_to_playlist: false,
    create_zip: !!createZip
  })
);

ipcMain.handle('api:queue', () => apiCall('/queue'));

ipcMain.handle('api:searchPlaylists', async (event, { query }) => {
  try {
    const res = await fetch('https://api.deezer.com/search/playlist?limit=10&q=' + encodeURIComponent(query));
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json();
    if (json.error) return { ok: false, error: json.error.message || 'erro do Deezer' };
    return { ok: true, data: json.data || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('api:searchAlbums', async (event, { query }) => {
  try {
    const res = await fetch('https://api.deezer.com/search/album?limit=10&q=' + encodeURIComponent(query));
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json();
    if (json.error) return { ok: false, error: json.error.message || 'erro do Deezer' };
    return { ok: true, data: json.data || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('api:albumTracks', async (event, { id }) => {
  if (!/^\d+$/.test(String(id))) return { ok: false, error: 'id de álbum inválido' };
  try {
    const res = await fetch(`https://api.deezer.com/album/${id}/tracks?limit=100`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json();
    if (json.error) return { ok: false, error: json.error.message || 'erro do Deezer' };
    return { ok: true, data: json.data || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('api:albumInfo', async (event, { id }) => {
  if (!/^\d+$/.test(String(id))) return { ok: false, error: 'id de álbum inválido' };
  try {
    const res = await fetch(`https://api.deezer.com/album/${id}`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json();
    if (json.error) return { ok: false, error: json.error.message || 'erro do Deezer' };
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('api:artistPage', async (event, { id }) => {
  if (!/^\d+$/.test(String(id))) return { ok: false, error: 'id de artista inválido' };
  try {
    const base = `https://api.deezer.com/artist/${id}`;
    const info = await fetch(base).then((r) => r.json());
    if (info.error) return { ok: false, error: info.error.message || 'erro do Deezer' };

    // top: até o teto da API (100)
    const top = [];
    for (let index = 0; index < 100; index += 50) {
      const j = await fetch(`${base}/top?limit=50&index=${index}`).then((r) => r.json());
      if (j.error) break;
      top.push(...(j.data || []));
      if (!j.next || !(j.data || []).length) break;
    }

    // álbuns: até o fim
    const albums = [];
    for (let index = 0; index < 5000; index += 100) {
      const j = await fetch(`${base}/albums?limit=100&index=${index}`).then((r) => r.json());
      if (j.error) break;
      albums.push(...(j.data || []));
      if (!j.next || !(j.data || []).length) break;
    }

    return { ok: true, data: { info, top, albums } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('api:trackInfo', async (event, { id }) => {
  if (!/^\d+$/.test(String(id))) return { ok: false, error: 'id de faixa inválido' };
  try {
    const res = await fetch(`https://api.deezer.com/track/${id}`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json();
    if (json.error) return { ok: false, error: json.error.message || 'erro do Deezer' };
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('api:artistByName', async (event, { name }) => {
  const nome = String(name || '').trim();
  if (!nome) return { ok: false, error: 'nome vazio' };
  try {
    const res = await fetch('https://api.deezer.com/search/artist?limit=5&q=' + encodeURIComponent(nome));
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json();
    if (json.error) return { ok: false, error: json.error.message || 'erro do Deezer' };
    const lista = json.data || [];
    if (!lista.length) return { ok: false, error: 'artista não encontrado' };
    const achado = lista.find((a) => String(a.name).toLowerCase() === nome.toLowerCase()) || lista[0];
    return { ok: true, data: { id: achado.id, name: achado.name } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('api:playlistTracks', async (event, { id }) => {
  if (!/^\d+$/.test(String(id))) return { ok: false, error: 'id de playlist inválido' };
  try {
    const base = `https://api.deezer.com/playlist/${id}`;
    const info = await fetch(base).then((r) => r.json());
    if (info.error) return { ok: false, error: info.error.message || 'erro do Deezer' };

    const tracks = [];
    for (let index = 0; index < MAX_TRACKS; index += 100) {
      const json = await fetch(`${base}/tracks?limit=100&index=${index}`).then((r) => r.json());
      if (json.error) return { ok: false, error: json.error.message || 'erro do Deezer' };
      const page = json.data || [];
      tracks.push(...page);
      if (!json.next || !page.length) break;
    }

    return {
      ok: true,
      data: {
        title: info.title,
        releaseDate: info.creation_date || '',
        tracks: tracks.map((t) => ({
          id: t.id,
          title: t.title,
          artist: (t.artist && t.artist.name) || '',
          artistId: (t.artist && t.artist.id) || 0,
          album: (t.album && t.album.title) || '',
          albumId: (t.album && t.album.id) || 0,
          cover: (t.album && t.album.cover_small) || '',
          duration: t.duration || 0,
          preview: t.preview || ''
        }))
      }
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

function captureDeezerArl() {
  return new Promise((resolve) => {
    let done = false;
    const win = new BrowserWindow({
      width: 480,
      height: 720,
      parent: BrowserWindow.getFocusedWindow() || undefined,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      icon: path.join(__dirname, 'renderer', 'favicon.png'),
      webPreferences: {
        partition: 'deezer-login',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    const ses = win.webContents.session;

    const finish = (arl) => {
      if (done) return;
      done = true;
      ses.cookies.removeListener('changed', onChanged);
      if (!win.isDestroyed()) win.close();
      resolve(arl || null);
    };

    const onChanged = (event, cookie, cause, removed) => {
      if (removed || cookie.name !== 'arl') return;
      if (!cookie.domain.includes('deezer.com')) return;
      if (cookie.value.length < 100) return;
      if (cookie.path && cookie.path !== '/') return;
      finish(cookie.value);
    };

    ses.cookies.on('changed', onChanged);
    win.on('closed', () => finish(null));
    win.loadURL('https://www.deezer.com/login');
  });
}

let loginBusy = false;

ipcMain.handle('deezer:login', async () => {
  if (loginBusy) return { ok: false, error: 'login já em andamento' };
  loginBusy = true;
  try {
    const arl = await captureDeezerArl();
    if (!arl) return { ok: false, error: 'login cancelado' };
    const r = await servidor.restart(arl);
    return r.ok ? { ok: true, port: r.port } : { ok: false, error: r.error };
  } finally {
    loginBusy = false;
  }
});

function configFile() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

function writeConfig(patch) {
  const cfg = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

ipcMain.handle('config:get', () => {
  const cfg = readConfig();
  const ok = cfg.basePath && fs.existsSync(cfg.basePath);
  const arl = servidor && servidor.getArl();
  return { basePath: ok ? cfg.basePath : null, arl: arl ? 'saved' : 'none' };
});

ipcMain.handle('config:pickBase', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const r = await dialog.showOpenDialog(win, {
    title: 'Escolha a pasta base da biblioteca',
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, error: 'cancelado' };

  const nova = r.filePaths[0];
  const anterior = readConfig().basePath;
  writeConfig({ basePath: nova });

  if (anterior !== nova && servidor && (await servidor.status()).running) {
    const rs = await servidor.restart();
    if (!rs.ok) return { ok: true, basePath: nova, aviso: rs.error };
  }
  return { ok: true, basePath: nova };
});

function getBasePath() {
  const cfg = readConfig();
  return cfg.basePath && fs.existsSync(cfg.basePath) ? cfg.basePath : null;
}

ipcMain.handle('server:status', async () => {
  const st = await servidor.status();
  if (st.ready || st.running || st.engine === 'missing' || st.arl !== 'saved') return st;
  await servidor.start();
  return servidor.status();
});

ipcMain.handle('server:start', async () => {
  const r = await servidor.start();
  return r.ok ? { ready: true, port: r.port } : { ready: false, error: r.error };
});

let sessaoCache = { at: 0, status: 'unknown' };
const SESSAO_TTL = 60000; // 1 min

async function checarSessao({ forcar = false } = {}) {
  const arl = servidor && servidor.getArl();
  if (!arl) return 'expired';   // sem ARL = não logado, ponto

  const agora = Date.now();
  if (!forcar && agora - sessaoCache.at < SESSAO_TTL) return sessaoCache.status;

  try {
    const res = await fetch(
      'https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=',
      {
        headers: { Cookie: 'arl=' + arl, 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10000)
      }
    );
    if (!res.ok) {
      sessaoCache = { at: agora, status: 'unknown' };
      return 'unknown';
    }
    const json = await res.json();
    const id = Number(json && json.results && json.results.USER && json.results.USER.USER_ID);
    let status = 'unknown';
    if (Number.isFinite(id)) status = id > 0 ? 'ok' : 'expired';
    sessaoCache = { at: agora, status };
    return status;
  } catch (e) {
    sessaoCache = { at: agora, status: 'unknown' };
    return 'unknown';
  }
}

ipcMain.handle('deezer:sessao', (event, opts) => checarSessao({ forcar: !!(opts && opts.forcar) }));

ipcMain.handle('deezer:requireSession', async (event, opts) => {
  const status = await checarSessao({ forcar: !!(opts && opts.forcar) });
  return { ok: status === 'ok', status };
});

// ============================================================================
// ===== Explorar (API pública do Deezer) =====================================
// ============================================================================
// Cada canal é registrado UMA única vez. Todos os endpoints paginados aceitam
// { index, limit } e repassam ?limit=&index= para a API.
// `next` (URL da próxima página) vem na resposta quando há mais itens.

async function deezerPublic(path) {
  try {
    const res = await fetch(DEEZER_API + path, {
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json();
    if (json.error) return { ok: false, error: json.error.message || 'erro do Deezer' };
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Chart global completo (tracks, albums, artists, playlists) — sem paginação
ipcMain.handle('explore:chart', () => deezerPublic('/chart'));

// Faixas do chart (global ou por gênero) — paginado
ipcMain.handle('explore:chartTracks', (event, { genreId = 0, index = 0, limit = 20 } = {}) =>
  deezerPublic(`/chart/${genreId}/tracks?limit=${limit}&index=${index}`)
);

// Álbuns do chart (para "Destaques") — paginado
ipcMain.handle('explore:chartAlbums', (event, { index = 0, limit = 20 } = {}) =>
  deezerPublic(`/chart/0/albums?limit=${limit}&index=${index}`)
);

// Álbuns por gênero (compat: mantém o nome antigo, mas agora paginado)
ipcMain.handle('explore:chartGenre', (event, { genreId, index = 0, limit = 20 } = {}) => {
  if (!/^\d+$/.test(String(genreId))) return { ok: false, error: 'gênero inválido' };
  return deezerPublic(`/chart/${genreId}/albums?limit=${limit}&index=${index}`);
});

// Editoriais: seções gerais
ipcMain.handle('explore:editorial', () => deezerPublic('/editorial'));
ipcMain.handle('explore:editorialSections', () => deezerPublic('/editorial'));

// Seleção editorial (Álbuns da semana) — paginado
ipcMain.handle('explore:selection', (event, { id = 0, index = 0, limit = 20 } = {}) =>
  deezerPublic(`/editorial/${id}/selection?limit=${limit}&index=${index}`)
);

// Lançamentos editoriais — paginado
ipcMain.handle('explore:releases', (event, { id = 0, index = 0, limit = 20 } = {}) =>
  deezerPublic(`/editorial/${id}/releases?limit=${limit}&index=${index}`)
);

// Lista de gêneros (fixa, sem paginação)
ipcMain.handle('explore:genres', () => deezerPublic('/genre'));

function createWindow() {
  const win = new BrowserWindow({
    width: NORMAL_W,
    height: NORMAL_H,
    minWidth: NORMAL_MIN_W,
    minHeight: NORMAL_MIN_H,
    frame: false,
    show: false,
    backgroundColor: '#0b0b0d',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'renderer', 'favicon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // rede de segurança: se o splash não fechar, mostra a principal
  win.once('ready-to-show', () => {
    if (!splashWin) win.show();
  });

  win.on('moved', () => {
    if (!modoMini) return;
    clearTimeout(miniSaveTimer);
    miniSaveTimer = setTimeout(() => {
      if (!modoMini || !janelaPrincipal) return;
      const [x, y] = janelaPrincipal.getPosition();
      writeConfig({ miniX: x, miniY: y });
    }, 500);
  });

  return win;
}


app.whenReady().then(() => {
  createSplash();
  splashSet(5, "Iniciando…");

  servidor = createServer({
    getBasePath,
    userDataDir: app.getPath('userData'),
    resourcesPath: app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resources'),
    keychain: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (texto) => safeStorage.encryptString(texto),
      decrypt: (buffer) => safeStorage.decryptString(buffer)
    }
  });

  splashSet(20, "Abrindo a janela…");

  janelaPrincipal = createWindow();

  const organizer = createOrganizer({
    apiCall,
    getBasePath,
    restartServer: () => servidor.restart()
  });
  organizerRef = organizer;

  splashSet(45, "Organizando a biblioteca…");

  const cfg = readConfig();
  if (cfg.modoMini) {
    janelaPrincipal.webContents.once('did-finish-load', () => {
      compactarJanela(janelaPrincipal);
    });
  }

  async function waitTaskDone(taskId, timeoutMs = 5 * 60 * 1000) {
    const fim = Date.now() + timeoutMs;
    while (Date.now() < fim) {
      await new Promise((r) => setTimeout(r, 1000));
      const q = await apiCall('/queue');
      if (!q.ok) continue;
      const t = (q.data || []).find((x) => String(x.id) === String(taskId));
      if (!t) return { ok: true, sumiu: true };
      const st = t.state === 'mission accomplished' ? 'done' : t.state === 'failed' ? 'err' : 'run';
      if (st === 'done') return { ok: true };
      if (st === 'err') return { ok: false, error: (t.exception || 'falha no download').replace(/^ERROR:\s*/, '') };
    }
    return { ok: false, error: 'tempo esgotado esperando o download' };
  }

  ipcMain.handle('album:registrar', (event, album) => organizer.registrarAlbum(album || {}));
  ipcMain.handle('playlist:registrar', (event, pl) => organizer.registrarPlaylist(pl || {}));

  ipcMain.handle('library:get', () => organizer.biblioteca());
  ipcMain.handle('library:tracks', (event, rel) => organizer.faixas(rel));
  ipcMain.handle('library:ids', () => organizer.idsOffline());
  ipcMain.handle('library:path', (event, id) => organizer.caminhoDe(id));
  ipcMain.handle('library:artist', (event, nome) => organizer.faixasArtista(nome));
  ipcMain.handle('library:cover', (event, { tipo, id }) => organizer.libraryCover(tipo, id));

  ipcMain.handle('library:artistAlbums', (event, nome) => organizer.albunsDoArtista(nome));
  ipcMain.handle('library:artistPlaylists', (event, nome) => organizer.playlistsDoArtista(nome));

  organizer.start();

  async function ensureOffline(id) {
    const fid = String(id || '');
    if (!/^\d+$/.test(fid)) return { ok: false, error: 'id inválido' };

    const sess = await checarSessao();
    if (sess === 'expired') return { ok: false, error: 'sessao-expirada' };

    if (organizer.idsOffline().includes(fid)) return { ok: true };

    const r = await apiCall('/download', {
      type: 'track',
      music_id: Number(fid),
      add_to_playlist: false,
      create_zip: false
    });
    if (!r.ok) return { ok: false, error: r.error };

    const done = await waitTaskDone(r.data.task_id);
    if (!done.ok) return { ok: false, error: done.error };

    for (let i = 0; i < 30; i++) {
      if (organizer.idsOffline().includes(fid)) break;
      await new Promise((rr) => setTimeout(rr, 500));
    }
    if (!organizer.idsOffline().includes(fid)) {
      return { ok: false, error: 'download concluiu mas o organizer não moveu o arquivo' };
    }

    try {
      const info = await fetch(`https://api.deezer.com/track/${fid}`).then((r) => r.json());
      if (info && !info.error && info.album && info.album.id) {
        const albumId = String(info.album.id);
        const albumTitle = info.album.title || '';
        const albumArtist = (info.artist && info.artist.name) || '';
        const albumTracks = await fetch(
          `https://api.deezer.com/album/${albumId}/tracks?limit=100`
        ).then((r) => r.json());
        if (albumTracks && albumTracks.data && albumTracks.data.length) {
          await organizer.registrarAlbum({
            id: albumId,
            title: albumTitle,
            artist: albumArtist,
            trackIds: albumTracks.data.map((t) => t.id)
          });
        }
      }
    } catch (e) {
      /* silencioso */
    }

    return { ok: true };
  }

  // ===== Favoritos =====
  ipcMain.handle('favorites:list', () => organizer.favsList());
  ipcMain.handle('favorites:add', async (event, id) => {
    const fid = String(id || '');
    if (!/^\d+$/.test(fid)) return { ok: false, error: 'id inválido' };
    const eo = await ensureOffline(fid);
    if (!eo.ok) return eo;
    return organizer.favsAdd(fid);
  });
  ipcMain.handle('favorites:remove', (event, id) => {
    const fid = String(id || '');
    if (!/^\d+$/.test(fid)) return { ok: false, error: 'id inválido' };
    return organizer.favsRemove(fid);
  });

  // ===== Playlists do usuário =====
  ipcMain.handle('playlists:list', () => organizer.playlistsList());
  ipcMain.handle('playlists:meta', () => organizer.playlistsComMeta());
  ipcMain.handle('playlists:create', (event, title) => organizer.criarPlaylistVazia(title));
  ipcMain.handle('playlists:addFaixa', async (event, { title, id }) => {
    const fid = String(id || '');
    if (!/^\d+$/.test(fid)) return { ok: false, error: 'id inválido' };
    if (!title) return { ok: false, error: 'playlist vazia' };
    const eo = await ensureOffline(fid);
    if (!eo.ok) return eo;
    return organizer.playlistAddFaixa(title, fid);
  });
  ipcMain.handle('playlists:removeFaixa', (event, { title, id }) => {
    const fid = String(id || '');
    if (!/^\d+$/.test(fid)) return { ok: false, error: 'id inválido' };
    if (!title) return { ok: false, error: 'playlist vazia' };
    return organizer.playlistRemoveFaixa(title, fid);
  });
  ipcMain.handle('playlists:delete', (event, title) => organizer.playlistDelete(title));
  ipcMain.handle('playlists:tocar', (event, title) => organizer.playlistTocar(title));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      janelaPrincipal = createWindow();
    }
  });

  splashSet(80, "Quase lá…");
  fecharSplash();
});

let saindo = false;
app.on('before-quit', async (event) => {
  if (saindo) return;
  if (!servidor && !organizerRef) return;
  saindo = true;
  event.preventDefault();
  try {
    if (miniTopmostTimer) {
      clearInterval(miniTopmostTimer);
      miniTopmostTimer = null;
    }
    if (organizerRef && typeof organizerRef.flush === 'function') {
      try {
        organizerRef.flush();
      } catch (e) {
        /* segue o jogo */
      }
    }
    if (servidor) {
      await Promise.race([servidor.stop(), new Promise((r) => setTimeout(r, 3000))]);
    }
  } catch (e) {
    /* segue o jogo */
  }
  app.exit(0);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
