# 🎧 Deezer Offline — Documentação técnica

Referência para quem vai mexer no código: **estrutura, APIs internas, decisões fechadas e armadilhas conhecidas**.
Para uma visão geral do produto (sem detalhes de desenvolvimento), veja o [README.md](README.md).

> O código é a fonte da verdade: `main.js`, `preload.js`, `server.js`, `organizer.js`, `renderer/index.js` e `renderer/index.html`.
> App desktop em **Electron** que serve de painel para o [`kmille2/deezer-downloader`](https://github.com/kmille2/deezer-downloader) rodando em **Python nativo (sem Docker)**.
> Última atualização: **30/10/2026**.

---

## 1. Como rodar

```bash
cd <caminho-do-projeto>
npm start
```

Requisitos: **Node 22+ (>=22.12.0)**. Não precisa de Docker, nem de Python instalado, nem de internet na primeira execução (a não ser no login do Deezer).

O painel conversa com um servidor local que o próprio app sobe (`server.js`):

- usa o **Python do sistema** *somente* se o pacote `deezer_downloader` já estiver instalado nele;
- caso contrário usa o **Python 3.13.3 embutido** em `resources\server\python` (com todos os pacotes em `Lib\site-packages`);
- sobe em `http://127.0.0.1:5000`; se a 5000 estiver ocupada, escolhe a próxima livre (5001…5020) e passa a conversar nela;
- inicia junto com o app e é encerrado junto (`before-quit` → `taskkill /T /F`);
- o modo **waitress** é obrigatório: `python -c "from deezer_downloader.cli.runner import main; main()" -c <ini>`. Rodar `python -m deezer_downloader.cli.runner` liga o Flask **debug com reloader** (dois processos, morre fácil).

Arquivos gerados a cada início em `%APPDATA%\deezer-player\`:

| Arquivo | Para quê |
|---|---|
| `config.json` | `{ "basePath": ... }` — pasta da biblioteca |
| `server\deezer-downloader.ini` | config do servidor (`base` = `basePath`, `music_dir_root` = `base`, porta escolhida) |
| `server\yt-dlp.cmd` | wrapper do `[youtubedl] command` (usa o mesmo Python) |
| `arl.bin` | ARL criptografado com `safeStorage` (DPAPI) — **nunca** em texto puro |

Instalação limpa do zero = `npm start` (ou o app empacotado) e o login do Deezer.

---

## 2. Estrutura do projeto

```
deezer-player\
├─ package.json        main: main.js | scripts.start: "electron ."
├─ main.js             janela sem borda + IPC (janela, servidor, API pública, config, login, biblioteca, capas)
├─ server.js           servidor nativo: runtime, porta, ini, ARL, start/stop/restart
├─ organizer.js        move/organiza downloads + índice + capas + .m3u8 + retry
├─ preload.js          expõe window.api para a tela (contextBridge)
├─ renderer\
│  ├─ index.html       HTML + CSS (o JS vive no index.js)
│  ├─ index.js         TODA a lógica do renderer (era inline no HTML; foi separado)
│  ├─ splash.html      tela de abertura
│  ├─ favicon.ico / favicon.png / logo-horizontal.png / splash-screen.png
│  └─ vendor\          split.min.js (split.js vendorizado)
├─ resources\server\
│  └─ python\          Python 3.13.3 embeddable + Lib\site-packages (~58 MB)
└─ node_modules\       electron (dev) e split.js
```

### Fluxo de uma chamada

```
index.html  →  backend.search(...)        (const backend = window.api)
preload.js  →  ipcRenderer.invoke('api:search')
main.js     →  fetch(`http://127.0.0.1:${porta}/search`)   (porta vem do server.js)
```

A tela **nunca** chama o servidor (`127.0.0.1:<porta>`) nem a API do Deezer direto (CORS em página `file://`). Tudo passa pelo `main.js`.

---

## 3. `main.js` e `window.api`

- `createWindow`: 1280x800, mínimo 900x600, `frame: false`, `contextIsolation: true`, `nodeIntegration: false`.
- `apiCall(route, body)` devolve `{ ok: true, data }` ou `{ ok: false, error }`.
- Handlers do **servidor** (porta dinâmica do `server.js`): `api:search`, `api:download`, `api:playlist`, `api:queue`.
- Handlers da **API pública do Deezer**: `api:searchPlaylists`, `api:searchAlbums`, `api:albumTracks` (limite 100, valida id numérico), `api:playlistTracks` (paginado, traz `artistId`/`albumId`/`cover`/`duration`/`preview`), `api:artistPage` (dados + top + álbuns em paralelo), `api:trackInfo`, `api:artistByName`.
- **Config:** `config:get`, `config:pickBase`.
- **Servidor:** `server:status` (sobe sozinho se já existe ARL guardado), `server:start`, `deezer:sessao` (checa o ARL no `gw-light.php`), `deezer:login` → `captureDeezerArl()` → `servidor.restart(arl)`.
- **Biblioteca:** `library:get` → `organizer.biblioteca()`; `library:tracks` → `organizer.faixas(rel)`; `library:ids` → `organizer.idsOffline()`; `library:path` → `organizer.caminhoDe(id)`; `library:artist` → `organizer.faixasArtista(nome)`; `library:cover` → `organizer.libraryCover(tipo, id)`.
- **Registro:** `album:registrar`, `playlist:registrar`.
- `servidor` é criado no `app.whenReady()` com `getBasePath`, `userDataDir`, `resourcesPath` (`app.isPackaged ? process.resourcesPath : <projeto>\resources`) e o `keychain` do `safeStorage`.
- `before-quit` chama `servidor.stop()`.

### `preload.js` → `window.api`

| Função | Faz |
|---|---|
| `win(action)` | min / max / close |
| `search(type, query)` | servidor; hoje só `track` é usado na busca |
| `download(type, musicId, createZip)` | `track` \| `album` (id vira `Number`) |
| `playlist(url, createZip)` | playlist pública do Deezer (URL ou id) |
| `queue()` | fila de tarefas |
| `searchPlaylists(query)` | API pública, até 10 |
| `searchAlbums(query)` | API pública, até 10, traz `nb_tracks` |
| `albumTracks(id)` | faixas do álbum |
| `playlistTracks(id)` | faixas da playlist (com `artistId`/`albumId`/`cover`) |
| `artistPage(id)` | `{ info, top, albums }` |
| `artistByName(name)` | acha o artista pelo nome (clique no card da biblioteca) |
| `trackInfo(id)` | dados da faixa (traz `artist.id` e `album.id`) |
| `configGet()` | → `{ basePath }` (`null` se não houver pasta salva ou ela não existir mais) |
| `pickBase()` | abre o seletor de pasta, salva e devolve `{ ok, basePath }` ou `{ ok: false, error }` |
| `deezerLogin()` | popup de login → grava o ARL (criptografado) e reinicia o servidor |
| `serverStatus()` | `{ ready, engine, arl, running, port }`; **sobe o servidor sozinho** se já houver ARL guardado |
| `serverStart()` | liga o servidor parado → `{ ready, port }` ou `{ ready: false, error }` |
| `deezerSessao()` | `'ok'` \| `'expired'` \| `'unknown'` — o ARL guardado ainda vale? |
| `registrarAlbum(album)` | registra um álbum para gerar o `.m3u8` quando todas as faixas forem organizadas |
| `registrarPlaylist(pl)` | registra uma playlist (idem) |
| `biblioteca()` | → `{ artists, albums, playlists }` lidos do disco (`Artistas\` + `.m3u8` + `#ALBUM`) |
| `faixas(rel)` | faixas de um `.m3u8` (recusa caminho fora da `basePath`) |
| `libraryIds()` | ids offline (índice do organizer) |
| `libraryPath(id)` | `file:///...` do áudio de uma faixa offline (ou `''`) |
| `libraryArtist(nome)` | faixas offline de um artista (com `albumId`/`artistId` do índice) |
| `libraryCover(tipo, id)` | `file:///...` de uma capa local (album / artist / playlist) ou `''` |

---

## 4. Comportamento da interface (decisões fechadas)

**Menu:** Mais queridas (inicial), Playlists, Álbuns, Artistas, Downloads, Configurações. **Álbum** e **Artista** não estão no menu: abrem por clique e têm "← Voltar" (volta pra busca). A view `#v-local` (faixas de um `.m3u8`) não é item de menu: tem "← Voltar" que retorna ao grid de origem.

**Busca:** campo único, resultados misturados na ordem **faixas → álbuns → playlists**, com badge de tipo (`MP3` cinza, `Álbum` contorno amarelo, `Playlist` amarelo). Filtro `Tudo | Música | Álbum | Playlist`. Sem coluna Dur. na busca. A coluna Álbum mostra o nome do álbum (MP3) ou `N faixas` (álbum/playlist).

**Cliques:**
- Linha **MP3** (fora de botões e links): toca/pausa o preview de 30s.
- **Nome do artista**: abre a página do Artista (em linha MP3 o id vem de `trackInfo`).
- Linha com badge **Álbum/Playlist**: abre a página.
- **Nome do álbum** numa linha MP3 ou nas Top músicas: abre o álbum (`.album-link`).

**Página do Álbum:** título, `Artista · N faixas`, botão **Baixar todas** no topo (só quando faz sentido — ver abaixo), tabela (#, Título, Dur., ações).

**Página do Artista (dois modos):**
- **Busca → artista** (online): foto, nome, fãs, nº de álbuns, **Top músicas** e grade de **Álbuns** do Deezer. Faixas já baixadas mostram `[offline]`.
- **Menu → Artistas → card** (offline): foto, nome, **só as faixas que estão no disco** (sem top/álbuns do Deezer). Cada faixa mostra o selo `[offline]` e a capa do álbum (do índice).

**Status no lugar do botão Baixar:** ao clicar vira badge de mesmo tamanho: **Aguardando → Baixando... → Completo** (erro vira "Erro, tentar de novo"). `jobs` guarda `"tipo:id"` → `task_id | "pending" | "error"`; o estado real vem de `lastTasks` via `stateMap`. `refreshSlots()` é chamada pelo `MutationObserver` e pelo `pollQueue`.

**Download do álbum inteiro (regras):**
- **Busca → Baixar na linha do álbum/playlist**: 1 tarefa (`album`/`playlist`), 1 item em Downloads (`1/N → N/N`), organizer gera o `.m3u8` quando a fila para.
- **Página do álbum → "Baixar todas"**: 1 tarefa (igual à busca). O botão **só aparece** quando o álbum veio **pela busca** e **ainda não está completo**. Fica **desabilitado** com "Baixando..." enquanto a tarefa está na fila, e **some** quando fica completo (`stAlbum === 'done'` ou todas as faixas com selo `[offline]`).
- Na página do álbum, **enquanto o álbum inteiro está sendo baixado**, todas as faixas herdam o badge do álbum e o botão "Baixar" de cada faixa fica bloqueado.
- Depois do download, as faixas passam a `[offline]` **sem precisar reabrir a página** (o `pollQueue` atualiza `offIds` quando um job de álbum/playlist vira `done`).

**Selo `[offline]`:**
- **Faixa (MP3, Top músicas, linha de álbum/playlist)**: id em `offIds`.
- **Álbum/Playlist na busca**: `offAlbumsFaixas.get(albumKey) >= nb_tracks` (precisa de **todas** as faixas no disco; se alguma falhou, continua "Baixar").
- **Card do grid da biblioteca**: o `.m3u8` existe (o card é lido do disco).

**Capas locais (offline-first):**
- **Álbum**: `Albuns\<artista>\.covers\<albumId>.jpg` (a mesma imagem também em `Artistas\<artista>\.covers\<albumId>.jpg`).
- **Artista**: `Artistas\<artista>\.artist.jpg`.
- **Playlist**: `Playlists\.covers\<playlistId>.jpg`.
- O frontend usa `libraryCover(tipo, id)` (via `capaLocal`, com cache em `Map` que **só guarda quando acha**). Se a capa local existe, **prefere a local**; senão mantém a do Deezer (online) ou o gradiente (offline).
- **Cards do grid**: passam `data-cover-tipo`/`data-cover-id` e o `aplicarCapa` aplica.

**Player:** barra inferior com shuffle, anterior, play/pause, próxima, repetir, progresso, mudo e volume. Anterior/próxima andam só dentro da tabela da faixa em reprodução. A capa do player (`#np-cover`) tenta a capa local (se existir) antes da do Deezer.

**Download de faixa avulsa:** na página do álbum/playlist, o botão "Baixar" de cada faixa continua. Ele é bloqueado enquanto o álbum inteiro está na fila. Fora da página (busca), funciona normal.

**Tabelas ordenáveis** por clique no cabeçalho (▲/▼); `#` restaura a ordem original.

**Configurações:** formulário pronto, **ainda não salva** (só a pasta base e o login funcionam de verdade). O seletor de qualidade (MP3 128 / 320 / FLAC) **não bate** com o servidor, que só aceita `mp3` ou `flac` (`DEEZER_QUALITY`).

---

## 5. Servidor deezer-downloader (código real)

Flask em `resources\server\python\Lib\site-packages\deezer_downloader\web\app.py`.

| Rota | Método | Envia | Devolve |
|---|---|---|---|
| `/search` | POST | `{type, query}` (`track`, `album`, `album_track`) | lista |
| `/download` | POST | `{type: track\|album, music_id, add_to_playlist, create_zip}` (**os 4 obrigatórios**) | `{task_id}` |
| `/playlist/deezer` | POST | `{playlist_url, add_to_playlist, create_zip}` | `{task_id}` |
| `/favorites/deezer` | POST | `{user_id, add_to_playlist, create_zip}` | `{task_id}` |
| `/playlist/spotify` | POST | — | **quebrada** (issue #174) |
| `/youtubedl` | POST | `{url, add_to_playlist}` | `{task_id}` |
| `/queue` | GET | — | lista de tarefas |
| `/downloads/<path>` | GET | — | índice HTML dos arquivos |
| `/debug` | GET | — | `{debug_msg}` |

**Não existem:** cancelar download, rota de configurações, autenticação, busca de playlist/artista, busca no Spotify.

### `/queue` (formato real)

Cada tarefa: `{id, description, args, state, result, exception, progress: [cur, max]}`.

- `state`: `active`, `mission accomplished`, `failed`; qualquer outro = na fila.
- **`args` e `result` NÃO são JSON**: são `repr()` de Python, **escapados em HTML**.
  - faixa: `args = "{&#39;track_id&#39;: 1508013552, ...}"`, `result = "[&#39;songs/Artista - Título.mp3&#39;]"`
  - álbum: `args = "{&#39;album_id&#39;: 99959372, ...}"`, `result` = lista de `albums/<pasta>/NN - <arquivo>.mp3`
  - playlist: `args = "{&#39;playlist_url&#39;: &#39;https://www.deezer.com/playlist/123&#39;}"`, `result` = lista de `playlists/<nome>/<arquivo>.mp3`
  - quando o nome tem apóstrofo, o Python usa aspas duplas: `[&#34;...&#34;]`
  - `&` vira `&amp;`.
  - Para ler: decodificar entidades HTML (`&#39;`, `&#34;`, `&amp;`) e depois extrair os literais de string do repr (não usar `JSON.parse`).
- Os caminhos em `result` são **relativos à `base`** (que é o `music_dir_root`). No **motor nativo (Windows)** vêm com `\` escapado no repr (`songs\\Artista - Título.mp3`). Decodificar as entidades HTML **antes** de ler o caminho.
- `progress` de álbum concluído fica defasado em 1 (`[14, 15]`). O app mostra `N arquivos` ao concluir.

### Nomes de arquivo gerados pelo servidor

- Faixa avulsa: `songs\Artista - Título.mp3`
- Álbum: `albums\Artista - Álbum\NN - Artista Título.mp3` — **sem separador entre artista e título**. O título limpo e o id vêm de `album/{id}/tracks` casando `NN` com `track_position`.
- Playlist: `playlists\<nome da lista>\<arquivo>.mp3` — **sem `__id`** no nome. O organizer casa cada arquivo com `playlist/{id}/tracks` pelo `"Artista - Título"` normalizado.

### Config do servidor

`configuration.py` lê o `.ini` passado em `-c` — `%APPDATA%\deezer-player\server\deezer-downloader.ini`, gerado pelo `server.js` a cada início. `DEEZER_COOKIE_ARL` e `DEEZER_QUALITY` (`mp3` ou `flac`) **sobrescrevem** o `.ini`.

O servidor **não sobe** se:

- seções na ordem `DEFAULT, mpd, download_dirs, debug, http, proxy, threadpool, deezer, youtubedl` (há um `assert`);
- `[download_dirs] base` tem que **começar com** `[mpd] music_dir_root` — usamos os dois iguais à `basePath`, e assim o `result` da fila vem **relativo**;
- `[youtubedl] command` tem que apontar para um arquivo existente (daí o `yt-dlp.cmd`).

Motor atual: **Python 3.13.3** (embutido) com `deezer-downloader 2.15.0`, `pycryptodome 3.24.1`, `waitress 3.0.2`, `flask 3.1.3`, `yt-dlp`.

### API pública do Deezer (sem autenticação, chamada pelo `main.js`)

- `search/playlist?q=` → `id, title, nb_tracks, picture_small, user.name`
- `search/album?q=` → `id, title, nb_tracks, cover_small, artist.{id,name}`
- `album/{id}/tracks?limit=100` → `id, title, duration, track_position, preview, artist.name`
- `playlist/{id}/tracks?limit=100&index=N` → idem + `album.{id,title,cover_small}`
- `artist/{id}` → `name, picture_big, nb_fan, nb_album`
- `artist/{id}/top?limit=10` → faixas com `preview`, `duration`, `album.{id,title,cover_small}`
- `artist/{id}/albums?limit=50` → `id, title, cover_small, cover_medium, release_date, record_type`
- `track/{id}` → `artist.id`, `album.id`, `album.title`
- `search/artist?limit=5&q=` → `id, name`

Os ids são os mesmos que o servidor usa no `/download`.

---

## 6. Armazenamento da biblioteca

### Fluxo

1. O servidor baixa do jeito dele (`songs\`, `albums\...`, `playlists\<nome>\...`) **dentro da `basePath`**.
2. Quando a tarefa chega em `mission accomplished`, o app **MOVE** (não copia) os arquivos pra estrutura final.
3. Vale **só para downloads novos**. A biblioteca antiga **não é migrada**.

### Pasta base

- **Não existe pasta padrão.** Ao iniciar, se não houver `basePath` salvo (ou a pasta não existir mais), o app abre o **modal** pedindo **uma única pasta base**.
- A `basePath` é salva em `config.json` dentro de `app.getPath('userData')` (Windows: `%APPDATA%\<name do package.json>\config.json`). Formato: `{ "basePath": "<absoluta>" }`.

### Estrutura final dentro da `basePath`

```
<basePath>\
├─ Artistas\
│  ├─ <artista>\
│  │  ├─ <nome original>__<id>.mp3
│  │  ├─ .artist.jpg                     ← foto do artista (1 por pasta)
│  │  └─ .covers\<albumId>.jpg            ← capa do álbum (1 por álbum)
│  └─ ...
├─ Albuns\
│  ├─ <artista>\
│  │  ├─ <álbum>.m3u8                     ← lista (com #EXTINF e #ALBUM:<id>)
│  │  └─ .covers\<albumId>.jpg            ← mesma capa, caminho curto pro .m3u8
│  └─ ...
├─ Playlists\
│  ├─ <playlist>.m3u8
│  └─ .covers\<playlistId>.jpg            ← capa da playlist
└─ .deezer\
   ├─ indice.json                          ← { tracks: {id: {rel, albumId, artistId}}, tasks: [] }
   ├─ albuns.json                          ← { id, title, artist, trackIds } (álbuns registrados)
   ├─ playlists.json                       ← { id, title, trackIds } (playlists registradas)
   ├─ covers.json                          ← { "album:<id>": rel, "artist:<id>": rel, "playlist:<id>": rel }
   └─ falhas.json                          ← tarefas que falharam e o estado do retry
```

- **Todas as faixas ficam em `Artistas\<artista>\`**, independente de álbum.
- Nome do arquivo: `<nome original do servidor sem extensão>__<id do Deezer>.mp3` (ex.: `CPM 22 - A Cura__4704282.mp3`). O `__id` evita colisão entre versões com o mesmo título.
- Álbuns e playlists **não têm cópia de arquivos**: viram `.m3u8` com:
  - **`#ALBUM:<id>`** logo depois do `#EXTM3U` (só em álbuns, quando o organizer sabe o id) — é a **fonte primária** do `albumId` pro grid da biblioteca.
  - **`#EXTINF:<segundos>,<nome limpo>`** antes de cada caminho (duração + nome vindo da API).
  - **Caminho relativo à pasta do `.m3u8`**, com `/`:
  ```
  #EXTM3U
  #ALBUM:127372463
  #EXTINF:292,Angra - Nova Era
  ../../Artistas/Angra/Angra - Nova Era__127372463.mp3
  ```
- O `.m3u8` da playlist **não tem `#ALBUM`** (é playlist, não álbum).
- `repararM3u8()` roda no `start()` do organizer e reescreve **uma vez** qualquer `.m3u8` que ainda não tenha `#EXTINF`.
- **A biblioteca do app lê os `.m3u8`** com `lerM3u8()`: cada `#EXTINF` vira `{ nome, dur }` e a linha seguinte é o caminho da faixa. `biblioteca()` lê `Artistas\` (pastas + nº de áudios) e os `.m3u8` de `Albuns\` e `Playlists\`; `faixas(rel)` devolve as faixas de um arquivo (recusa caminho fora da `basePath`). Nada toca o áudio — é só leitura.

### Índice (`indice.json`)

- `tracks`: `id -> { rel, albumId, artistId }`. O `rel` é o caminho relativo à `basePath`.
- `tasks`: lista de `task_id` já organizadas (evita processar duas vezes).
- Aceita **formato antigo** (`id -> "caminho"` string) e **novo** (objeto). O `readIndex` normaliza.
- O `albumId`/`artistId` no índice permitem que as faixas offline mostrem capa e link do artista **sem chamar a API**.

### Como o organizer obtém os dados

- **Faixa avulsa:** `args.track_id` + `result[0]`. Título/artista/álbum via `track/{id}`.
- **Álbum:** `args.album_id` + `result[]`. Para cada arquivo, extrair `NN` do início do nome e casar com `track_position` de `album/{id}/tracks` para obter id e título limpo.
- **Playlist:** `args.playlist_url` (extrai `playlist_id` da URL) + `result[]`. Casa cada arquivo com `playlist/{id}/tracks` pelo `"Artista - Título"` normalizado (minúsculas, sem acento, sem pontuação). Se a API estiver fora, **deixa os arquivos em `playlists\<nome>\`** e tenta no próximo ciclo (não move "meio certo").
- Sanitizar nomes para Windows (`< > : " / \ | ? *`, ponto/espaço no fim, tamanho).

### Backfill (biblioteca antiga)

- **`reconstruirIndice()`**: varre `Artistas\` procurando `__<id>.mp3` e preenche `tracks[id] = { rel }`.
- **`reconstruirAlbuns()`**: varre `Albuns\` lendo `.m3u8` e completa `albuns.json` (lê `#ALBUM:<id>` se tiver).
- **`backfillAlbumIds()`**: pra faixas antigas sem `albumId`, cruza o artista do caminho com o `covers.json` e preenche `albumId`/`artistId` no índice. **Sem API**.
- **`backfillAlbunsViaAPI()`**: pra `.m3u8` sem `#ALBUM:<id>`, chama `track/{id}` da primeira faixa pra descobrir o `albumId`, grava `#ALBUM:<id>` no `.m3u8` e registra no `albuns.json`. Roda uma vez no `start()`; se a API estiver fora, tenta no próximo boot.

### Dedupe (camadas, em ordem)

1. id da plataforma (Deezer) → 2. ISRC (vem em `album/{id}/tracks`) → 3. caminho previsível → 4. fila sem repetidos → 5. hash opcional.

---

## 7. Login do Deezer e servidor nativo

Botão **Configurações → Entrar com Deezer** (`deezer:login`):

1. `captureDeezerArl()` abre `https://www.deezer.com/login` numa janela com **sessão só em memória** (`partition: 'deezer-login'`, sem `persist:`), observa o cookie `arl` e fecha ao capturá-lo (`null` se o usuário fechar sem logar).
2. `servidor.restart(arl)` para o processo atual e sobe de novo com o ARL novo, passado **só** por `env` (`DEEZER_COOKIE_ARL` + `DEEZER_QUALITY=mp3`).
3. Só **depois** que o `/queue` responde o ARL é gravado em `%APPDATA%\deezer-player\arl.bin` (`safeStorage` → DPAPI). Se a subida falhar, nada é gravado.

O ARL nunca vai para a tela, nunca é gravado em texto puro e é mascarado nas mensagens de erro (`split(arl).join('***')`).

### `server.js`

`module.exports = ({ getBasePath, userDataDir, resourcesPath, keychain, log })` → `{ apiBase, getArl, saveArl, status, start, stop, restart }`.

- **Runtime** (`resolverRuntime()`, em cache): `DEEZER_PYTHON` (só dev/teste) → `python` → `py -3` → `resources\server\python\python.exe`. O primeiro que responder `import deezer_downloader` vence; se nenhum, `engine: 'missing'`.
- **Porta** (`acharPorta()`): testa **por conexão** (`net.connect`), não por `listen`. Faixa 5000–5020.
- **Config** (`escreverConfig()`): recria `server\deezer-downloader.ini` e `server\yt-dlp.cmd` a cada início, já com a porta escolhida.
- **Start**: `spawn(..., windowsHide)`, stdio em pipe (guarda os últimos 4 KB de log, com o ARL mascarado), espera o `/queue` até **30 s**; se não responder, para o processo e devolve o erro.
- **Stop**: `taskkill /pid <pid> /T /F` **detached** (`unref`) — funciona mesmo com o app fechando e mata a árvore.
- **status()**: `{ ready, engine: 'dev'|'system'|'embedded'|'missing', arl: 'saved'|'none', running, port }`.
- **restart(arl)**: `stop()` → `start(arl)` → grava o ARL se subiu.

### Modal de pré-requisitos (`#m-docker`)

Depois do modal da pasta base, `initBase()` chama `initServidor()`, que consulta `server:status` (e esse handler **sobe o servidor sozinho** quando já existe ARL guardado). Se ainda faltar algo, abre um modal **travante** (só fecha quando está tudo pronto):

| Situação no `status` | Título | Ação do botão |
|---|---|---|
| `engine: 'missing'` | Falta o componente de download | nenhuma |
| `arl: 'none'` | Falta entrar com o Deezer | **Entrar com Deezer** → `deezer:login` |
| `running: false` | O Deezer está desligado | **Ligar o Deezer** → `server:start` |
| rodando, mas `/queue` não responde | O Deezer não respondeu | **Entrar novamente** → `deezer:login` |

Os ids do HTML continuam `m-docker*` (herança do Docker); só o texto mudou.

---

## 8. Segurança ⚠️

- O **ARL** é chave de acesso à conta Deezer. **Nunca cole ARL em chat, log ou arquivo versionado.**
- **Onde ele vive:** só em `%APPDATA%\deezer-player\arl.bin`, criptografado com `safeStorage` (DPAPI — só o seu usuário do Windows descriptografa), e na memória do processo Python como variável de ambiente. O `.ini` tem apenas um placeholder de zeros.
- O log do servidor guarda no máximo 4 KB e passa por `split(arl).join('***')` antes de qualquer mensagem.

---

## 9. Erros e armadilhas que já aconteceram

| Sintoma | Causa | Solução |
|---|---|---|
| `Identifier 'api' has already been declared` | `window.api` do contextBridge é protegido | renomeado para `const backend` |
| `Cannot access 'X' before initialization` | bloco colado antes da declaração (`const`/`let`) | respeitar a ordem das 15 seções |
| Clique em álbum "não faz nada", sem erro | listener sumiu ao substituir função vizinha | conferir que o `addEventListener` existe |
| ▶ toca e pausa na hora | dois listeners de play ativos | manter só o listener das 3 tabelas na seção 07 |
| ▶ antigo continua amarelo | `markPlaying` duplicada | manter só a versão que limpa `tr.row .ibtn.on` |
| Tela não muda ao abrir página nova | `<section class="view">` inexistente no load, ou `getElementById` nulo | conferir HTML da view e ids |
| `ReferenceError: curAlbum is not defined` no DevTools | `index.js` está num IIFE (escopo privado) | usar `window.api` pra testar o backend |
| `offAlbumsFaixas is not defined` | faltou declarar o Map no topo | adicionar `const offAlbumsFaixas = new Map()` |
| `file:///...` não renderiza com `!` no path | Electron/Chromium estrito com `!` em `background-image` | usar `url("...")` (com aspas) |
| Capa não aparece no card | `.cv` sem `data-cover-tipo`/`data-cover-id` | passar `coverTipo`/`coverId` no `cardHTML` e chamar `aplicarCapa` |
| Capa errada (álbum A com capa do B) | fallback do `idDoAlbum` pegava a 1ª capa do artista | ler `#ALBUM:<id>` do `.m3u8` (fonte primária) |
| `.m3u8` de playlist não gerado | `playlists.json` vazio (o app não chamava `registrarPlaylist`) | o organizer registra **internamente** ao casar |
| Download `failed`: "not logged in" | ARL vencido | **Entrar com Deezer** |
| `SyntaxError: invalid syntax` ao rodar `python -c "..."` | PowerShell quebra as aspas | chamar por `spawn`/`execFile` **sem shell** |
| Servidor com "Debug mode: on" (2 processos) | `python -m deezer_downloader.cli.runner` | usar `-c "from ... import main; main()"` |
| App "conecta" mas é o Docker respondendo | teste de porta por `listen` não vê o IPv6 | testar por **conexão** (`net.connect`) |
| `pip` traz `pycryptodome 4.x` e o pacote pede `<4` | `--only-binary` sem deps | fixar `pycryptodome<4` |
| Arquivo existe mas o organizer diz que não | `result` com `&amp;` no nome | decodificar HTML **antes** de `path.join` |
| `await is only valid in async functions` no `backfillAlbunsViaAPI` | `walk` síncrona com `await` dentro | `const walk = async (...) => { ... }` e `await walk(...)` |

**Depuração:** uma busca por `nomeDaFuncao` no `renderer/index.js` acha função duplicada ou listener perdido. No DevTools: `await window.api.albumTracks(273425942)`. Para ver a fila crua: `Invoke-RestMethod http://127.0.0.1:5000/queue | ConvertTo-Json -Depth 5`.

---

## 10. Próximos passos (em ordem)

1. **Empacotamento:** `electron-builder` com `extraResources` para `resources\server` (instalador estimado em 30–40 MB comprimido). Testar em máquina **sem** Python e **sem** Docker.
2. **Configurações persistentes** (o restante do formulário). O seletor de qualidade (MP3 128 / 320 / FLAC) **não bate** com o servidor, que só aceita `mp3` ou `flac`.
3. **Telas do menu com dados reais** (Mais queridas, Playlists, Álbuns, Artistas): hoje só Álbuns/Playlists/Artistas leem do disco; "Mais queridas" é vazio de propósito.

### Backlog

- **Favoritas de verdade.** Não existe fonte real. Ideias: arquivo `.deezer\favoritos.json` com ids, contador de plays, "últimas baixadas".
- **"← Voltar"** do álbum aberto pelo artista hoje leva à busca, não ao artista.
- **Playlist na busca não tem página própria** — reaproveita a do álbum.
- **Preview:** o token do `preview_url` expira; se falhar, buscar de novo.
- **Capas maiores:** trocar `56x56` na URL (a API pública já traz `cover_medium`/`picture_big`).
- **Cancelar download:** o servidor não suporta (o botão só remove o item da tela).
- **Spotify:** sem busca nem download funcional.
- **Mensagens de erro** da página do Álbum usam `colspan="5"` (a tabela tem 4 colunas; inofensivo).
- **Escolher o nome final do app** (afeta `package.json`, a pasta do `config.json` em `%APPDATA%`, título da janela).

---

## 11. Convenções do código

- `renderer/index.html`: indentado com **TAB** e finais de linha **CRLF**. Preserve ambos.
- A lógica do renderer vive em `renderer/index.js`, dentro de um **IIFE** (escopo privado, sem `window.*` de estado).
- **Nunca versione segredos** — o ARL em particular (ver seção 8).
- Em documentação, referencie caminhos locais como **placeholder** (`<caminho-do-projeto>`, `<basePath>`), nunca com o caminho absoluto da sua máquina.
