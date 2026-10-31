// ===== Servidor nativo do deezer-downloader (sem Docker) =====
// Sobe o deezer-downloader usando o Python do sistema (quando o pacote já
// está instalado) ou o Python embutido em resources\server\python.
// O ARL viaja só por variável de ambiente e fica criptografado no disco
// (safeStorage do Electron); nunca aparece em log nem na config.
//
// API pública do módulo:
//   apiBase()       -> 'http://127.0.0.1:<porta>'
//   getArl()        -> string | null
//   saveArl(arl)    -> boolean
//   status()        -> { ready, engine, arl, running, port, lastError? }
//   start(arl?)     -> { ok, port } | { ok: false, error }
//   stop()          -> void
//   restart(arl)    -> { ok, port } | { ok: false, error }

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');

const execFileP = promisify(execFile);

const BASE_PORT = 5000;
const MAX_PORT = 5020;
const START_TIMEOUT = 30000;    // ms até o servidor responder ao /queue
const CHECK_TIMEOUT = 15000;    // ms por teste de Python
const RUNTIME_RETRY_MS = 60000; // ms de cache do "não achei Python"

// TROCA (11): timeout do teste de porta. 800ms tratava serviço lento como
// "ocupado" (falso positivo) e pulava porta livre. 1500ms reduz o ruído
// sem travar o start() por muito tempo (20 portas × 1.5s = 30s no pior caso).
const PORT_CONNECT_TIMEOUT = 1500;

module.exports = ({ getBasePath, userDataDir, resourcesPath, keychain, log = console }) => {
  const serverDir = path.join(userDataDir, 'server');
  const iniPath = path.join(serverDir, 'deezer-downloader.ini');
  const ytdlpCmd = path.join(serverDir, 'yt-dlp.cmd');
  const arlPath = path.join(userDataDir, 'arl.bin');

  let child = null;
  let port = BASE_PORT;
  let parando = false;
  let runtimeCache = null;
  let runtimeCacheAt = 0;
  let lastError = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const apiBase = () => `http://127.0.0.1:${port}`;

  const apiCall = async (route) => {
    try {
      const res = await fetch(apiBase() + route);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true, data: await res.json() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  // ---- ARL: criptografado com a DPAPI do Windows (safeStorage) ------------
  const getArl = () => {
    try {
      if (!keychain.available() || !fs.existsSync(arlPath)) return null;
      const arl = keychain.decrypt(fs.readFileSync(arlPath));
      return arl || null;
    } catch (e) {
      return null;
    }
  };

  const saveArl = (arl) => {
    try {
      if (!arl || !keychain.available()) return false;
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(arlPath, keychain.encrypt(arl));
      return true;
    } catch (e) {
      return false;
    }
  };

  // ---- runtime: Python do sistema com o pacote, senão o embutido ---------
  // DEEZER_PYTHON é só para desenvolvimento/teste (aponta para um venv).
  const candidatos = () => {
    const lista = [];
    if (process.env.DEEZER_PYTHON) lista.push({ kind: 'dev', exe: process.env.DEEZER_PYTHON, pre: [] });
    lista.push({ kind: 'system', exe: 'python', pre: [] });
    lista.push({ kind: 'system', exe: 'py', pre: ['-3'] });
    const embutido = path.join(resourcesPath, 'server', 'python', 'python.exe');
    if (fs.existsSync(embutido)) lista.push({ kind: 'embedded', exe: embutido, pre: [] });
    return lista;
  };

  const temPacote = async (c) => {
    try {
      await execFileP(c.exe, [...c.pre, '-c', 'import deezer_downloader'], {
        timeout: CHECK_TIMEOUT,
        windowsHide: true
      });
      return true;
    } catch (e) {
      return false; // sem python, versão < 3.10 ou pacote não instalado
    }
  };

  // Cacheia o resultado (inclusive null) por RUNTIME_RETRY_MS.
  // Sem isso, cada status() numa máquina sem Python levava 3×15s = 45s.
  const resolverRuntime = async () => {
    const agora = Date.now();
    if (runtimeCache !== null) return runtimeCache;
    if (runtimeCache === null && runtimeCacheAt && agora - runtimeCacheAt < RUNTIME_RETRY_MS) {
      return null; // "não achei" recente: não re-tenta agora
    }

    for (const c of candidatos()) {
      if (await temPacote(c)) {
        runtimeCache = c;
        runtimeCacheAt = agora;
        return c;
      }
    }

    runtimeCacheAt = agora; // marca o "não achei" para o cooldown
    return null;
  };

  // ---- porta: 5000 e, se estiver ocupada (ex.: Docker aberto), a próxima --
  // O Docker escuta em IPv6 (::), então testar com "listen em 127.0.0.1" dá
  // falso livre. O teste certo é tentar CONECTAR: se conecta, está ocupada.
  //
  // TROCA (11): timeout de 800ms subiu pra 1500ms e agora distingue os dois
  // casos (ECONNREFUSED = livre de verdade; timeout = ocupado por firewall
  // ou serviço que não responde; qualquer outro erro = assume livre).
  const portaOcupada = (p) =>
    new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port: p });
      let resolvido = false;
      const fim = (ocupada) => {
        if (resolvido) return;
        resolvido = true;
        clearTimeout(timer);
        s.destroy();
        resolve(ocupada);
      };
      const timer = setTimeout(() => fim(true), PORT_CONNECT_TIMEOUT);
      s.once('connect', () => fim(true));
      s.once('error', (err) => {
        // ECONNREFUSED = livre. Qualquer outro código (EHOSTUNREACH, etc)
        // a gente assume livre também — o start() vai falhar depois com erro
        // claro se a porta estiver de fato indisponível.
        fim(err && err.code === 'ECONNREFUSED' ? false : false);
      });
    });

  const acharPorta = async () => {
    for (let p = BASE_PORT; p <= MAX_PORT; p++) {
      if (!(await portaOcupada(p))) return p;
    }
    return null; // nenhuma livre
  };

  // ---- config.ini + atalho do yt-dlp (gerados a cada início) -------------
  // O configparser do Python NÃO remove aspas do valor: ele devolve o texto
  // literal depois do '='. Então NÃO colocamos aspas em volta (senão o
  // os.path.exists() do deezer_downloader falha).
  // '%' continua sendo interpolação: precisa virar '%%'.
  const iniValue = (v) => String(v ?? '').replace(/%/g, '%%');

  const escreverConfig = (rt, p) => {
    const base = getBasePath();
    fs.mkdirSync(serverDir, { recursive: true });

    // o [youtubedl] precisa de um caminho existente; o wrapper usa o mesmo Python.
    // Aqui SIM usamos aspas (é um .cmd/.bat, e o caminho pode ter espaço).
    const pre = rt.pre.length ? ' ' + rt.pre.join(' ') : '';
    fs.writeFileSync(ytdlpCmd, `@echo off\r\n"${rt.exe}"${pre} -m yt_dlp %*\r\n`, 'utf8');

    const ini = `[mpd]
use_mpd = False
host = localhost
port = 6600
music_dir_root = ${iniValue(base)}

[download_dirs]
base = ${iniValue(base)}

songs = %(base)s/songs
albums = %(base)s/albums
zips = %(base)s/zips
playlists = %(base)s/playlists
youtubedl = %(base)s/youtube-dl

[debug]
command = echo sem debug no windows

[http]
host = 127.0.0.1
port = ${p}
url_prefix =
api_root = %(url_prefix)s
static_root = %(url_prefix)s/static

[proxy]
server =

[threadpool]
workers = 4

[deezer]
cookie_arl = ${'0'.repeat(192)}
quality = mp3

[youtubedl]
command = ${iniValue(ytdlpCmd)}
`;
    fs.writeFileSync(iniPath, ini, 'utf8');
  };

  // ---- start / stop ------------------------------------------------------
  const start = async (arl = getArl()) => {
    if (child) return { ok: true, port };
    if (!getBasePath()) {
      lastError = 'nenhuma pasta de downloads escolhida';
      return { ok: false, error: lastError };
    }
    if (!arl) {
      lastError = 'precisa entrar com o Deezer';
      return { ok: false, error: lastError };
    }

    const rt = await resolverRuntime();
    if (!rt) {
      lastError = 'componente de download (Python) não encontrado';
      return { ok: false, error: lastError };
    }

    const p = await acharPorta();
    if (p === null) {
      lastError = `nenhuma porta livre entre ${BASE_PORT} e ${MAX_PORT}`;
      return { ok: false, error: lastError };
    }
    port = p;

    try {
      escreverConfig(rt, port);
    } catch (e) {
      lastError = `não consegui escrever a configuração: ${e.message}`;
      return { ok: false, error: lastError };
    }

    parando = false;
    lastError = null;

    const args = [...rt.pre, '-c', 'from deezer_downloader.cli.runner import main; main()', '-c', iniPath];

    // Remove ARL antigo do env herdado (evita surpresa em alguns shells Windows).
    const env = { ...process.env };
    delete env.DEEZER_COOKIE_ARL;
    delete env.DEEZER_QUALITY;
    Object.assign(env, {
      DEEZER_COOKIE_ARL: arl,
      DEEZER_QUALITY: 'mp3',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1'
    });

    child = spawn(rt.exe, args, {
      cwd: serverDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let saida = '';
    const guardar = (buf) => {
      saida = (saida + buf.toString('utf8')).slice(-4000).split(arl).join('***');
    };
    child.stdout.on('data', guardar);
    child.stderr.on('data', guardar);
    child.on('exit', (code) => {
      if (!parando) {
        log.warn(`server: processo encerrou (código ${code})${saida ? ' — ' + saida.trim().slice(-200) : ''}`);
      }
      child = null;
    });

    for (let i = 0; i < START_TIMEOUT / 500; i++) {
      await sleep(500);
      if (!child) break; // morreu antes de responder
      if ((await apiCall('/queue')).ok) return { ok: true, port };
    }

    lastError = 'o servidor não respondeu' + (saida ? ': ' + saida.trim().slice(-300) : '');
    await stop();
    return { ok: false, error: lastError };
  };

  const stop = async () => {
    const proc = child;
    if (!proc) return;
    parando = true;
    child = null;

    // Espera o processo realmente morrer antes de resetar `parando`.
    // Sem isso, o exit do processo ANTIGO chega com `parando = false`
    // e o log grita "processo encerrou (código 1)" num restart normal.
    const morto = new Promise((resolve) => {
      if (proc.exitCode !== null || proc.killed) return resolve();
      proc.once('exit', resolve);
      proc.once('error', resolve);
      setTimeout(resolve, 3000);
    });

    try {
      if (process.platform === 'win32') {
        // detached: o taskkill continua mesmo se o app estiver fechando;
        // /T mata a árvore (python + processos que ele abriu)
        await new Promise((resolve) => {
          const k = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
            detached: true
          });
          k.unref();
          k.once('exit', resolve);
          k.once('error', resolve);
          setTimeout(resolve, 3000);
        });
      } else {
        proc.kill('SIGTERM');
      }
    } catch (e) {
      /* já morreu */
    }

    await morto;
    parando = false;
  };

  // ---- API pública do módulo --------------------------------------------
  const status = async () => {
    const arl = getArl();
    const rt = await resolverRuntime();
    const base = {
      engine: rt ? rt.kind : 'missing',
      arl: arl ? 'saved' : 'none',
      running: !!child,
      lastError: lastError || undefined
    };

    if (!rt) return { ...base, ready: false };
    if (!child) return { ...base, ready: false };

    const q = await apiCall('/queue');
    return { ...base, ready: q.ok, port };
  };

  const restart = async (arl) => {
    await stop();
    const r = await start(arl);
    if (r.ok && arl) saveArl(arl); // só guarda quando o servidor subiu
    return r;
  };

  return { apiBase, getArl, saveArl, status, start, stop, restart };
};