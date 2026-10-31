// ===== Organizer: gestão dos arquivos baixados pelo kmille2 =====
// A cada ORG_INTERVAL ms lê a fila do servidor. Para cada tarefa em
// "mission accomplished" que ainda não está no índice, MOVE os arquivos da
// área de trabalho do kmille2 (songs\, albums\, playlists\...) para a biblioteca:
//
//   <basePath>\Artistas\<artista>\<nome original do kmille2>__<id>.mp3
//
// e grava em <basePath>\.deezer\indice.json o mapa id -> { rel, albumId, artistId }
// e a lista de tarefas já tratadas (nada é processado duas vezes).
//
// O albumId/artistId no índice permitem que as faixas offline mostrem a capa
// e o link do artista SEM chamar a API (offline-first). O readIndex aceita
// formato antigo (string) e novo (objeto).
//
// Concorrência: índice, albuns.json e playlists.json são protegidos por um
// mutex simples (fila de Promise) para evitar read-modify-write perdido
// entre organizeOnce, fecharAlbuns, fecharPlaylists e backfill*.
//
// Persistência: writeIndex/writeAlbuns/writePlaylists/writeCovers/writeFalhas/
// writeMeta gravam em .tmp e renomeiam (atômico no NTFS) — ver writeJSON.
// Um dirty flag por arquivo permite que flush() no before-quit só escreva
// o que está sujo.
//
// Metadados de playlist: .deezer/playlists-meta.json guarda { criada, ultima }
// por nome de playlist (ISO). "ultima" é atualizada quando uma faixa da
// playlist toca (playlistTocar). O TTL é decidido no renderer.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ORG_INTERVAL = 5000;
const AUDIO = /\.(mp3|flac|m4a|ogg|opus)$/i;

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const FAVS_FILE = 'mais-queridas.m3u8';
const FAVS_REL = path.join('Playlists', FAVS_FILE);
const FAVS_TITLE = 'mais-queridas';

module.exports = ({ apiCall, getBasePath, restartServer, log = console }) => {
  // ==========================================================================
  // MUTEX
  // ==========================================================================

  const filas = new Map();

  const comFila = (nome, fn) => {
    const anterior = filas.get(nome) || Promise.resolve();
    const proxima = anterior.then(fn, fn);
    filas.set(nome, proxima.catch(() => {}));
    return proxima;
  };

  const withIndex = (fn) => comFila('index', fn);
  const withAlbuns = (fn) => comFila('albuns', fn);
  const withPlaylists = (fn) => comFila('playlists', fn);

  // ==========================================================================
  // PERSISTÊNCIA ATÔMICA + DIRTY FLAG
  // ==========================================================================

  const dirty = new Map();

  const marcarSujo = (file, data) => {
    if (!file) return;
    dirty.set(file, { data });
  };

  const limparSujo = (file) => {
    if (file) dirty.delete(file);
  };

  const writeJSON = (file, data) => {
    if (!file) return;
    const tmp = file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const json = JSON.stringify(data, null, 2);
      fs.writeFileSync(tmp, json, 'utf8');
      fs.renameSync(tmp, file);
      limparSujo(file);
    } catch (e) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch (_) {}
      throw e;
    }
  };

  const flush = () => {
    let escritos = 0;
    for (const [file, { data }] of dirty) {
      try {
        writeJSON(file, data);
        escritos++;
      } catch (e) {
        log.warn(`organizer: flush falhou em ${path.basename(file)}: ${e.message}`);
      }
    }
    return escritos;
  };

  // ==========================================================================
  // ÍNDICE
  // ==========================================================================

  const indexPath = () => {
    const base = getBasePath();
    return base ? path.join(base, '.deezer', 'indice.json') : null;
  };

  const readIndex = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
      const tracks = {};
      for (const [id, v] of Object.entries(raw.tracks || {})) {
        tracks[id] = typeof v === 'string' ? { rel: v } : v;
      }
      return { tracks, tasks: raw.tasks || [] };
    } catch (e) {
      return { tracks: {}, tasks: [] };
    }
  };

  const writeIndex = (idx) => {
    const file = indexPath();
    if (!file) return;
    marcarSujo(file, idx);
    writeJSON(file, idx);
  };

  const relDe = (v) => (v && typeof v === 'object' ? v.rel : v) || '';

  // ==========================================================================
  // CAPAS
  // ==========================================================================

  const coversPath = () => {
    const base = getBasePath();
    return base ? path.join(base, '.deezer', 'covers.json') : null;
  };

  const readCovers = () => {
    try {
      const c = JSON.parse(fs.readFileSync(coversPath(), 'utf8'));
      return c && typeof c === 'object' ? c : {};
    } catch (e) {
      return {};
    }
  };

  const writeCovers = (c) => {
    const file = coversPath();
    if (!file) return;
    marcarSujo(file, c);
    writeJSON(file, c);
  };

  const registrarCapa = (chave, rel) => {
    const c = readCovers();
    if (c[chave] === rel) return;
    c[chave] = rel;
    writeCovers(c);
  };

  const baixarImagem = async (url, destinoAbs) => {
    if (!url) return false;
    if (fs.existsSync(destinoAbs)) return true;
    try {
      const res = await fetch(url);
      if (!res.ok) return false;
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(destinoAbs), { recursive: true });
      fs.writeFileSync(destinoAbs, buf);
      return true;
    } catch (e) {
      return false;
    }
  };

  const garantirCapaAlbum = async (albumId) => {
    if (!albumId) return;
    const base = getBasePath();
    if (!base) return;
    const chave = `album:${albumId}`;
    const covers = readCovers();
    if (covers[chave] && fs.existsSync(path.join(base, covers[chave]))) return;

    const info = await deezerGet(`https://api.deezer.com/album/${albumId}`);
    if (!info || !info.cover_big) return;

    const artista = safeName((info.artist && info.artist.name) || 'Desconhecido');
    const art = path.join('Artistas', artista, '.covers', `${albumId}.jpg`);
    const alb = path.join('Albuns', artista, '.covers', `${albumId}.jpg`);

    const okA = await baixarImagem(info.cover_big, path.join(base, art));
    const okB = okA ? await baixarImagem(info.cover_big, path.join(base, alb)) : false;

    if (okA && okB) {
      registrarCapa(chave, alb);
      registrarCapa(`album@art:${albumId}`, art);
    }
  };

  const garantirCapaArtista = async (artistId, artistaNome) => {
    if (!artistId || !artistaNome) return;
    const base = getBasePath();
    if (!base) return;
    const chave = `artist:${artistId}`;
    const covers = readCovers();
    if (covers[chave] && fs.existsSync(path.join(base, covers[chave]))) return;

    const info = await deezerGet(`https://api.deezer.com/artist/${artistId}`);
    if (!info || !info.picture_big) return;

    const artista = safeName(artistaNome);
    const rel = path.join('Artistas', artista, '.artist.jpg');
    const ok = await baixarImagem(info.picture_big, path.join(base, rel));
    if (ok) registrarCapa(chave, rel);
  };

  const garantirCapaPlaylist = async (playlistId, titulo) => {
    if (!playlistId) return;
    const base = getBasePath();
    if (!base) return;
    const chave = `playlist:${playlistId}`;
    const covers = readCovers();
    if (covers[chave] && fs.existsSync(path.join(base, covers[chave]))) return;

    const info = await deezerGet(`https://api.deezer.com/playlist/${playlistId}`);
    if (!info || !info.picture_big) return;

    const rel = path.join('Playlists', '.covers', `${playlistId}.jpg`);
    const ok = await baixarImagem(info.picture_big, path.join(base, rel));
    if (ok) registrarCapa(chave, rel);
  };

  // ==========================================================================
  // LEITURA DO ARGS/RESULT
  // ==========================================================================

  const decodeHtml = (s) =>
    String(s)
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');

  const pyStrings = (src) => {
    const out = [];
    const re = /(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
    let m;
    while ((m = re.exec(src))) {
      const raw = m[1] === undefined ? m[2] : m[1];
      out.push(
        String(raw).replace(/\\(.)/g, (_, ch) => {
          if (ch === 'n') return '\n';
          if (ch === 'r') return '\r';
          if (ch === 't') return '\t';
          return ch;
        })
      );
    }
    return out;
  };

  const parseArgs = (src) => {
    const s = decodeHtml(src);
    const track = /track_id['"]?\s*:\s*(\d+)/.exec(s);
    if (track) return { kind: 'track', id: Number(track[1]) };
    const album = /album_id['"]?\s*:\s*(\d+)/.exec(s);
    if (album) return { kind: 'album', id: Number(album[1]) };
    const pl = /playlist_url['"]?\s*:\s*['"]?([^'",}]+)['"]?/.exec(s);
    if (pl) {
      const m = /playlist\/(\d+)/.exec(pl[1]);
      if (m) return { kind: 'playlist', id: Number(m[1]) };
    }
    return null;
  };

  // ==========================================================================
  // NOMES / NORMALIZAÇÃO
  // ==========================================================================

  const safeName = (s) => {
    let n = String(s)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '')
      .slice(0, 120);
    if (!n) return n;
    if (RESERVED.test(n)) n = '_' + n;
    return n;
  };

  const norm = (s) =>
    String(s ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');

  const chaveNome = (nome) => {
    const sep = nome.indexOf(' - ');
    if (sep < 0) return norm(nome) + '|';
    return norm(nome.slice(0, sep)) + '|' + norm(nome.slice(sep + 3));
  };

  // ==========================================================================
  // API PÚBLICA DO DEEZER
  // ==========================================================================

  const deezerGet = async (url) => {
    try {
      const res = await fetch(url);
      const json = await res.json();
      return json && json.error ? null : json;
    } catch (e) {
      return null;
    }
  };

  const albumTracks = (id) =>
    deezerGet(`https://api.deezer.com/album/${id}/tracks?limit=100`).then((json) => (json && json.data) || []);

  const playlistTracks = async (id) => {
    const out = [];
    for (let index = 0; index < 5000; index += 100) {
      const json = await deezerGet(`https://api.deezer.com/playlist/${id}/tracks?limit=100&index=${index}`);
      if (!json || !json.data) return null;
      out.push(...json.data);
      if (!json.next || !json.data.length) break;
    }
    return out;
  };

  // ==========================================================================
  // PASTAS DE TRABALHO
  // ==========================================================================

  const WORKSPACE_DIRS = ['songs', 'albums', 'playlists', 'youtube-dl', 'zips'];

  const ensureWorkspace = (rootDir) => {
    WORKSPACE_DIRS.forEach((d) => fs.mkdirSync(path.join(rootDir, d), { recursive: true }));
  };

  // ==========================================================================
  // METADADOS DE PLAYLIST (.deezer/playlists-meta.json)
  // ==========================================================================

  const metaPath = () => {
    const base = getBasePath();
    return base ? path.join(base, '.deezer', 'playlists-meta.json') : null;
  };

  const readMeta = () => {
    try {
      const m = JSON.parse(fs.readFileSync(metaPath(), 'utf8'));
      return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
    } catch (e) {
      return {};
    }
  };

  const writeMeta = (m) => {
    const file = metaPath();
    if (!file) return;
    marcarSujo(file, m);
    writeJSON(file, m);
  };

  const tocarMeta = (nome) => {
    const m = readMeta();
    const key = String(nome || '').trim();
    if (!key) return;
    if (!m[key]) m[key] = { criada: new Date().toISOString(), ultima: null };
    m[key].ultima = new Date().toISOString();
    writeMeta(m);
  };

  const criarMetaSeFaltar = (nome) => {
    const m = readMeta();
    const key = String(nome || '').trim();
    if (!key) return;
    if (!m[key]) {
      m[key] = { criada: new Date().toISOString(), ultima: null };
      writeMeta(m);
    }
  };

  const apagarMeta = (nome) => {
    const m = readMeta();
    const key = String(nome || '').trim();
    if (!key) return;
    if (m[key]) {
      delete m[key];
      writeMeta(m);
    }
  };

  // ==========================================================================
  // MOVER PARA Artistas\<artista>
  // ==========================================================================

  const moveToArtist = (src, artistName, id) => {
    const name = safeName(artistName);
    if (!name) return null;

    const base = getBasePath();
    if (!base) return null;
    ['Playlists', 'Albuns'].forEach((d) => fs.mkdirSync(path.join(base, d), { recursive: true }));

    const folder = path.join(base, 'Artistas', name);
    fs.mkdirSync(folder, { recursive: true });

    const dest = path.join(
      folder,
      `${safeName(path.parse(src).name)}${id ? '__' + id : ''}${path.extname(src)}`
    );

    try {
      const srcStat = fs.statSync(src);
      const destStat = fs.existsSync(dest) ? fs.statSync(dest) : null;
      if (destStat && destStat.size === srcStat.size) {
        try {
          fs.unlinkSync(src);
        } catch (e) {
          /* src em uso: o próximo ciclo tenta de novo */
        }
        return path.relative(base, dest);
      }
    } catch (e) {
      /* stat falhou: cai no renameSync */
    }

    try {
      fs.renameSync(src, dest);
      return path.relative(base, dest);
    } catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') {
        log.warn(`organizer: moveToArtist falhou em "${path.basename(src)}": ${e.message}`);
        return null;
      }
    }

    try {
      const t = Date.now() + 300;
      while (Date.now() < t) {
        /* busy-wait 300ms */
      }
      fs.renameSync(src, dest);
      return path.relative(base, dest);
    } catch (e) {
      /* cai no fallback */
    }

    try {
      const tmp = dest + '.tmp';
      fs.copyFileSync(src, tmp);
      let renomeou = false;
      try {
        fs.renameSync(tmp, dest);
        renomeou = true;
      } catch (e3) {
        try {
          fs.unlinkSync(tmp);
        } catch (_) {}
      }
      try {
        fs.unlinkSync(src);
      } catch (_) {}
      if (renomeou || fs.existsSync(dest)) {
        return path.relative(base, dest);
      }
    } catch (e) {
      /* copy falhou: desiste */
    }

    log.warn(`organizer: moveToArtist falhou em "${path.basename(src)}" (EPERM/EBUSY)`);
    return null;
  };

  const cleanDirs = (dirs, rootDir) => {
    const root = path.resolve(rootDir);
    [...new Set(dirs)]
      .filter((dir) => path.resolve(path.dirname(path.resolve(dir))) !== root)
      .sort((a, b) => b.length - a.length)
      .forEach((dir) => {
        try {
          fs.rmdirSync(dir);
        } catch (e) {
          /* não está vazia: deixa quieto */
        }
      });
  };

  // ==========================================================================
  // UMA FAIXA AVULSA
  // ==========================================================================

  const organizeTrack = async (src, id) => {
    let artist = artistaDoAlbum(id);
    let info = null;

    if (id) {
      info = await deezerGet(`https://api.deezer.com/track/${id}`);
      if (info && info.artist && !artist) artist = info.artist.name;
    }

    if (!artist) {
      artist = path.parse(src).name.split(' - ')[0].trim();
    }

    if (!artist) return null;
    if (!id) log.warn(`organizer: faixa sem id em "${path.basename(src)}"`);

    const rel = moveToArtist(src, artist, id);
    if (!rel) return null;

    if (info && info.album) garantirCapaAlbum(info.album.id).catch(() => {});
    if (info && info.artist) garantirCapaArtista(info.artist.id, artist).catch(() => {});

    return {
      rel,
      albumId: info && info.album ? String(info.album.id) : '',
      artistId: info && info.artist ? String(info.artist.id) : ''
    };
  };

  // ==========================================================================
  // UMA FAIXA DE ÁLBUM
  // ==========================================================================

  const organizeAlbumFile = (src, albumId, tracks, albumArtist) => {
    const nn = /^(\d+)\s*-/.exec(path.parse(src).name);
    const t = nn && tracks.find((x) => x.track_position === Number(nn[1]));
    const artist = (t && t.artist && t.artist.name) || albumArtist;

    if (t && artist) {
      const rel = moveToArtist(src, artist, t.id);
      if (!rel) return null;
      garantirCapaAlbum(albumId).catch(() => {});
      if (t.artist && t.artist.id) garantirCapaArtista(t.artist.id, artist).catch(() => {});
      return {
        rel,
        albumId: String(albumId),
        artistId: t.artist && t.artist.id ? String(t.artist.id) : ''
      };
    }

    if (!artist) return null;
    log.warn(`organizer: álbum ${albumId}: "${path.basename(src)}" não casou com nenhuma faixa`);
    const rel = moveToArtist(src, artist, null);
    return rel ? { rel, albumId: String(albumId), artistId: '' } : null;
  };

  // ==========================================================================
  // UMA PLAYLIST
  // ==========================================================================

  const organizePlaylist = async (src, playlistId) => {
    const tracks = await playlistTracks(playlistId);
    if (!tracks) return { pending: true };

    const porNome = new Map();
    for (const t of tracks) {
      const nome = `${t.artist && t.artist.name ? t.artist.name : ''} - ${t.title || ''}`;
      const chave = chaveNome(nome);
      if (!porNome.has(chave)) porNome.set(chave, []);
      porNome.get(chave).push(t);
    }

    const nomeArq = path.parse(src).name;
    const chaveArq = chaveNome(nomeArq);
    const lista = porNome.get(chaveArq);
    if (!lista || !lista.length) {
      log.warn(`organizer: playlist ${playlistId}: "${nomeArq}" não casou com nenhuma faixa`);
      return { pending: true };
    }

    const t = lista.shift();
    const artist = (t.artist && t.artist.name) || 'Desconhecido';
    const rel = moveToArtist(src, artist, t.id);
    if (!rel) return { pending: true };

    if (t.album && t.album.id) garantirCapaAlbum(t.album.id).catch(() => {});
    garantirCapaPlaylist(playlistId).catch(() => {});
    if (t.artist && t.artist.id) garantirCapaArtista(t.artist.id, artist).catch(() => {});

    return {
      pending: false,
      trackId: t.id,
      entry: {
        rel,
        albumId: t.album && t.album.id ? String(t.album.id) : '',
        artistId: t.artist && t.artist.id ? String(t.artist.id) : ''
      }
    };
  };

  // ==========================================================================
  // VARREDURA DA FILA
  // ==========================================================================

  let busy = false;

  const organizeOnce = async () => {
    const base = getBasePath();
    if (!base || busy || recuperando) return;
    busy = true;

    try {
      const rootDir = base;
      if (!fs.existsSync(rootDir)) return;

      ensureWorkspace(rootDir);

      const queue = await apiCall('/queue');
      if (!queue.ok) return;

      const idx = readIndex();
      const done = new Set(idx.tasks);
      const todo = (queue.data || []).filter(
        (t) => t.state === 'mission accomplished' && !done.has(String(t.id))
      );
      if (!todo.length) return;

      for (const task of todo) {
        const args = parseArgs(task.args);
        if (!args) continue;

        const files = pyStrings(decodeHtml(task.result)).filter((p) => AUDIO.test(p));
        if (!files.length) continue;

        let albumTracksCache = [];
        let albumArtist = null;
        if (args.kind === 'album') {
          albumTracksCache = await albumTracks(args.id);
          const album = await deezerGet(`https://api.deezer.com/album/${args.id}`);
          albumArtist = album && album.artist && album.artist.name;
        }

        let playlistOrdem = null;
        if (args.kind === 'playlist') playlistOrdem = await playlistTracks(args.id);
        if (args.kind === 'playlist' && !playlistOrdem) {
          log.log(`organizer: playlist ${args.id} aguardando a API voltar`);
          continue;
        }

        const touched = [];
        let pending = false;
        const idsPlaylist = [];
        const entriesNovas = [];

        for (const rel of files) {
          const src = path.join(rootDir, rel);
          try {
            if (!fs.existsSync(src)) continue;

            let entry = null;
            let entryId = null;

            if (args.kind === 'track') {
              entry = await organizeTrack(src, args.id);
              if (entry && entry.rel) entryId = String(args.id);
            } else if (args.kind === 'album') {
              entry = organizeAlbumFile(src, args.id, albumTracksCache, albumArtist);
              if (entry && entry.rel) {
                const fm = /__(\d+)\.\w+$/.exec(entry.rel);
                if (fm) entryId = fm[1];
              }
            } else if (args.kind === 'playlist') {
              const r = await organizePlaylist(src, args.id);
              if (r.pending) {
                pending = true;
                break;
              }
              entry = r.entry;
              entryId = String(r.trackId);
              idsPlaylist.push(r.trackId);
            }

            if (!entry || !entry.rel) {
              if (!fs.existsSync(src)) continue;
              pending = true;
              continue;
            }

            entriesNovas.push({ id: entryId, entry });
            touched.push(path.dirname(src));
          } catch (e) {
            log.warn(`organizer: ${e.message}`);
            pending = true;
          }
        }

        if (!pending) {
          for (const { id, entry } of entriesNovas) {
            if (id) idx.tracks[String(id)] = entry;
          }

          idx.tasks.push(String(task.id));
          cleanDirs(touched, rootDir);
          await withIndex(() => writeIndex(idx));

          if (args.kind === 'playlist' && idsPlaylist.length) {
            const ordenados = [...new Set(idsPlaylist)].sort(
              (a, b) =>
                playlistOrdem.findIndex((t) => t.id === a) - playlistOrdem.findIndex((t) => t.id === b)
            );
            const primeiraRel = files[0].replace(/\\/g, '/');
            const partes = primeiraRel.split('/');
            const nomePlaylist = partes.length > 1 ? partes[1] : `Playlist ${args.id}`;
            await registrarPlaylist({
              id: args.id,
              title: nomePlaylist,
              trackIds: ordenados
            });
            log.log(`organizer: playlist "${nomePlaylist}" registrada (${ordenados.length} faixas)`);
          }

          log.log(`organizer: tarefa ${task.id} organizada (${files.length} arquivos)`);
        }
      }
    } finally {
      busy = false;
    }
  };

  // ==========================================================================
  // RECONSTRUÇÃO A PARTIR DO DISCO
  // ==========================================================================

  const reconstruirIndice = () =>
    withIndex(() => {
      const base = getBasePath();
      if (!base) return 0;
      const artistsDir = path.join(base, 'Artistas');
      if (!fs.existsSync(artistsDir)) return 0;

      const idx = readIndex();
      let added = 0;

      const walk = (dir) => {
        let itens = [];
        try {
          itens = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
          return;
        }
        for (const it of itens) {
          const full = path.join(dir, it.name);
          if (it.isDirectory()) {
            walk(full);
            continue;
          }
          if (!AUDIO.test(it.name)) continue;
          const m = /__(\d+)\.[^.]+$/.exec(it.name);
          if (!m) continue;
          const id = m[1];
          if (idx.tracks[id] && relDe(idx.tracks[id])) continue;
          idx.tracks[id] = { rel: path.relative(base, full) };
          added++;
        }
      };

      walk(artistsDir);
      if (added) {
        writeIndex(idx);
        log.log(`organizer: índice reconstruído (+${added} faixas)`);
      }
      return added;
    });

  const reconstruirAlbuns = () =>
    withAlbuns(() => {
      const base = getBasePath();
      if (!base) return 0;
      const albunsDir = path.join(base, 'Albuns');
      if (!fs.existsSync(albunsDir)) return 0;

      const list = readAlbuns();
      const chave = (artist, title) => safeName(artist) + '|' + safeName(title);
      const existentes = new Set(list.map((a) => chave(a.artist, a.title)));
      let added = 0;

      const walk = (dir, artistaPai) => {
        let itens = [];
        try {
          itens = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
          return;
        }
        for (const it of itens) {
          const full = path.join(dir, it.name);
          if (it.isDirectory()) {
            walk(full, it.name);
            continue;
          }
          if (!/\.m3u8$/i.test(it.name)) continue;

          const title = it.name.replace(/\.m3u8$/i, '');
          const artist = artistaPai || '';
          if (!title || !artist) continue;
          if (existentes.has(chave(artist, title))) continue;

          let albumId = '';
          const trackIds = [];
          try {
            const linhas = fs.readFileSync(full, 'utf8').split(/\r?\n/);
            for (const l of linhas) {
              const mAlbum = /^#ALBUM:(\d+)\s*$/.exec(l.trim());
              if (mAlbum) {
                albumId = mAlbum[1];
                continue;
              }
              if (l.startsWith('#') || !l.trim()) continue;
              const m = /__(\d+)\.[^.]+$/.exec(l);
              if (m) trackIds.push(m[1]);
            }
          } catch (e) {
            continue;
          }
          if (!trackIds.length) continue;

          list.push({ id: albumId, title, artist, trackIds });
          existentes.add(chave(artist, title));
          added++;
        }
      };

      walk(albunsDir, '');
      if (added) {
        writeAlbuns(list);
        log.log(`organizer: albuns.json reconstruído (+${added} álbuns)`);
      }
      return added;
    });

  const backfillAlbumIds = () =>
    withIndex(async () => {
      const base = getBasePath();
      if (!base) return 0;
      const idx = readIndex();
      const covers = readCovers();

      const porArtista = new Map();
      const artistaDeCover = new Map();
      for (const [k, rel] of Object.entries(covers)) {
        const partes = String(rel).replace(/\\/g, '/').split('/');
        if (partes.length < 3) continue;
        if (partes[0] === 'Albuns' && partes[2] === '.covers') {
          const artista = partes[1].toLowerCase();
          const m = /^album:(\d+)$/.exec(k);
          if (m && !porArtista.has(artista)) porArtista.set(artista, m[1]);
        }
        if (partes[0] === 'Artistas' && partes[2] === '.artist.jpg') {
          const artista = partes[1].toLowerCase();
          const m = /^artist:(\d+)$/.exec(k);
          if (m && !artistaDeCover.has(artista)) artistaDeCover.set(artista, m[1]);
        }
      }

      let mudou = 0;
      const semApi = [];
      for (const [id, entry] of Object.entries(idx.tracks)) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.albumId) continue;

        const rel = relDe(entry);
        if (!rel) continue;
        const partes = rel.replace(/\\/g, '/').split('/');
        if (partes.length < 3 || partes[0] !== 'Artistas') continue;
        const artista = partes[1].toLowerCase();
        const albumId = porArtista.get(artista) || '';
        const artistId = artistaDeCover.get(artista) || '';
        if (!albumId && !artistId) {
          semApi.push(id);
          continue;
        }
        idx.tracks[id] = {
          rel,
          albumId: entry.albumId || albumId,
          artistId: entry.artistId || artistId
        };
        mudou++;
      }

      if (mudou) writeIndex(idx);

      if (semApi.length) {
        let viaApi = 0;
        for (const id of semApi) {
          if (!idx.tracks[id] || idx.tracks[id].albumId) continue;
          const info = await deezerGet(`https://api.deezer.com/track/${id}`);
          if (!info || !info.album || !info.album.id) continue;
          idx.tracks[id] = {
            ...idx.tracks[id],
            albumId: String(info.album.id),
            artistId:
              info.artist && info.artist.id
                ? String(info.artist.id)
                : idx.tracks[id].artistId || ''
          };
          viaApi++;
          await new Promise((r) => setTimeout(r, 50));
        }
        if (viaApi) {
          writeIndex(idx);
          log.log(`organizer: backfill de albumId via API (+${viaApi} faixas)`);
        }
        mudou += viaApi;
      }

      if (mudou) log.log(`organizer: backfill de albumId/artistId (+${mudou} faixas)`);
      return mudou;
    });

  // ==========================================================================
  // BACKFILL DE ÁLBUNS A PARTIR DO ÍNDICE
  // ==========================================================================

  const backfillAlbunsDoIndice = () =>
    withAlbuns(async () => {
      const base = getBasePath();
      if (!base) return 0;
      const idx = readIndex();
      const list = readAlbuns();
      const jaTem = new Set(list.map((a) => String(a.id)));

      const porAlbum = new Map();
      for (const [id, entry] of Object.entries(idx.tracks)) {
        if (!entry || !entry.albumId) continue;
        if (!porAlbum.has(entry.albumId)) porAlbum.set(entry.albumId, []);
        porAlbum.get(entry.albumId).push(String(id));
      }

      let added = 0;
      for (const [albumId, trackIds] of porAlbum) {
        if (jaTem.has(String(albumId))) continue;

        let title = '';
        let artist = '';
        const info = await deezerGet(`https://api.deezer.com/album/${albumId}`);
        if (info && info.title) {
          title = info.title;
          artist = (info.artist && info.artist.name) || '';
        }

        if (!artist) {
          for (const tid of trackIds) {
            const rel = relDe(idx.tracks[tid]);
            if (!rel) continue;
            const partes = rel.replace(/\\/g, '/').split('/');
            if (partes.length >= 3 && partes[0] === 'Artistas') {
              artist = partes[1];
              break;
            }
          }
        }
        if (!title) title = `Álbum ${albumId}`;
        if (!artist) artist = 'Desconhecido';

        list.push({ id: String(albumId), title, artist, trackIds });
        jaTem.add(String(albumId));
        added++;
        await new Promise((r) => setTimeout(r, 80));
      }

      if (added) {
        writeAlbuns(list);
        log.log(`organizer: backfill de álbuns do índice (+${added} álbuns)`);
      }
      return added;
    });

  // ==========================================================================
  // BACKFILL VIA API (.m3u8 sem #ALBUM:<id>)
  // ==========================================================================

  const backfillAlbunsViaAPI = () =>
    withAlbuns(async () => {
      const base = getBasePath();
      if (!base) return 0;
      const albunsDir = path.join(base, 'Albuns');
      if (!fs.existsSync(albunsDir)) return 0;

      const list = readAlbuns();
      const chave = (artist, title) => safeName(artist) + '|' + safeName(title);
      const existentes = new Set(list.map((a) => chave(a.artist, a.title)));
      let mudou = 0;

      const walk = async (dir, artistaPai) => {
        let itens = [];
        try {
          itens = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
          return;
        }
        for (const it of itens) {
          const full = path.join(dir, it.name);
          if (it.isDirectory()) {
            await walk(full, it.name);
            continue;
          }
          if (!/\.m3u8$/i.test(it.name)) continue;

          const title = it.name.replace(/\.m3u8$/i, '');
          const artist = artistaPai || '';
          if (!title || !artist) continue;

          let linhas = [];
          try {
            linhas = fs.readFileSync(full, 'utf8').split(/\r?\n/);
          } catch (e) {
            continue;
          }

          if (linhas.some((l) => /^#ALBUM:\d+\s*$/.test(l.trim()))) continue;

          const trackIds = [];
          for (const l of linhas) {
            if (l.startsWith('#') || !l.trim()) continue;
            const m = /__(\d+)\.[^.]+$/.exec(l);
            if (m) trackIds.push(m[1]);
            if (trackIds.length >= 3) break;
          }
          if (!trackIds.length) continue;

          let albumId = null;
          let albumTitle = title;
          let albumArtist = artist;
          for (const tid of trackIds) {
            const info = await deezerGet(`https://api.deezer.com/track/${tid}`);
            if (!info || !info.album || !info.album.id) continue;
            const t = norm(info.album.title || '');
            const alvo = norm(title);
            if (t && alvo && (t === alvo || t.includes(alvo) || alvo.includes(t))) {
              albumId = String(info.album.id);
              albumTitle = info.album.title || title;
              albumArtist = (info.artist && info.artist.name) || artist;
              break;
            }
          }

          if (!albumId) {
            log.warn(
              `organizer: álbum "${artist} - ${title}": nenhuma faixa casou com o título; deixando sem #ALBUM`
            );
            continue;
          }

          const out = [];
          let inseriu = false;
          for (const l of linhas) {
            if (!inseriu && l.trim() === '#EXTM3U') {
              out.push(l);
              out.push(`#ALBUM:${albumId}`);
              inseriu = true;
            } else {
              out.push(l);
            }
          }
          if (!inseriu) out.unshift('#EXTM3U', `#ALBUM:${albumId}`);

          try {
            fs.writeFileSync(full, out.join('\r\n') + '\r\n', 'utf8');
          } catch (e) {
            continue;
          }

          const chaveAlvo = chave(albumArtist, albumTitle);
          if (!existentes.has(chaveAlvo)) {
            list.push({ id: albumId, title: albumTitle, artist: albumArtist, trackIds });
            existentes.add(chaveAlvo);
          } else {
            const i = list.findIndex((a) => chave(a.artist, a.title) === chaveAlvo);
            if (i >= 0) {
              if (!list[i].id) list[i].id = albumId;
              if (!list[i].trackIds || !list[i].trackIds.length) list[i].trackIds = trackIds;
            }
          }

          mudou++;
          log.log(`organizer: backfill álbum "${albumTitle}" -> id ${albumId}`);
        }
      };

      await walk(albunsDir, '');
      if (mudou) writeAlbuns(list);
      return mudou;
    });

  // ==========================================================================
  // ÁLBUNS E PLAYLISTS DE UM ARTISTA
  // ==========================================================================

  const albunsDoArtista = async (nome) => {
    const base = getBasePath();
    if (!base || !nome) return [];
    const artista = safeName(nome);
    const pasta = path.join(base, 'Artistas', artista);
    if (!fs.existsSync(pasta)) return [];

    const idx = readIndex();
    const porAlbum = new Map();
    for (const [id, entry] of Object.entries(idx.tracks)) {
      const rel = relDe(entry);
      if (!rel) continue;
      const partes = rel.replace(/\\/g, '/').split('/');
      if (partes.length < 3 || partes[0] !== 'Artistas') continue;
      if (partes[1] !== artista) continue;
      const aid = (entry && entry.albumId) || '';
      if (!aid) continue;
      if (!porAlbum.has(aid)) porAlbum.set(aid, { albumId: aid, faixasNoDisco: 0 });
      porAlbum.get(aid).faixasNoDisco++;
    }

    const list = readAlbuns();
    const covers = readCovers();
    const out = [];

    for (const [albumId, info] of porAlbum) {
      let title = '';
      const reg = list.find((a) => String(a.id) === String(albumId));
      if (reg) title = reg.title;
      if (!title) {
        const api = await deezerGet(`https://api.deezer.com/album/${albumId}`);
        if (api && api.title) title = api.title;
      }
      if (!title) title = `Álbum ${albumId}`;
      let cover = '';
      const chave = `album:${albumId}`;
      if (covers[chave]) {
        const abs = path.join(base, covers[chave]);
        if (fs.existsSync(abs)) cover = pathToFileURL(abs).href;
      }
      out.push({ albumId, title, cover, faixasNoDisco: info.faixasNoDisco });
    }

    out.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
    return out;
  };

  const playlistsDoArtista = async (nome) => {
    const base = getBasePath();
    if (!base || !nome) return [];
    const artista = safeName(nome);
    const idx = readIndex();

    const idsDoArtista = new Set();
    for (const [id, entry] of Object.entries(idx.tracks)) {
      const rel = relDe(entry);
      if (!rel) continue;
      const partes = rel.replace(/\\/g, '/').split('/');
      if (partes.length < 3 || partes[0] !== 'Artistas') continue;
      if (partes[1] !== artista) continue;
      idsDoArtista.add(String(id));
    }

    const dir = path.join(base, 'Playlists');
    let itens = [];
    try {
      itens = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return [];
    }

    const covers = readCovers();
    const out = [];
    for (const it of itens) {
      if (!it.isFile() || !/\.m3u8$/i.test(it.name)) continue;
      const full = path.join(dir, it.name);
      let linhas = [];
      try {
        linhas = fs.readFileSync(full, 'utf8').split(/\r?\n/);
      } catch (e) {
        continue;
      }
      const ids = [];
      for (const l of linhas) {
        if (l.startsWith('#') || !l.trim()) continue;
        const m = /__(\d+)\.[^.]+$/.exec(l);
        if (m) ids.push(m[1]);
      }
      if (!ids.length) continue;
      const doArtista = ids.filter((id) => idsDoArtista.has(id));
      if (!doArtista.length) continue;

      const title = it.name.replace(/\.m3u8$/i, '');
      const plId = idDaPlaylist(title);
      let cover = '';
      if (plId && covers[`playlist:${plId}`]) {
        const abs = path.join(base, covers[`playlist:${plId}`]);
        if (fs.existsSync(abs)) cover = pathToFileURL(abs).href;
      }
      out.push({
        playlistId: plId,
        title,
        faixasDoArtista: doArtista.length,
        faixasNoTotal: ids.length,
        cover
      });
    }

    out.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
    return out;
  };

  // ==========================================================================
  // RECUPERAÇÃO
  // ==========================================================================

  const falhasPath = () => {
    const base = getBasePath();
    return base ? path.join(base, '.deezer', 'falhas.json') : null;
  };

  const readFalhas = () => {
    try {
      const f = JSON.parse(fs.readFileSync(falhasPath(), 'utf8'));
      return { tasks: f.tasks || [], tentativas: f.tentativas || {} };
    } catch (e) {
      return { tasks: [], tentativas: {} };
    }
  };

  const writeFalhas = (f) => {
    const file = falhasPath();
    if (!file) return;
    marcarSujo(file, f);
    writeJSON(file, f);
  };

  const COOLDOWN = 60000;
  let recuperando = false;
  let ultimaRecuperacao = 0;

  const temArquivo = (t) => pyStrings(decodeHtml(t.result)).some((p) => AUDIO.test(p));

  let ultimoMotivo = '';
  const parar = (m) => {
    if (m !== ultimoMotivo) {
      ultimoMotivo = m;
      log.log('organizer/recuperar: ' + m);
    }
  };

  const recuperarFalhas = async () => {
    if (!getBasePath()) return parar('sem basePath (pasta não salva ou não existe)');

    for (let i = 0; i < 20 && busy; i++) await new Promise((r) => setTimeout(r, 100));
    if (busy) return parar('organizador ocupado há 2s (travou?)');

    if (recuperando) return parar('ainda em andamento (travou?)');
    if (Date.now() - ultimaRecuperacao < COOLDOWN) return;
    recuperando = true;

    try {
      log.log('organizer: pedindo a fila...');
      const queue = await apiCall('/queue');
      log.log('organizer: fila respondeu ok=' + queue.ok);

      if (!queue.ok) return parar('fila indisponível: ' + queue.error);
      const tarefas = queue.data || [];

      const ativas = tarefas.filter((t) => t.state !== 'mission accomplished' && t.state !== 'failed');
      if (ativas.length) return parar(`${ativas.length} tarefa(s) em andamento`);

      const feitas = new Set(readIndex().tasks);
      const pendentes = tarefas.filter(
        (t) => t.state === 'mission accomplished' && parseArgs(t.args) && temArquivo(t) && !feitas.has(String(t.id))
      );
      if (pendentes.length) return parar(`${pendentes.length} arquivo(s) esperando o organizer`);

      const f = readFalhas();
      const vistas = new Set(f.tasks);

      const idxAgora = readIndex();
      const novas = tarefas.filter((t) => {
        if (t.state !== 'mission accomplished' || vistas.has(String(t.id))) return false;
        const a = parseArgs(t.args);
        if (!a || a.kind !== 'track') return false;
        if (temArquivo(t)) return false;
        const key = String(a.id);
        if (relDe(idxAgora.tracks[key])) return false;
        if (acharFaixa(key, { tracks: idxAgora.tracks })) return false;
        return true;
      });
      if (!novas.length) return parar(`sem falhas novas (${tarefas.length} tarefas na fila)`);

      const porId = new Map();
      for (const t of novas) {
        const { id } = parseArgs(t.args);
        if (!porId.has(id)) porId.set(id, []);
        porId.get(id).push(String(t.id));
      }

      const marcar = (taskIds) => taskIds.forEach((taskId) => f.tasks.push(taskId));

      const refazer = [];
      for (const [id, taskIds] of porId) {
        if ((f.tentativas[id] || 0) >= 1) {
          marcar(taskIds);
          log.warn(`organizer: faixa ${id} falhou de novo depois de reiniciar; desistindo`);
          continue;
        }

        const info = await deezerGet(`https://api.deezer.com/track/${id}`);
        if (!info) continue;

        if (info.readable === false) {
          marcar(taskIds);
          log.warn(`organizer: faixa ${id} indisponível no Deezer; não vou tentar de novo`);
          continue;
        }
        refazer.push({ taskIds, id });
      }

      parar(`${novas.length} falha(s) nova(s), ${refazer.length} a refazer`);
      if (!refazer.length) {
        writeFalhas(f);
        return;
      }

      ultimaRecuperacao = Date.now();
      log.warn(`organizer: ${refazer.length} faixa(s) sem arquivo; reiniciando o servidor`);

      try {
        const r = await restartServer();
        if (!r || !r.ok) throw new Error((r && r.error) || 'falha ao reiniciar');
      } catch (e) {
        log.warn(`organizer: não consegui reiniciar o servidor: ${e.message}`);
        return;
      }

      let voltou = false;
      for (let i = 0; i < 30 && !voltou; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        voltou = (await apiCall('/queue')).ok;
      }
      if (!voltou) {
        log.warn('organizer: o servidor não respondeu depois do reinício');
        return;
      }

      refazer.forEach((r) => {
        f.tentativas[r.id] = 1;
        r.taskIds.forEach((taskId) => f.tasks.push(taskId));
      });
      writeFalhas(f);

      for (const r of refazer) {
        await apiCall('/download', {
          type: 'track',
          music_id: r.id,
          add_to_playlist: false,
          create_zip: false
        });
      }
      log.log(`organizer: ${refazer.length} faixa(s) reenviada(s) depois do reinício`);
    } finally {
      recuperando = false;
    }
  };

  // ==========================================================================
  // M3U8 DE ÁLBUM
  // ==========================================================================

  const albunsPath = () => {
    const base = getBasePath();
    return base ? path.join(base, '.deezer', 'albuns.json') : null;
  };

  const readAlbuns = () => {
    try {
      const a = JSON.parse(fs.readFileSync(albunsPath(), 'utf8'));
      return Array.isArray(a) ? a : [];
    } catch (e) {
      return [];
    }
  };

  const writeAlbuns = (list) => {
    const file = albunsPath();
    if (!file) return;
    marcarSujo(file, list);
    writeJSON(file, list);
  };

  const registrarAlbum = async ({ id, title, artist, trackIds }) => {
    if (!getBasePath()) return { ok: false, error: 'sem pasta base' };
    if (!title || !artist || !Array.isArray(trackIds) || !trackIds.length)
      return { ok: false, error: 'álbum incompleto' };
    return withAlbuns(async () => {
      let t = title;
      let a = artist;
      if (id) {
        const info = await deezerGet(`https://api.deezer.com/album/${id}`);
        if (info) {
          if (info.title) t = info.title;
          if (info.artist && info.artist.name) a = info.artist.name;
        }
      }
      const list = readAlbuns().filter((x) => String(x.id) !== String(id));
      list.push({ id: String(id), title: t, artist: a, trackIds: trackIds.map(String) });
      writeAlbuns(list);
      return { ok: true };
    });
  };

  const artistaDoAlbum = (id) => {
    const a = readAlbuns().find((x) => x.trackIds.includes(String(id)));
    return a ? a.artist : null;
  };

  const nomeDoArquivo = (rel) => path.basename(rel).replace(/__\d+\.[^.]+$/, '');
  const idDoArquivo = (rel) => {
    const m = /__(\d+)\.[^.]+$/.exec(path.basename(rel));
    return m ? m[1] : null;
  };

  const linhaExtinf = (meta, rel) => {
    const dur = meta && Number(meta.duration) > 0 ? Math.round(Number(meta.duration)) : -1;
    const artista = meta && meta.artist && meta.artist.name ? meta.artist.name : '';
    const nome = meta && meta.title ? (artista ? `${artista} - ${meta.title}` : meta.title) : nomeDoArquivo(rel);
    return `#EXTINF:${dur},${nome}`;
  };

  const acharFaixaCache = new Map();

  const acharFaixa = (id, idx) => {
    const key = String(id);
    const rel = relDe(idx.tracks[key]);
    if (rel) return rel;

    const base = getBasePath();
    if (!base) return null;

    if (acharFaixaCache.has(key)) {
      const cached = acharFaixaCache.get(key);
      if (cached && fs.existsSync(path.join(base, cached))) return cached;
      acharFaixaCache.delete(key);
    }

    const artistsDir = path.join(base, 'Artistas');
    if (!fs.existsSync(artistsDir)) return null;

    let achado = null;
    const walk = (dir) => {
      if (achado) return;
      let itens = [];
      try {
        itens = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }
      for (const it of itens) {
        if (achado) return;
        const full = path.join(dir, it.name);
        if (it.isDirectory()) {
          walk(full);
          continue;
        }
        if (!AUDIO.test(it.name)) continue;
        const m = /__(\d+)\.[^.]+$/.exec(it.name);
        if (!m) continue;
        const relFull = path.relative(base, full);
        acharFaixaCache.set(m[1], relFull);
        if (m[1] === key) achado = relFull;
      }
    };
    walk(artistsDir);
    return achado;
  };

  const m3u8DoAlbum = (a) => {
    const base = getBasePath();
    if (!base) return null;
    return path.join('Albuns', safeName(a.artist), `${safeName(a.title)}.m3u8`);
  };

  const fecharAlbuns = () =>
    withAlbuns(async () => {
      const base = getBasePath();
      if (!base || recuperando || busy) return;
      const list = readAlbuns();
      if (!list.length) return;

      const { tracks } = readIndex();
      const restantes = [];

      const estadoM3u8 = (abs) => {
        const ids = new Set();
        let total = 0;
        let comDur = 0;
        try {
          for (const l of fs.readFileSync(abs, 'utf8').split(/\r?\n/)) {
            const m = /__(\d+)\.[^.]+$/.exec(l);
            if (m) ids.add(m[1]);
            if (l.startsWith('#EXTINF:')) {
              total++;
              if (!/^#EXTINF:-1\b/.test(l)) comDur++;
            }
          }
        } catch (e) {
          return { ids: new Set(), degradado: true };
        }
        return { ids, degradado: total > 0 && comDur === 0 };
      };

      for (const a of list) {
        if (a.id) garantirCapaAlbum(a.id).catch(() => {});

        const relM3u8 = m3u8DoAlbum(a);
        const absM3u8 = relM3u8 ? path.join(base, relM3u8) : null;
        const existente = absM3u8 && fs.existsSync(absM3u8) ? absM3u8 : null;

        const trackIds = Array.isArray(a.trackIds) ? a.trackIds : [];
        if (!trackIds.length && existente) {
          continue;
        }

        const presentes = [];
        for (const id of trackIds) {
          const rel = relDe(tracks[id]) || acharFaixa(id, { tracks });
          if (rel) presentes.push({ id, rel });
        }

        if (!presentes.length) {
          if (existente) {
            try {
              fs.unlinkSync(existente);
              log.log(`organizer: .m3u8 órfão removido ("${a.title}")`);
            } catch (e) {
              restantes.push(a);
            }
          }
          continue;
        }

        if (existente) {
          const { ids, degradado } = estadoM3u8(existente);
          if (!degradado && presentes.every(({ id }) => ids.has(id))) {
            if (presentes.length < trackIds.length) restantes.push(a);
            continue;
          }
        }

        let meta = new Map();
        if (a.id) {
          const infos = await albumTracks(a.id);
          meta = new Map((infos || []).map((t) => [String(t.id), t]));
        }

        if (!meta.size && existente) {
          restantes.push(a);
          continue;
        }

        const folder = path.join(base, 'Albuns', safeName(a.artist));
        fs.mkdirSync(folder, { recursive: true });
        const lines = ['#EXTM3U'];
        if (a.id) lines.push(`#ALBUM:${a.id}`);
        presentes.forEach(({ id, rel }) => {
          const caminho = path.relative(folder, path.join(base, rel)).replace(/\\/g, '/');
          lines.push(linhaExtinf(meta.get(id), caminho), caminho);
        });
        fs.writeFileSync(path.join(folder, `${safeName(a.title)}.m3u8`), lines.join('\r\n') + '\r\n', 'utf8');

        if (presentes.length === trackIds.length) {
          log.log(`organizer: m3u8 do álbum "${a.title}" criado (${presentes.length}/${trackIds.length})`);
        } else {
          log.log(`organizer: m3u8 do álbum "${a.title}" criado PARCIAL (${presentes.length}/${trackIds.length})`);
          restantes.push(a);
        }
      }

      if (restantes.length !== list.length) writeAlbuns(restantes);
    });

  // ==========================================================================
  // REPARO DE M3U8 ANTIGOS
  // ==========================================================================

  const m3u8SemExtinf = () => {
    const base = getBasePath();
    if (!base) return [];
    const alvos = [];
    const varrer = (dir) => {
      let itens = [];
      try {
        itens = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }
      for (const it of itens) {
        const full = path.join(dir, it.name);
        if (it.isDirectory()) varrer(full);
        else if (/\.m3u8$/i.test(it.name)) {
          try {
            const linhas = fs.readFileSync(full, 'utf8').split(/\r?\n/);
            if (!linhas.some((l) => l.startsWith('#EXTINF'))) alvos.push(full);
          } catch (e) {
            /* ignora */
          }
        }
      }
    };
    varrer(path.join(base, 'Albuns'));
    varrer(path.join(base, 'Playlists'));
    return alvos;
  };

  const repararM3u8 = async () => {
    const arquivos = m3u8SemExtinf();
    if (!arquivos.length) return 0;

    const cache = new Map();
    let mudou = 0;

    for (const file of arquivos) {
      let linhas = [];
      try {
        linhas = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
      } catch (e) {
        continue;
      }
      const rels = linhas.filter((l) => !l.startsWith('#'));
      if (!rels.length) continue;

      for (const id of new Set(rels.map(idDoArquivo).filter(Boolean))) {
        if (cache.has(id)) continue;
        const info = await deezerGet(`https://api.deezer.com/track/${id}`);
        if (info && info.id) cache.set(id, info);
        await new Promise((r) => setTimeout(r, 120));
      }

      const out = ['#EXTM3U'];
      rels.forEach((rel) => out.push(linhaExtinf(cache.get(idDoArquivo(rel)), rel), rel));
      try {
        fs.writeFileSync(file, out.join('\r\n') + '\r\n', 'utf8');
        mudou++;
      } catch (e) {
        /* sem permissão? */
      }
    }

    if (mudou) log.log(`organizer: ${mudou} m3u8 antigo(s) atualizado(s) com #EXTINF`);
    return mudou;
  };

  // ==========================================================================
  // LEITURA DA BIBLIOTECA
  // ==========================================================================

  const lerM3u8 = (file) => {
    let linhas = [];
    try {
      linhas = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
    } catch (e) {
      return [];
    }

    const out = [];
    let meta = null;
    for (const l of linhas) {
      if (l.startsWith('#EXTINF:')) {
        const s = l.slice('#EXTINF:'.length);
        const virgula = s.indexOf(',');
        const dur = virgula >= 0 ? Number(s.slice(0, virgula)) : -1;
        meta = { dur: Number.isFinite(dur) ? dur : -1, nome: virgula >= 0 ? s.slice(virgula + 1).trim() : '' };
        continue;
      }
      if (l.startsWith('#')) continue;
      out.push({
        n: out.length + 1,
        nome: meta && meta.nome ? meta.nome : nomeDoArquivo(l),
        dur: meta ? meta.dur : -1,
        rel: l
      });
      meta = null;
    }
    return out;
  };

  const albumIdDoM3u8 = (file) => {
    try {
      const linhas = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      for (const l of linhas) {
        const m = /^#ALBUM:(\d+)\s*$/.exec(l.trim());
        if (m) return m[1];
        if (l.trim() !== '' && !l.startsWith('#')) break;
      }
    } catch (e) {
      /* ignora */
    }
    return '';
  };

  const listarM3u8 = (dir, artista) => {
    const out = [];
    let itens = [];
    try {
      itens = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return out;
    }
    for (const it of itens) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        out.push(...listarM3u8(full, it.name || artista));
        continue;
      }
      if (!/\.m3u8$/i.test(it.name)) continue;
      out.push({
        title: it.name.replace(/\.m3u8$/i, ''),
        artist: artista || '',
        faixas: lerM3u8(full).length,
        rel: path.relative(getBasePath(), full),
        albumId: albumIdDoM3u8(full)
      });
    }
    return out;
  };

  // ==========================================================================
  // IDS DE ÁLBUM / PLAYLIST / ARTISTA
  // ==========================================================================

  const idDoAlbum = (title, artist) => {
    const a = readAlbuns().find(
      (x) =>
        String(x.title || '').trim().toLowerCase() === String(title || '').trim().toLowerCase() &&
        String(x.artist || '').trim().toLowerCase() === String(artist || '').trim().toLowerCase()
    );
    return a && a.id ? String(a.id) : '';
  };

  const idDaPlaylist = (title) => {
    const p = readPlaylists().find(
      (x) => String(x.title || '').trim().toLowerCase() === String(title || '').trim().toLowerCase()
    );
    return p ? String(p.id) : '';
  };

  const idDoArtista = (nome) => {
    const covers = readCovers();
    const nomeNorm = safeName(nome).toLowerCase();
    for (const [k, rel] of Object.entries(covers)) {
      if (!k.startsWith('artist:')) continue;
      const m = /^artist:(\d+)$/.exec(k);
      if (!m) continue;
      const partes = String(rel).replace(/\\/g, '/').split('/');
      if (partes.length < 2) continue;
      if (partes[0] !== 'Artistas') continue;
      if (partes[1].toLowerCase() !== nomeNorm) continue;
      return m[1];
    }
    return '';
  };

  // ==========================================================================
  // BIBLIOTECA
  // ==========================================================================

  const m3u8TemFaixaNoDisco = (abs) => {
    try {
      const linhas = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
      for (const l of linhas) {
        if (l.startsWith('#') || !l.trim()) continue;
        const absFaixa = path.resolve(path.dirname(abs), l);
        if (fs.existsSync(absFaixa)) return true;
      }
    } catch (e) {
      /* ignora */
    }
    return false;
  };

  const biblioteca = () => {
    const base = getBasePath();
    if (!base) return { artists: [], albums: [], playlists: [] };

    const artists = [];
    try {
      for (const it of fs.readdirSync(path.join(base, 'Artistas'), { withFileTypes: true })) {
        if (!it.isDirectory()) continue;
        let faixas = 0;
        try {
          faixas = fs.readdirSync(path.join(base, 'Artistas', it.name)).filter((f) => AUDIO.test(f)).length;
        } catch (e) {}
        if (faixas) artists.push({ name: it.name, faixas, artistId: idDoArtista(it.name) });
      }
    } catch (e) {}
    artists.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

    const albunsDir = path.join(base, 'Albuns');
    const albums = listarM3u8(albunsDir, '').filter((a) => m3u8TemFaixaNoDisco(path.join(base, a.rel)));
    albums.sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));

    const playlists = listarM3u8(path.join(base, 'Playlists'), '')
      .filter((p) => String(p.title).toLowerCase() !== FAVS_TITLE.toLowerCase())
      .map((p) => ({
        title: p.title,
        faixas: p.faixas,
        rel: p.rel,
        playlistId: idDaPlaylist(p.title)
      }))
      .sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));

    return { artists, albums, playlists };
  };

  // ==========================================================================
  // LEITURA POR FAIXA / ARTISTA / CAPA
  // ==========================================================================

  const idsOffline = () => {
    const base = getBasePath();
    if (!base) return [];
    const { tracks } = readIndex();
    return Object.keys(tracks).filter((id) => fs.existsSync(path.join(base, relDe(tracks[id]))));
  };

  const caminhoDe = (id) => {
    const base = getBasePath();
    if (!base || !id) return '';
    const { tracks } = readIndex();
    const rel = relDe(tracks[String(id)]);
    if (!rel) return '';
    const abs = path.join(base, rel);
    return fs.existsSync(abs) ? pathToFileURL(abs).href : '';
  };

  const faixasArtista = (nome) => {
    const base = getBasePath();
    if (!base || !nome) return [];
    const folder = path.join(base, 'Artistas', safeName(nome));
    let itens = [];
    try {
      itens = fs.readdirSync(folder, { withFileTypes: true });
    } catch (e) {
      return [];
    }

    const idx = readIndex();

    const meta = new Map();
    const lerM3u8s = (dir, pasta) => {
      let lista = [];
      try {
        lista = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }
      for (const it of lista) {
        const full = path.join(dir, it.name);
        if (it.isDirectory()) {
          lerM3u8s(full, it.name);
          continue;
        }
        if (!/\.m3u8$/i.test(it.name)) continue;
        const albumTitle = it.name.replace(/\.m3u8$/i, '');
        let linhas = [];
        try {
          linhas = fs.readFileSync(full, 'utf8').split(/\r?\n/);
        } catch (e) {
          continue;
        }
        for (let i = 0; i < linhas.length; i++) {
          const l = linhas[i];
          if (l.startsWith('#')) continue;
          const m = /__(\d+)\.[^.]+$/.exec(l);
          if (!m) continue;
          const id = m[1];
          if (meta.has(id)) continue;
          let dur = -1;
          for (let j = i - 1; j >= 0; j--) {
            const mExt = /^#EXTINF:(-?\d+)/.exec(linhas[j]);
            if (mExt) {
              dur = Number(mExt[1]);
              break;
            }
            if (!linhas[j].startsWith('#')) break;
          }
          meta.set(id, { dur, albumTitle, pasta });
        }
      }
    };
    lerM3u8s(path.join(base, 'Albuns'), 'Albuns');
    lerM3u8s(path.join(base, 'Playlists'), 'Playlists');

    const out = [];
    for (const it of itens) {
      if (!it.isFile() || !AUDIO.test(it.name)) continue;
      const full = path.join(folder, it.name);
      const m = /__(\d+)\.[^.]+$/.exec(it.name);
      const id = m ? m[1] : '';
      const nomeBase = it.name.replace(/__\d+\.[^.]+$/, '');
      const entry = id ? idx.tracks[id] : null;
      const info = id ? meta.get(id) : null;
      out.push({
        n: out.length + 1,
        nome: nomeBase,
        dur: info && info.dur > 0 ? info.dur : -1,
        rel: path.relative(base, full),
        url: pathToFileURL(full).href,
        id,
        albumId: entry && entry.albumId ? entry.albumId : '',
        artistId: entry && entry.artistId ? entry.artistId : '',
        albumTitle: info && info.albumTitle ? info.albumTitle : ''
      });
    }
    out.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    out.forEach((f, i) => (f.n = i + 1));
    return out;
  };

  const faixas = (rel) => {
    const base = getBasePath();
    if (!base || !rel) return [];
    const raiz = path.resolve(base).toLowerCase() + path.sep;
    const full = path.resolve(base, rel);
    if (!full.toLowerCase().startsWith(raiz)) return [];
    if (!/\.m3u8$/i.test(full)) return [];

    let tracks = {};
    try {
      tracks = readIndex().tracks || {};
    } catch (e) {
      tracks = {};
    }

    const albumIdDoArquivo = albumIdDoM3u8(full);

    return lerM3u8(full).map((f) => {
      const abs = path.resolve(path.dirname(full), f.rel);
      const dentro = abs.toLowerCase().startsWith(raiz) && fs.existsSync(abs);
      const m = path.basename(f.rel).match(/__(\d+)\.[^.]+$/);
      const id = m ? m[1] : '';
      const entry = id ? tracks[id] : null;
      return {
        ...f,
        url: dentro ? pathToFileURL(abs).href : '',
        id,
        albumId:
          (entry && entry.albumId) ||
          (albumIdDoArquivo && id ? albumIdDoArquivo : '') ||
          '',
        artistId: entry && entry.artistId ? entry.artistId : ''
      };
    });
  };

  // ==========================================================================
  // PLAYLISTS DO USUÁRIO
  // ==========================================================================

  const playlistsPath = () => {
    const base = getBasePath();
    return base ? path.join(base, '.deezer', 'playlists.json') : null;
  };

  const readPlaylists = () => {
    try {
      const a = JSON.parse(fs.readFileSync(playlistsPath(), 'utf8'));
      return Array.isArray(a) ? a : [];
    } catch (e) {
      return [];
    }
  };

  const writePlaylists = (list) => {
    const file = playlistsPath();
    if (!file) return;
    marcarSujo(file, list);
    writeJSON(file, list);
  };

  const registrarPlaylist = ({ id, title, trackIds }) => {
    if (!getBasePath()) return { ok: false, error: 'sem pasta base' };
    if (!id || !title || !Array.isArray(trackIds) || !trackIds.length)
      return { ok: false, error: 'playlist incompleta' };
    return withPlaylists(() => {
      const list = readPlaylists().filter((p) => String(p.id) !== String(id));
      list.push({ id: String(id), title, trackIds: trackIds.map(String) });
      writePlaylists(list);
      return { ok: true };
    });
  };

  const playlistMeta = async (id) => {
    const meta = new Map();
    const tracks = await playlistTracks(id);
    if (!tracks) return meta;
    tracks.forEach((t) => meta.set(String(t.id), t));
    return meta;
  };

  const fecharPlaylists = () =>
    withPlaylists(async () => {
      const base = getBasePath();
      if (!base || recuperando || busy) return;
      const list = readPlaylists();
      if (!list.length) return;

      const queue = await apiCall('/queue');
      if (!queue.ok) return;
      const tarefas = queue.data || [];

      if (tarefas.some((t) => t.state !== 'mission accomplished' && t.state !== 'failed')) return;

      const idx = readIndex();
      const feitas = new Set(idx.tasks);

      if (
        tarefas.some(
          (t) => t.state === 'mission accomplished' && parseArgs(t.args) && temArquivo(t) && !feitas.has(String(t.id))
        )
      )
        return;

      const vistas = new Set(readFalhas().tasks);
      if (
        tarefas.some((t) => {
          const a = parseArgs(t.args);
          return t.state === 'mission accomplished' && a && a.kind === 'track' && !temArquivo(t) && !vistas.has(String(t.id));
        })
      )
        return;

      const restantes = [];
      for (const p of list) {
        garantirCapaPlaylist(p.id).catch(() => {});

        const ids = new Set(p.trackIds);
        const enviada = tarefas.some((t) => {
          const a = parseArgs(t.args);
          return a && a.kind === 'track' && ids.has(String(a.id));
        });
        if (!enviada) {
          restantes.push(p);
          continue;
        }

        const ok = [];
        for (const id of p.trackIds) {
          const rel = acharFaixa(id, idx);
          if (rel) ok.push({ id, rel });
        }
        if (!ok.length) {
          log.warn(`organizer: playlist "${p.title}": nenhuma faixa baixou; m3u8 não criado`);
          continue;
        }

        const meta = await playlistMeta(p.id);
        const folder = path.join(base, 'Playlists');
        fs.mkdirSync(folder, { recursive: true });
        const lines = ['#EXTM3U'];
        ok.forEach(({ id, rel }) => {
          const caminho = path.relative(folder, path.join(base, rel)).replace(/\\/g, '/');
          lines.push(linhaExtinf(meta.get(id), caminho), caminho);
        });
        fs.writeFileSync(path.join(folder, `${safeName(p.title)}.m3u8`), lines.join('\r\n') + '\r\n', 'utf8');
        log.log(`organizer: m3u8 da playlist "${p.title}" criado (${ok.length}/${p.trackIds.length} faixas)`);
      }

      if (restantes.length !== list.length) writePlaylists(restantes);
    });

  const libraryCover = (tipo, id) => {
    if (!tipo || !id) return '';
    const base = getBasePath();
    if (!base) return '';
    try {
      const c = readCovers();
      const rel = c[`${tipo}:${id}`];
      if (!rel) return '';
      const abs = path.join(base, rel);
      return fs.existsSync(abs) ? pathToFileURL(abs).href : '';
    } catch (e) {
      return '';
    }
  };

  // ==========================================================================
  // PLAYLISTS DO USUÁRIO (CRUD)
  // ==========================================================================

  const playlistsList = () => {
    const base = getBasePath();
    if (!base) return [];
    const dir = path.join(base, 'Playlists');
    let itens = [];
    try {
      itens = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return [];
    }
    const out = [];
    for (const it of itens) {
      if (!it.isFile() || !/\.m3u8$/i.test(it.name)) continue;
      const title = it.name.replace(/\.m3u8$/i, '');
      if (title.toLowerCase() === FAVS_TITLE.toLowerCase()) continue;
      const full = path.join(dir, it.name);
      let faixas = 0;
      try {
        faixas = lerM3u8(full).length;
      } catch (e) {
        faixas = 0;
      }
      out.push({ title, faixas, rel: path.relative(base, full) });
    }
    out.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
    return out;
  };

  const playlistsComMeta = () => {
    const list = playlistsList();
    const meta = readMeta();
    return list.map((p) => {
      const m = meta[p.title] || {};
      return {
        title: p.title,
        faixas: p.faixas,
        rel: p.rel,
        criada: m.criada || null,
        ultima: m.ultima || null
      };
    });
  };

  const criarPlaylistVazia = (nome) => {
    const base = getBasePath();
    if (!base) return { ok: false, error: 'sem pasta base' };
    const title = safeName(String(nome || '').trim());
    if (!title) return { ok: false, error: 'nome vazio' };
    const folder = path.join(base, 'Playlists');
    fs.mkdirSync(folder, { recursive: true });
    const abs = path.join(folder, `${title}.m3u8`);
    if (fs.existsSync(abs)) return { ok: true, title, jaExistia: true };
    try {
      fs.writeFileSync(abs, '#EXTM3U\r\n', 'utf8');
      criarMetaSeFaltar(title);
      return { ok: true, title, criada: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  const playlistAddFaixa = async (title, id) => {
    const base = getBasePath();
    if (!base || !title || !id) return { ok: false, error: 'parâmetros inválidos' };

    const folder = path.join(base, 'Playlists');
    const t = safeName(String(title).trim());
    const abs = path.join(folder, `${t}.m3u8`);
    if (!fs.existsSync(abs)) return { ok: false, error: 'playlist não existe' };

    let rel = '';
    try {
      const { tracks } = readIndex();
      rel = relDe(tracks[String(id)]);
    } catch (e) {
      rel = '';
    }
    if (!rel) rel = acharFaixa(String(id), { tracks: readIndex().tracks }) || '';
    if (!rel) return { ok: false, error: 'faixa ainda não está no disco' };

    const absFaixa = path.join(base, rel);
    if (!fs.existsSync(absFaixa)) return { ok: false, error: 'arquivo da faixa não existe' };

    const linhas = [];
    try {
      linhas.push(...fs.readFileSync(abs, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== ''));
    } catch (e) {
      linhas.push('#EXTM3U');
    }
    if (!linhas.length || linhas[0] !== '#EXTM3U') linhas.unshift('#EXTM3U');

    const jaTem = linhas.some((l) => {
      if (l.startsWith('#') || !l.trim()) return false;
      const m = /__(\d+)\.[^.]+$/.exec(l);
      return m && m[1] === String(id);
    });
    if (jaTem) return { ok: true, jaExistia: true };

    let nome = nomeDoArquivo(rel);
    let dur = -1;
    const info = await deezerGet(`https://api.deezer.com/track/${id}`).catch(() => null);
    if (info && info.title) {
      const artista = (info.artist && info.artist.name) || '';
      nome = artista ? `${artista} - ${info.title}` : info.title;
      if (info.duration) dur = Math.round(info.duration);
    }

    const caminho = path.relative(folder, absFaixa).replace(/\\/g, '/');
    linhas.push(`#EXTINF:${dur},${nome}`, caminho);

    try {
      fs.writeFileSync(abs, linhas.join('\r\n') + '\r\n', 'utf8');
      criarMetaSeFaltar(t);
      return { ok: true, adicionado: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  const playlistRemoveFaixa = (title, id) => {
    const base = getBasePath();
    if (!base || !title || !id) return { ok: false, error: 'parâmetros inválidos' };

    const folder = path.join(base, 'Playlists');
    const t = safeName(String(title).trim());
    const abs = path.join(folder, `${t}.m3u8`);
    if (!fs.existsSync(abs)) return { ok: true, jaRemovido: true };

    let linhas = [];
    try {
      linhas = fs.readFileSync(abs, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
    } catch (e) {
      return { ok: false, error: e.message };
    }

    const out = [];
    let meta = null;
    let removeu = false;
    for (const l of linhas) {
      if (l.startsWith('#EXTINF')) {
        meta = l;
        continue;
      }
      if (l.startsWith('#EXTM3U')) {
        out.push(l);
        continue;
      }
      if (l.startsWith('#')) {
        out.push(l);
        continue;
      }
      const m = /__(\d+)\.[^.]+$/.exec(l);
      const lid = m ? m[1] : '';
      if (lid === String(id)) {
        removeu = true;
        meta = null;
        continue;
      }
      if (meta) {
        out.push(meta);
        meta = null;
      }
      out.push(l);
    }

    if (!removeu) return { ok: true, jaRemovido: true };

    const temFaixa = out.some((l) => !l.startsWith('#') && l.trim());
    try {
      if (!temFaixa) {
        fs.unlinkSync(abs);
        apagarMeta(t);
      } else {
        fs.writeFileSync(abs, out.join('\r\n') + '\r\n', 'utf8');
      }
      return { ok: true, removido: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  const playlistDelete = (nome) => {
    const base = getBasePath();
    if (!base || !nome) return { ok: false, error: 'parâmetros inválidos' };
    const folder = path.join(base, 'Playlists');
    const t = safeName(String(nome).trim());
    const abs = path.join(folder, `${t}.m3u8`);
    if (!fs.existsSync(abs)) return { ok: true, jaRemovida: true };
    try {
      fs.unlinkSync(abs);
      apagarMeta(t);
      return { ok: true, apagada: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  const playlistTocar = (nome) => {
    if (!getBasePath()) return { ok: false, error: 'sem pasta base' };
    tocarMeta(nome);
    return { ok: true };
  };

  // ==========================================================================
  // FAVORITOS ("Mais queridas")
  // ==========================================================================

  const favsPath = () => {
    const base = getBasePath();
    return base ? path.join(base, FAVS_REL) : null;
  };

  const favsList = () => {
    const abs = favsPath();
    if (!abs || !fs.existsSync(abs)) return [];
    const ids = [];
    let linhas = [];
    try {
      linhas = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    } catch (e) {
      return [];
    }
    for (const l of linhas) {
      if (l.startsWith('#') || !l.trim()) continue;
      const m = /__(\d+)\.[^.]+$/.exec(l);
      if (m) ids.push(m[1]);
    }
    return ids;
  };

  const favsAdd = async (id) => {
    const base = getBasePath();
    if (!base || !id) return { ok: false, error: 'sem basePath ou id' };
    const abs = favsPath();
    if (!abs) return { ok: false, error: 'sem caminho de favoritos' };

    let rel = '';
    try {
      const { tracks } = readIndex();
      rel = relDe(tracks[String(id)]);
    } catch (e) {
      rel = '';
    }
    if (!rel) rel = acharFaixa(String(id), { tracks: readIndex().tracks }) || '';
    if (!rel) return { ok: false, error: 'faixa ainda não está no disco' };

    const absFaixa = path.join(base, rel);
    if (!fs.existsSync(absFaixa)) return { ok: false, error: 'arquivo da faixa não existe' };

    const ids = favsList();
    if (ids.includes(String(id))) return { ok: true, jaExistia: true };

    let nome = nomeDoArquivo(rel);
    let dur = -1;
    const info = await deezerGet(`https://api.deezer.com/track/${id}`).catch(() => null);
    if (info && info.title) {
      const artista = (info.artist && info.artist.name) || '';
      nome = artista ? `${artista} - ${info.title}` : info.title;
      if (info.duration) dur = Math.round(info.duration);
    }

    const folder = path.join(base, 'Playlists');
    fs.mkdirSync(folder, { recursive: true });

    const linhas = [];
    if (fs.existsSync(abs)) {
      try {
        linhas.push(...fs.readFileSync(abs, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== ''));
      } catch (e) {
        /* reescreve do zero */
      }
    }
    if (!linhas.length || linhas[0] !== '#EXTM3U') linhas.unshift('#EXTM3U');

    const caminho = path.relative(folder, absFaixa).replace(/\\/g, '/');
    linhas.push(`#EXTINF:${dur},${nome}`, caminho);

    try {
      fs.writeFileSync(abs, linhas.join('\r\n') + '\r\n', 'utf8');
      return { ok: true, adicionado: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  const favsRemove = (id) => {
    const base = getBasePath();
    if (!base || !id) return { ok: false, error: 'sem basePath ou id' };
    const abs = favsPath();
    if (!abs || !fs.existsSync(abs)) return { ok: true, jaRemovido: true };

    let linhas = [];
    try {
      linhas = fs.readFileSync(abs, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
    } catch (e) {
      return { ok: false, error: e.message };
    }

    const out = [];
    let meta = null;
    let removeu = false;
    for (const l of linhas) {
      if (l.startsWith('#EXTINF')) {
        meta = l;
        continue;
      }
      if (l.startsWith('#EXTM3U')) {
        out.push(l);
        continue;
      }
      if (l.startsWith('#')) {
        out.push(l);
        continue;
      }
      const m = /__(\d+)\.[^.]+$/.exec(l);
      const lid = m ? m[1] : '';
      if (lid === String(id)) {
        removeu = true;
        meta = null;
        continue;
      }
      if (meta) {
        out.push(meta);
        meta = null;
      }
      out.push(l);
    }

    if (!removeu) return { ok: true, jaRemovido: true };

    const temFaixa = out.some((l) => !l.startsWith('#') && l.trim());
    try {
      if (!temFaixa) {
        fs.unlinkSync(abs);
      } else {
        fs.writeFileSync(abs, out.join('\r\n') + '\r\n', 'utf8');
      }
      return { ok: true, removido: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  // ==========================================================================
  // INICIALIZAÇÃO
  // ==========================================================================

  let iniciado = false;

  const start = () => {
    if (iniciado) return;
    iniciado = true;

    acharFaixaCache.clear();

    (async () => {
      try {
        await reconstruirIndice();
        await reconstruirAlbuns();
      } catch (e) {
        log.warn('organizer: erro na reconstrução: ' + e.message);
      }

      try {
        await backfillAlbumIds();
      } catch (e) {
        log.warn('organizer: erro no backfill de ids: ' + e.message);
      }
      try {
        await backfillAlbunsDoIndice();
      } catch (e) {
        log.warn('organizer: erro no backfill de álbuns do índice: ' + e.message);
      }
      try {
        await backfillAlbunsViaAPI();
      } catch (e) {
        log.warn('organizer: erro no backfill de álbuns: ' + e.message);
      }

      organizeOnce().catch((e) => log.warn('organizer: erro no organizeOnce inicial: ' + e.message));
      repararM3u8().catch((e) => log.warn('organizer/m3u8: erro no reparo: ' + e.message));

      setInterval(
        () => organizeOnce().catch((e) => log.warn('organizer: erro: ' + (e && e.stack ? e.stack : e))),
        ORG_INTERVAL
      ).unref();

      setInterval(
        () => recuperarFalhas().catch((e) => log.warn('organizer/recuperar: erro: ' + (e && e.stack ? e.stack : e))),
        ORG_INTERVAL
      ).unref();

      setInterval(
        () => fecharAlbuns().catch((e) => log.warn('organizer/m3u8: erro: ' + e.message)),
        ORG_INTERVAL
      ).unref();

      setInterval(
        () => fecharPlaylists().catch((e) => log.warn('organizer/playlist: erro: ' + e.message)),
        ORG_INTERVAL
      ).unref();
    })();
  };

  return {
    start,
    runOnce: organizeOnce,
    flush,
    registrarAlbum,
    fecharAlbuns,
    registrarPlaylist,
    fecharPlaylists,
    repararM3u8,
    reconstruirIndice,
    reconstruirAlbuns,
    backfillAlbumIds,
    backfillAlbunsDoIndice,
    backfillAlbunsViaAPI,
    biblioteca,
    albunsDoArtista,
    playlistsDoArtista,
    faixas,
    faixasArtista,
    idsOffline,
    caminhoDe,
    playlistsList,
    playlistsComMeta,
    criarPlaylistVazia,
    playlistAddFaixa,
    playlistRemoveFaixa,
    playlistDelete,
    playlistTocar,
    favsList,
    favsAdd,
    favsRemove,
    libraryCover
  };
};