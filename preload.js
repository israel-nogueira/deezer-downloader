// ===== Ponte segura entre o renderer (index.js) e o main process =====
// contextIsolation: true + nodeIntegration: false (ver main.js).
// Cada função aqui vira `window.api.<nome>` no renderer.
// Nada de lógica aqui: só repassa o IPC e devolve a Promise do handler.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ===== Janela (titlebar customizada) =====
  win: (action) => ipcRenderer.send('win:control', action),

  debugPaths: () => ipcRenderer.invoke('debug:paths'),
	// ===== Explorar =====
	exploreChart: () => ipcRenderer.invoke('explore:chart'),
	exploreChartGenre: (opts) => ipcRenderer.invoke('explore:chartGenre', opts || {}),
	exploreGenres: () => ipcRenderer.invoke('explore:genres'),
	exploreEditorial: () => ipcRenderer.invoke('explore:editorial'),
	exploreEditorialSections: () => ipcRenderer.invoke('explore:editorialSections'),
	exploreSelection: (opts) => ipcRenderer.invoke('explore:selection', opts || {}),
	exploreReleases: (opts) => ipcRenderer.invoke('explore:releases', opts || {}),
	exploreChartTracks: (opts) => ipcRenderer.invoke('explore:chartTracks', opts || {}),
	exploreChartAlbums: (opts) => ipcRenderer.invoke('explore:chartAlbums', opts || {}),
  // ===== Janela: modo mini =====
  winCompactar: () => ipcRenderer.invoke('win:compactar'),
  winDescompactar: () => ipcRenderer.invoke('win:descompactar'),
  winEstadoMini: () => ipcRenderer.invoke('win:estadoMini'),
  onModoMini: (cb) => ipcRenderer.on('win:modoMini', (e, v) => cb(v)),

  // ===== Servidor local (deezer-downloader) =====
  search: (type, query) => ipcRenderer.invoke('api:search', { type, query }),
  download: (type, musicId, createZip = false) =>
    ipcRenderer.invoke('api:download', { type, musicId, createZip }),
  playlist: (url, createZip = false) =>
    ipcRenderer.invoke('api:playlist', { url, createZip }),
  queue: () => ipcRenderer.invoke('api:queue'),

  // ===== API pública do Deezer =====
  searchPlaylists: (query) => ipcRenderer.invoke('api:searchPlaylists', { query }),
  searchAlbums: (query) => ipcRenderer.invoke('api:searchAlbums', { query }),
  albumTracks: (id) => ipcRenderer.invoke('api:albumTracks', { id }),
  albumInfo: (id) => ipcRenderer.invoke('api:albumInfo', { id }),
  playlistTracks: (id) => ipcRenderer.invoke('api:playlistTracks', { id }),
  artistPage: (id) => ipcRenderer.invoke('api:artistPage', { id }),
  artistByName: (name) => ipcRenderer.invoke('api:artistByName', { name }),
  trackInfo: (id) => ipcRenderer.invoke('api:trackInfo', { id }),

  // ===== Biblioteca =====
  biblioteca: () => ipcRenderer.invoke('library:get'),
  faixas: (rel) => ipcRenderer.invoke('library:tracks', rel),
  libraryIds: () => ipcRenderer.invoke('library:ids'),
  libraryPath: (id) => ipcRenderer.invoke('library:path', id),
  libraryArtist: (nome) => ipcRenderer.invoke('library:artist', nome),
  libraryCover: (tipo, id) => ipcRenderer.invoke('library:cover', { tipo, id }),

  libraryArtistAlbums: (nome) => ipcRenderer.invoke('library:artistAlbums', nome),
  libraryArtistPlaylists: (nome) => ipcRenderer.invoke('library:artistPlaylists', nome),

  // ===== Favoritos =====
  favoritesList: () => ipcRenderer.invoke('favorites:list'),
  favoritesAdd: (id) => ipcRenderer.invoke('favorites:add', id),
  favoritesRemove: (id) => ipcRenderer.invoke('favorites:remove', id),

  // ===== Playlists do usuário =====
  playlistsList: () => ipcRenderer.invoke('playlists:list'),
  playlistsMeta: () => ipcRenderer.invoke('playlists:meta'),
  playlistsCreate: (title) => ipcRenderer.invoke('playlists:create', title),
  playlistsAddFaixa: (title, id) => ipcRenderer.invoke('playlists:addFaixa', { title, id }),
  playlistsRemoveFaixa: (title, id) => ipcRenderer.invoke('playlists:removeFaixa', { title, id }),
  playlistsDelete: (title) => ipcRenderer.invoke('playlists:delete', title),
  playlistsTocar: (title) => ipcRenderer.invoke('playlists:tocar', title),

  // ===== Registro de álbum/playlist =====
  registrarAlbum: (album) => ipcRenderer.invoke('album:registrar', album),
  registrarPlaylist: (pl) => ipcRenderer.invoke('playlist:registrar', pl),

  // ===== Configuração e servidor =====
  configGet: () => ipcRenderer.invoke('config:get'),
  pickBase: () => ipcRenderer.invoke('config:pickBase'),
  serverStatus: () => ipcRenderer.invoke('server:status'),
  serverStart: () => ipcRenderer.invoke('server:start'),
  deezerLogin: () => ipcRenderer.invoke('deezer:login'),
  deezerSessao: (opts) => ipcRenderer.invoke('deezer:sessao', opts || {}),
  deezerRequireSession: (opts) => ipcRenderer.invoke('deezer:requireSession', opts || {}),

  // ===== Sistema =====
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
});