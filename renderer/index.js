/* ==========================================================================
	ÍNDICE
	01. Ponte com o Electron (backend)
	02. Helpers (texto, offline, capas, favoritos)
	03. Layout: Split.js (sidebar redimensionável)
	04. Navegação entre views
	05. Templates HTML (tag, card, linha de faixa)
	06. Biblioteca (menu lateral: artistas, álbuns, playlists)
	06b. Tabela de playlists (nome, músicas, criada, última)
	06c. Faixas locais (view #v-local)
	07. Player (fila de execução)
	08. Busca (com AbortController)
	09. Ordenação das tabelas
	10. Downloads (fila do servidor)
	11. Página do álbum
	12. Página do artista (abas: Músicas | Álbuns | Playlists)
	13. Favoritos ("Mais queridas" = .m3u8)
	14. Adicionar à playlist (modal unificado)
	14b. Nova playlist (botão + modal)
	15. Configurações
	16. Banner de "sem conexão" (NÃO-BLOQUEANTE)
	17. Janela (titlebar)
	18. Mini player (modo compactado)
	19. Inicialização
	========================================================================== */

(() => {
	/* ==========================================================================
		01. PONTE COM O ELECTRON
		========================================================================== */
	const offline = async () => ({ ok: false, error: "fora do Electron" });
	const backend = window.api || {
		win() {},
		search: offline,
		download: offline,
		playlist: offline,
		queue: offline,
	};

	/* ==========================================================================
		02. HELPERS
		========================================================================== */

	const esc = (s) =>
		String(s ?? "").replace(
			/[&<>"']/g,
			(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
		);

	const dec = (s) =>
		String(s ?? "")
			.replace(/&#39;/g, "'")
			.replace(/&#34;/g, '"')
			.replace(/&quot;/g, '"')
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&amp;/g, "&");

	const grad = (n) =>
		`linear-gradient(135deg,hsl(${(n * 47) % 360} 60% 45%),hsl(${(n * 47 + 50) % 360} 60% 18%))`;

	const fill = (r) => r.style.setProperty("--v", (r.value / r.max) * 100 + "%");

	const fmtT = (s) =>
		isFinite(s)
			? String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(Math.floor(s % 60)).padStart(2, "0")
			: "00:00";

	const put = (id, html) => {
		const el = document.getElementById(id);
		if (el) el.innerHTML = html;
	};

	const norm = (s) =>
		String(s ?? "")
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]/g, "");

	const albumKey = (artista, titulo) => norm(artista) + "|" + norm(titulo);

	const offIds = new Set();
	const offAlbumsFaixas = new Map();
	const offPlaylistsFaixas = new Map();
	const offPlaylistsIds = new Map(); // nome -> Set<id>
	const offFavs = new Set();

	const FAVS_REL = "Playlists/mais-queridas.m3u8";
	const FAVS_TITLE = "Mais queridas";

	async function atualizarOffline(lib) {
		try {
			if (backend.libraryIds) {
				const ids = await backend.libraryIds();
				offIds.clear();
				(ids || []).forEach((id) => offIds.add(String(id)));
			}
			if (backend.favoritesList) {
				try {
					const favs = await backend.favoritesList();
					offFavs.clear();
					(favs || []).forEach((id) => offFavs.add(String(id)));
				} catch (e) { /* mantém */ }
			}
			if (!lib && backend.biblioteca) lib = await backend.biblioteca();
			if (lib) {
				offAlbumsFaixas.clear();
				offPlaylistsFaixas.clear();
				offPlaylistsIds.clear();
				(lib.albums || []).forEach((a) => {
					const k = albumKey(a.artist, a.title);
					offAlbumsFaixas.set(k, a.faixas || 0);
				});
				(lib.playlists || []).forEach((p) => {
					offPlaylistsFaixas.set(norm(p.title), p.faixas || 0);
				});
				if (backend.faixas) {
					for (const p of lib.playlists || []) {
						try {
							const fs2 = await backend.faixas(p.rel);
							offPlaylistsIds.set(p.title, new Set((fs2 || []).map((x) => String(x.id)).filter(Boolean)));
						} catch (e) { /* ignora */ }
					}
				}
			}
		} catch (e) { /* ... */ }
	}

const seloOffline =
    '<span class="tag s-off" data-off-badge="1" role="button" tabindex="0" title="Já está no disco — clique para abrir">' +
    '<svg class="i sm" style="vertical-align:-3px;margin-right:4px"><use href="#i-play"/></svg>' +
    'Disponível</span>';
	const coverCache = new Map();

	async function capaLocal(tipo, id) {
		if (!tipo || !id || !backend.libraryCover) return "";
		const chave = `${tipo}:${id}`;
		if (coverCache.has(chave)) return coverCache.get(chave);
		try {
			const url = await backend.libraryCover(tipo, id);
			if (url) {
				coverCache.set(chave, url);
				return url;
			}
			return "";
		} catch (e) {
			return "";
		}
	}

	async function aplicarCapa(el) {
		if (!el) return;
		const tipo = el.dataset.coverTipo;
		const id = el.dataset.coverId;
		if (!tipo || !id) return;
		const url = await capaLocal(tipo, id);
		if (!url) return;
		el.style.background = `url("${url}") center/cover`;
	}

	async function prepararLinhaOffline(row, id) {
		if (!row || !id || !backend.libraryPath) return;
		if (!offIds.has(String(id))) return;
		try {
			const url = await backend.libraryPath(id);
			if (url) {
				row.dataset.preview = url;
				row.dataset.offline = "1";
				marcarTocando();
			}
		} catch (e) { /* mantém */ }
	}

	function formatarData(iso) {
		const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
		if (!m) return "";
		return `${m[3]}/${m[2]}/${m[1]}`;
	}

	function fmtDataHora(iso) {
		if (!iso) return "—";
		const d = new Date(iso);
		if (isNaN(d)) return "—";
		const p = (n) => String(n).padStart(2, "0");
		return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
	}

	/* ==========================================================================
		03. LAYOUT: Split.js
		========================================================================== */
	if (typeof Split === "function") {
		let saved = [18, 82];
		try {
			saved = JSON.parse(localStorage.getItem("split-sizes")) || saved;
		} catch (e) {}

		const split = Split(["#side", "#main"], {
			sizes: saved,
			minSize: [200, 520],
			maxSize: [480, Infinity],
			gutterSize: 4,
			snapOffset: 0,
			onDragEnd: (s) => {
				try {
					localStorage.setItem("split-sizes", JSON.stringify(s));
				} catch (e) {}
			},
		});

		const gutter = document.querySelector(".gutter");
		if (gutter) {
			gutter.addEventListener("dblclick", () => {
				split.setSizes([18, 82]);
				try {
					localStorage.removeItem("split-sizes");
				} catch (e) {}
			});
		}
	}

	/* ==========================================================================
		04. NAVEGAÇÃO ENTRE VIEWS
		========================================================================== */
		const views = document.querySelectorAll(".view");
		function showView(name) {
			views.forEach((v) => v.classList.toggle('on', v.id === 'v-' + name));
			document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.view === name));
			const main = document.getElementById('main');
			if (main) main.scrollTop = 0;
			if (name === 'favs') renderFavs();
			if (name === 'settings') verificarContaNaTela();
			if (name === 'explore') carregarExplorar(); // <-- ADICIONE
			marcarTocando();
		}
	document
		.querySelectorAll("[data-view]")
		.forEach((el) => el.addEventListener("click", () => showView(el.dataset.view)));


		/* ===== Filtro global "mostrar apenas offline" ===== */
		let soOffline = false;
		try { soOffline = localStorage.getItem("so-offline") === "1"; } catch (e) {}

		const linhaOffline = (row) =>
			row && (row.dataset.off === "1" || row.dataset.offline === "1");

		function aplicarFiltroOfflineTabela(tbody) {
			if (!tbody) return;
			let n = 0;
			[...tbody.querySelectorAll("tr.row")].forEach((row) => {
				const mostrar = !soOffline || linhaOffline(row);
				row.style.display = mostrar ? "" : "none";
				if (mostrar) {
					const td = row.cells[1];
					if (td) td.textContent = ++n;
				}
			});
		}

		function aplicarFiltroOffline() {
			document.querySelectorAll(".chk-offline").forEach((c) => (c.checked = soOffline));

			// Tabelas sem paginação: esconde linhas online e renumera
			["t-album", "t-favs"].forEach((id) =>
				aplicarFiltroOfflineTabela(document.getElementById(id))
			);


			// Cards (álbum/artista/playlist local): esconde os que não têm offline
			document.querySelectorAll(".card[data-off]").forEach((card) => {
				const mostrar = !soOffline || card.dataset.off === "1";
				card.style.display = mostrar ? "" : "none";
			});

			// Aviso quando um grid fica vazio por causa do filtro
			document.querySelectorAll(".grid").forEach((grid) => {
				const cards = [...grid.querySelectorAll(":scope > .card")];
				if (!cards.length) return;
				const visiveis = cards.filter((c) => c.style.display !== "none");
				let aviso = grid.querySelector(".filtro-vazio");
				if (!visiveis.length) {
					if (!aviso) {
						aviso = document.createElement("small");
						aviso.className = "filtro-vazio";
						aviso.style.color = "var(--mut)";
						aviso.style.padding = "8px 0";
						aviso.textContent = "Nenhum item offline neste filtro.";
						grid.appendChild(aviso);
					}
				} else if (aviso) {
					aviso.remove();
				}
			});

			// Aba Músicas do artista (paginação própria): re-render
			if (curArtist) renderMusicasOffline();
		}

		// NOVO
		document.addEventListener("change", (e) => {
			if (!e.target.classList.contains("chk-offline")) return;
			soOffline = e.target.checked;
			try { localStorage.setItem("so-offline", soOffline ? "1" : "0"); } catch (e) {}
			arMusicas.pagina = 0;
			arAlbuns.pagina = 0;
			albumPag.pagina = 0;
			aplicarFiltroOffline();
			renderAlbunsArtista();
			renderAlbumTracks();
			applySearchFilter();
		});


	/* ==========================================================================
		05. TEMPLATES HTML
		========================================================================== */
	const tagHTML = (src) =>
		`<span class="tag ${src === "deezer" ? "d" : "s"}">${src === "deezer" ? "Deezer" : "Spotify"}</span>`;

	const typeTag = (k) =>
		k === "playlist"
			? '<span class="tag t-pl">Playlist</span>'
			: k === "album"
				? '<span class="tag t-alb">Álbum</span>'
				: '<span class="tag t-mp3">MP3</span>';

	const favCellHTML = (id) => {
		const on = id && offFavs.has(String(id));
		return `<td><button class="fav-btn ${on ? "on" : ""}" data-fav-id="${esc(id)}" title="${on ? "Remover das mais queridas" : "Adicionar às mais queridas"}"><svg class="i"><use href="#i-heart"/></svg></button></td>`;
	};

	function cardHTML({ title, sub, cover, type = "album", seed = 0, rel = "", coverTipo = "", coverId = "", temOffline = false }) {
		const bg = cover ? "" : `style="background:${grad(seed)}"`;
		const img = cover ? `<img src="${cover}" alt="">` : "";
		const attrs = rel ? ` data-rel="${esc(rel)}"` : "";
		const cAttrs =
			coverTipo && coverId ? ` data-cover-tipo="${esc(coverTipo)}" data-cover-id="${esc(coverId)}"` : "";
		const check = temOffline
			? `<svg class="i sm" style="color:#1db954;vertical-align:-3px;margin-right:4px" title="Você tem faixas deste item no disco"><use href="#i-check"/></svg>`
			: "";
		return `<div class="card ${type === "artist" ? "art" : ""}"${attrs} data-off="${temOffline ? "1" : "0"}">
			<div class="cv" ${bg}${cAttrs}>${img}<button class="play"><svg class="i f"><use href="#i-play"/></svg></button></div>
			<b>${check}${title}</b><small>${sub || ""}</small>
			</div>`;
	}

	function rowHTML({
		n,
		title,
		artist,
		album,
		src,
		dur,
		cover,
		seed = 0,
		dl = true,
		badge = null,
		id = "",
		preview = "",
		type = "track",
		showDur = true,
		linkArtist = false,
		artistId = "",
		albumId = "",
		nbTracks = 0,
	}) {
		const bg = cover ? `style="background:url('${cover}') center/cover"` : `style="background:${grad(seed)}"`;
		const who = linkArtist
			? `<span class="artist-link" data-artist-id="${artistId}">${artist}</span>`
			: artist;
		const alb = albumId ? `<span class="album-link" data-album-id="${albumId}">${album}</span>` : album;

		let off = false;
		if (type === "track" && id) {
			off = offIds.has(String(id));
		} else if (type === "album" && nbTracks > 0) {
			off = (offAlbumsFaixas.get(albumKey(artist, title)) || 0) > 0; // antes: >= nbTracks
		} else if (type === "playlist" && nbTracks > 0) {
			off = (offPlaylistsFaixas.get(norm(title)) || 0) > 0;          // antes: >= nbTracks
		}

		const acao = off
			? seloOffline
			: dl
				? '<button class="dl"><svg class="i sm"><use href="#i-download"/></svg>Baixar</button>'
				: "";
		const addPl = type === "track" && id
			? `<button class="ibtn pl-add" data-tip="Adicionar à playlist"><svg class="i sm"><use href="#i-plus"/></svg></button>`
			: "";
		return `<tr class="row" data-i="${n}" data-id="${id}" data-type="${type}" data-preview="${esc(preview)}" data-off="${off ? "1" : "0"}">
			${favCellHTML(id)}
			<td>${n}</td>
			<td><div class="t-cv"><div class="cv" ${bg}></div><div><b>${checkOff(off)}${title}</b><small>${who}</small></div></div></td>
			<td>${alb}</td>
			<td>${badge ?? tagHTML(src)}</td>
			${showDur ? `<td>${dur}</td>` : ""}
			<td><div class="acts">
				${addPl}
				${off ? "" : '<button class="ibtn" data-tip="Tocar"><svg class="i f"><use href="#i-play"/></svg></button>'}
				${acao}
			</div></td>
			</tr>`;
	}
	

// index.js — adicione dentro da IIFE, de preferência perto da seção 04 (Navegação)


		/* ==========================================================================
		EXPLORAR
		========================================================================== */
		const EX_POR_PAGINA = 20;   // itens por página dos grids do Deezer
		const EX_TUDO_POR_PAGINA = 12; // gêneros por página (paginado no cliente)

		const exState = {
			genero: '',
			carregando: false,
			generos: [],          // cache dos gêneros (para paginar "Explorar tudo")
			index: {
				hits: 0,
				albunsSemana: 0,
				lancamentos: 0,
				destaques: 0,
				tudo: 0,
			},
		};

		// Atualiza o estado visual do pager de uma seção.
		function exPagerAtualizar(secao, { pagina, temProxima }) {
			const info = document.getElementById(`ex-pager-${secao}-info`);
			const btns = document.querySelectorAll(`[data-pager="${secao}"]`);
			if (info) info.textContent = `${pagina + 1}`;
			btns.forEach((b) => {
				if (b.dataset.dir === '-1') b.disabled = pagina === 0;
				else b.disabled = !temProxima;
			});
		}

		// Renderiza um grid de cards de álbum a partir de uma lista do Deezer.
		function exRenderCards(gridEl, lista, idPrefix) {
			if (!gridEl) return;
			gridEl.innerHTML = (lista || [])
				.map((a, i) => {
					const albumId = a.id || (a.album && a.album.id) || '';
					const title = a.title || a.name || (a.album && a.album.title) || '';
					const artist = (a.artist && a.artist.name) || (a.user && a.user.name) || '';
					const cover = a.cover_medium || a.cover || a.picture_medium || (a.album && a.album.cover_medium) || '';
					const card = cardHTML({
						title: esc(title),
						sub: esc(artist),
						cover: esc(cover),
						type: 'album',
						seed: exState.index[idPrefix] + i + 1,
					});
					// injeta os atributos que o handler de clique usa
					if (!albumId) return card;
					return card.replace(
						'<div class="card ',
						`<div class="card" data-album-id="${esc(albumId)}" data-title="${esc(title)}" data-cover="${esc(cover)}" data-cover-tipo="album" data-cover-id="${esc(albumId)}" `
					);
				})
				.join('');
		}
		async function carregarExplorar() {
			if (exState.carregando) return;
			exState.carregando = true;

			const selectGenero = document.getElementById('ex-genero');
			const gridHits = document.getElementById('ex-hits');
			const gridAlbunsSemana = document.getElementById('ex-albuns-semana');
			const gridLancamentos = document.getElementById('ex-lancamentos');
			const gridDestaques = document.getElementById('ex-destaques');
			const gridTudo = document.getElementById('ex-tudo');

			// Placeholders de carregamento
			[gridHits, gridAlbunsSemana, gridLancamentos, gridDestaques, gridTudo].forEach((g) => {
				if (g) g.innerHTML = '<small style="color:var(--mut)">Carregando...</small>';
			});

			try {
				// 1) Gêneros (só carrega uma vez; serve para o select e para "Explorar tudo")
				if (!exState.generos.length && backend.exploreGenres) {
					const rg = await backend.exploreGenres();
					if (rg.ok && rg.data && rg.data.data) {
						exState.generos = rg.data.data;
						if (selectGenero && selectGenero.options.length <= 1) {
							exState.generos.forEach((g) => {
								const opt = document.createElement('option');
								opt.value = g.id;
								opt.textContent = g.name;
								selectGenero.appendChild(opt);
							});
						}
					}
				}

				// 2) Hits de hoje (chart global ou por gênero) — paginado
				if (backend.exploreChartTracks) {
					const idx = exState.index.hits;
					const r = await backend.exploreChartTracks({ genreId: exState.genero || 0, index: idx, limit: EX_POR_PAGINA });
					const lista = r.ok && r.data && r.data.data ? r.data.data : [];

					if (gridHits) {
						if (lista.length) {
							gridHits.innerHTML = lista
								.map((t, i) => {
									const albumId = (t.album && t.album.id) || '';
									const title = t.title || '';
									const artist = (t.artist && t.artist.name) || '';
									const cover = (t.album && (t.album.cover_medium || t.album.cover)) || '';
									const card = cardHTML({
										title: esc(title),
										sub: esc(artist),
										cover: esc(cover),
										type: 'album',
										seed: idx + i + 1,
									});
									if (!albumId) return card;
									return card.replace(
										'<div class="card ',
										`<div class="card" data-album-id="${esc(albumId)}" data-title="${esc((t.album && t.album.title) || title)}" data-cover="${esc(cover)}" data-cover-tipo="album" data-cover-id="${esc(albumId)}" `
									);
								})
								.join('');
						} else {
							gridHits.innerHTML = '<small style="color:var(--mut)">Nenhum hit disponível.</small>';
						}
					}

					exPagerAtualizar('hits', {
						pagina: Math.floor(idx / EX_POR_PAGINA),
						temProxima: lista.length >= EX_POR_PAGINA,
					});
				}

				// 3) Álbuns da semana (editorial selection) — paginado
				if (backend.exploreSelection) {
					const idx = exState.index.albunsSemana;
					const r = await backend.exploreSelection({ id: 0, index: idx, limit: EX_POR_PAGINA });
					const lista = r.ok && r.data && r.data.data ? r.data.data : [];
					exRenderCards(gridAlbunsSemana, lista, 'albunsSemana');
					if (!lista.length && gridAlbunsSemana) {
						gridAlbunsSemana.innerHTML = '<small style="color:var(--mut)">Nenhum álbum da semana.</small>';
					}
					exPagerAtualizar('albunsSemana', {
						pagina: Math.floor(idx / EX_POR_PAGINA),
						temProxima: lista.length >= EX_POR_PAGINA,
					});
				}

				// 4) Últimos lançamentos — paginado
				if (backend.exploreReleases) {
					const idx = exState.index.lancamentos;
					const r = await backend.exploreReleases({ id: 0, index: idx, limit: EX_POR_PAGINA });
					const lista = r.ok && r.data && r.data.data ? r.data.data : [];
					exRenderCards(gridLancamentos, lista, 'lancamentos');
					if (!lista.length && gridLancamentos) {
						gridLancamentos.innerHTML = '<small style="color:var(--mut)">Nenhum lançamento disponível.</small>';
					}
					exPagerAtualizar('lancamentos', {
						pagina: Math.floor(idx / EX_POR_PAGINA),
						temProxima: lista.length >= EX_POR_PAGINA,
					});
				}

				// 5) Destaques — paginado (chart global de álbuns)
				if (backend.exploreChartAlbums) {
					const idx = exState.index.destaques;
					const r = await backend.exploreChartAlbums({ index: idx, limit: EX_POR_PAGINA });
					const lista = r.ok && r.data && r.data.data ? r.data.data : [];
					exRenderCards(gridDestaques, lista, 'destaques');
					if (!lista.length && gridDestaques) {
						gridDestaques.innerHTML = '<small style="color:var(--mut)">Nenhum destaque.</small>';
					}
					exPagerAtualizar('destaques', {
						pagina: Math.floor(idx / EX_POR_PAGINA),
						temProxima: lista.length >= EX_POR_PAGINA,
					});
				}

				// 6) Explorar tudo (gêneros) — paginado no cliente
				if (gridTudo) {
					const total = exState.generos.length;
					if (total) {
						const inicio = exState.index.tudo;
						const pagina = exState.generos.slice(inicio, inicio + EX_TUDO_POR_PAGINA);
						gridTudo.innerHTML = pagina
							.map((g, i) =>
								cardHTML({
									title: esc(g.name),
									sub: '',
									cover: '',
									type: 'album',
									seed: inicio + i + 1,
								})
							)
							.join('');

						[...gridTudo.querySelectorAll('.card')].forEach((card, i) => {
							const g = pagina[i];
							if (!g) return;
							card.style.cursor = 'pointer';
							card.addEventListener('click', () => {
								if (selectGenero) selectGenero.value = g.id;
								exState.genero = String(g.id);
								exState.index.hits = 0; // Hits recomeça ao trocar gênero
								carregarExplorar();
							});
						});

						exPagerAtualizar('tudo', {
							pagina: Math.floor(inicio / EX_TUDO_POR_PAGINA),
							temProxima: inicio + EX_TUDO_POR_PAGINA < total,
						});
					} else {
						gridTudo.innerHTML = '<small style="color:var(--mut)">Nenhum gênero disponível.</small>';
						exPagerAtualizar('tudo', { pagina: 0, temProxima: false });
					}
				}

				marcarTocando();
			} finally {
				exState.carregando = false;
			}
		}

		// Listener do seletor de gênero (reseta o índice do Hits)
		document.getElementById('ex-genero')?.addEventListener('change', (e) => {
			exState.genero = e.target.value;
			exState.index.hits = 0;
			carregarExplorar();
		});

		// Listener do botão atualizar (reseta todos os índices)
		document.getElementById('ex-refresh')?.addEventListener('click', () => {
			exState.index = { hits: 0, albunsSemana: 0, lancamentos: 0, destaques: 0, tudo: 0 };
			carregarExplorar();
		});

		// Listeners dos pagers (um único delegate no documento, escopo #v-explore)
		document.addEventListener('click', (e) => {
			const btn = e.target.closest('#v-explore [data-pager]');
			if (!btn) return;
			const secao = btn.dataset.pager;
			const dir = Number(btn.dataset.dir) || 0;
			if (!secao || !dir) return;

			const passo = secao === 'tudo' ? EX_TUDO_POR_PAGINA : EX_POR_PAGINA;
			const atual = exState.index[secao] || 0;
			const proximo = atual + dir * passo;
			if (proximo < 0) return;
			exState.index[secao] = proximo;
			carregarExplorar();
		});

		// Abre o álbum ao clicar num card do Explorar
		document.addEventListener('click', (e) => {
			const card = e.target.closest('#v-explore .card[data-album-id]');
			if (!card) return;
			if (e.target.closest('.play')) return;
			openAlbumData({
				id: card.dataset.albumId,
				title: card.dataset.title || '',
				artist: card.querySelector('small')?.textContent || '',
				cover: card.dataset.cover || '',
				origem: 'explore',
				origemView: 'explore',
			});
		});









		
		// Dispara ao entrar na view (hook no showView)
		// No seu showView(name), adicione:
		// if (name === 'explore') carregarExplorar();

	/* ==========================================================================
		06. BIBLIOTECA (menu lateral)
		========================================================================== */
	const contar = (n) => `${n} faixa${n === 1 ? "" : "s"}`;

	const linhaVazia = (texto, colunas) =>
		`<tr><td colspan="${colunas}" style="color: var(--mut); padding: 18px 0">${esc(texto)}</td></tr>`;

	async function carregarBiblioteca() {
		if (!backend.biblioteca) return;

		let lib = null;
		try {
			lib = await backend.biblioteca();
		} catch (e) {
			lib = null;
		}
		if (!lib) return;
		coverCache.clear();
		await atualizarOffline(lib);

		const artistas = lib.artists || [];
		const albuns = lib.albums || [];

		put(
			"g-lib-artists",
			artistas.length
				? artistas
						.map((a, i) =>
							cardHTML({
								title: esc(a.name),
								sub: contar(a.faixas),
								type: "artist",
								seed: i + 1,
								coverTipo: "artist",
								coverId: a.artistId,
								temOffline: (a.faixas || 0) > 0,
							})
						)
						.join("")
				: '<small style="color: var(--mut)">Nenhum artista na pasta ainda</small>'
		);

		put(
			"g-lib-albums",
			albuns.length
				? albuns
						.map((a, i) =>
							cardHTML({
								title: esc(a.title),
								sub: `${esc(a.artist)} • ${contar(a.faixas)}`,
								type: "album",
								seed: i + 1,
								rel: a.rel,
								coverTipo: "album",
								coverId: a.albumId,
								temOffline: (a.faixas || 0) > 0,
							})
						)
						.join("")
				: '<small style="color: var(--mut)">Nenhum álbum na pasta ainda</small>'
		);

		let plsMeta = [];
		try {
			plsMeta = backend.playlistsMeta ? await backend.playlistsMeta() : [];
		} catch (e) {
			plsMeta = [];
		}
		playlistsState.todas = plsMeta.length ? plsMeta : (lib.playlists || []);
		renderPlaylistsTable();

		[
			...document.querySelectorAll(
				"#g-lib-artists .cv[data-cover-tipo], #g-lib-albums .cv[data-cover-tipo]"
			),
		].forEach((el) => aplicarCapa(el));

		renderFavs();
		aplicarFiltroOffline();
		marcarTocando();
	}

	/* ==========================================================================
		06b. TABELA DE PLAYLISTS
		========================================================================== */
	const playlistsState = {
		todas: [],
		filtro: "",
		sortCol: -1,
		sortDir: "asc",
	};

	const confirmModal = document.getElementById("m-confirm");
	const confirmTitulo = document.getElementById("m-confirm-titulo");
	const confirmMsg = document.getElementById("m-confirm-msg");
	const confirmOk = document.getElementById("m-confirm-ok");
	const confirmCancel = document.getElementById("m-confirm-cancel");

	function pedirConfirmacao({ titulo = "Confirmar", msg = "", textoOk = "Confirmar" } = {}) {
		return new Promise((resolve) => {
			if (confirmTitulo) confirmTitulo.textContent = titulo;
			if (confirmMsg) confirmMsg.textContent = msg;
			if (confirmOk) confirmOk.textContent = textoOk;
			confirmModal?.classList.add("on");

			const onOk = () => { limpar(); resolve(true); };
			const onCancel = () => { limpar(); resolve(false); };
			const onFora = (e) => { if (e.target === confirmModal) { limpar(); resolve(false); } };
			const onKey = (e) => {
				if (e.key === "Escape") { e.preventDefault(); limpar(); resolve(false); }
				else if (e.key === "Enter") { e.preventDefault(); limpar(); resolve(true); }
			};
			const limpar = () => {
				confirmModal?.classList.remove("on");
				confirmOk?.removeEventListener("click", onOk);
				confirmCancel?.removeEventListener("click", onCancel);
				confirmModal?.removeEventListener("click", onFora);
				document.removeEventListener("keydown", onKey);
			};

			confirmOk?.addEventListener("click", onOk);
			confirmCancel?.addEventListener("click", onCancel);
			confirmModal?.addEventListener("click", onFora);
			document.addEventListener("keydown", onKey);
		});
	}

	const renderPlaylistsTable = () => {
		const body = document.getElementById("t-playlists-body");
		const contagem = document.getElementById("pl-contagem");
		if (!body) return;

		const f = norm(playlistsState.filtro);
		let lista = f
			? playlistsState.todas.filter((p) => norm(p.title).includes(f))
			: playlistsState.todas.slice();

		if (playlistsState.sortCol >= 0) {
			const dir = playlistsState.sortDir === "asc" ? 1 : -1;
			const col = playlistsState.sortCol;
			lista.sort((a, b) => {
				if (col === 0) return a.title.toLowerCase().localeCompare(b.title.toLowerCase(), "pt-BR") * dir;
				if (col === 1) return ((a.faixas || 0) - (b.faixas || 0)) * dir;
				if (col === 2) return String(a.criada || "").localeCompare(String(b.criada || "")) * dir;
				if (col === 3) return String(a.ultima || "").localeCompare(String(b.ultima || "")) * dir;
				return 0;
			});
		}

		if (contagem) {
			contagem.textContent = `${lista.length} playlist${lista.length === 1 ? "" : "s"}`;
		}

		if (!lista.length) {
			body.innerHTML = `<tr><td colspan="5" style="color:var(--mut);padding:18px 0">${playlistsState.todas.length ? "Nada casou com o filtro." : "Nenhuma playlist ainda. Clique em + Nova playlist."}</td></tr>`;
			return;
		}

		body.innerHTML = lista
			.map(
				(p) => `<tr class="row" data-rel="${esc(p.rel || "")}" data-title="${esc(p.title)}">
					<td><span class="playlist-link" data-rel="${esc(p.rel || "")}" data-title="${esc(p.title)}">${esc(p.title)}</span></td>
					<td class="col-num">${p.faixas || 0}</td>
					<td class="col-date">${fmtDataHora(p.criada)}</td>
					<td class="col-date">${fmtDataHora(p.ultima)}</td>
					<td><button class="ibtn" data-tip="Excluir playlist" data-del-pl="${esc(p.title)}"><svg class="i sm"><use href="#i-x"/></svg></button></td>
				</tr>`
			)
			.join("");
	};

	document.getElementById("pl-filtro")?.addEventListener("input", (e) => {
		playlistsState.filtro = e.target.value;
		renderPlaylistsTable();
	});

	document.querySelectorAll("#t-playlists th[data-sort]").forEach((th, col) => {
		th.addEventListener("click", () => {
			const dir = th.dataset.dir === "asc" ? "desc" : "asc";
			document.querySelectorAll("#t-playlists th").forEach((x) => delete x.dataset.dir);
			th.dataset.dir = dir;
			playlistsState.sortCol = col;
			playlistsState.sortDir = dir;
			renderPlaylistsTable();
		});
	});

	document.getElementById("t-playlists-body")?.addEventListener("click", async (e) => {
		const link = e.target.closest(".playlist-link");
		if (link && link.dataset.rel) {
			abrirLocal(link.dataset.rel, link.dataset.title, "playlists");
			return;
		}
		const del = e.target.closest("[data-del-pl]");
		if (del) {
			const titulo = del.dataset.delPl;
			if (!titulo) return;
			const ok = await pedirConfirmacao({
				titulo: "Excluir playlist",
				msg: `Excluir a playlist "${titulo}"?\n\nAs músicas continuam na biblioteca; só a lista é apagada.`,
				textoOk: "Excluir",
			});
			if (!ok) return;
			backend.playlistsDelete?.(titulo)
				.then(async (r) => {
					if (r && r.ok) {
						await carregarBiblioteca();
						mostrarToast(`Playlist "${titulo}" excluída`);
					} else {
						alert((r && r.error) || "falha ao excluir");
					}
				})
				.catch((err) => alert(err.message || "erro ao excluir"));
		}
	});

	/* ==========================================================================
		06c. FAIXAS LOCAIS (view #v-local)
		========================================================================== */
	async function enriquecerFaixas(faixas) {
		const comId = faixas.filter((f) => f.id && !f.albumId && !f.artistId);
		if (!comId.length) return faixas;

		let falhas = 0;
		let espera = 0;
		const PARALELO = 6;

		for (let i = 0; i < comId.length; i += PARALELO) {
			if (falhas >= 3) break;

			const lote = comId.slice(i, i + PARALELO);
			const resultados = await Promise.allSettled(
				lote.map((f) =>
					backend.trackInfo(f.id).catch((e) => ({ ok: false, error: e.message }))
				)
			);

			resultados.forEach((r, j) => {
				const f = lote[j];
				if (r.status === "fulfilled" && r.value && r.value.ok && r.value.data) {
					const d = r.value.data;
					f.artistId = (d.artist && d.artist.id) || 0;
					f.artistName = (d.artist && d.artist.name) || "";
					f.albumId = (d.album && d.album.id) || 0;
					f.albumTitle = (d.album && d.album.title) || "";
					falhas = 0;
					espera = 0;
				} else {
					falhas++;
				}
			});

			if (falhas >= 3) {
				espera = Math.min(4000, 1000 * Math.pow(2, falhas - 3));
				await new Promise((r) => setTimeout(r, espera));
			}
		}

		return faixas;
	}

	function linhaLocalHTML(f) {
		const sep = f.nome.indexOf(" - ");
		const artistaNome = f.artistName || (sep > 0 ? f.nome.slice(0, sep) : "");
		const titulo = sep > 0 ? f.nome.slice(sep + 3) : f.nome;
		const who = f.artistId
			? `<span class="artist-link" data-artist-id="${esc(f.artistId)}">${esc(artistaNome)}</span>`
			: esc(artistaNome);
		const cAttrs = f.albumId
			? ` data-cover-tipo="album" data-cover-id="${esc(f.albumId)}"`
			: "";
		const albumTxt = f.albumTitle ? esc(f.albumTitle) : "";
		const addPl = f.id
			? `<button class="ibtn pl-add" data-tip="Adicionar à playlist"><svg class="i sm"><use href="#i-plus"/></svg></button>`
			: "";
		return `<tr class="row" data-i="${f.n}" data-id="${esc(f.id || "")}" data-preview="${esc(f.url)}" data-offline="1">
			${favCellHTML(f.id)}
			<td>${f.n}</td>
			<td><div class="t-cv"><div class="cv" style="background:${grad(f.n + 1)}"${cAttrs}></div><div><b>${esc(titulo)}</b><small>${who}${albumTxt ? " · " + albumTxt : ""}</small></div></div></td>
			<td>${f.dur > 0 ? fmtT(f.dur) : "--:--"}</td>
			<td><div class="acts">${addPl}${f.url ? '<button class="ibtn" data-tip="Tocar"><svg class="i f"><use href="#i-play"/></svg></button>' : ""}</div></td>
			</tr>`;
	}

	let localFila = [];

	async function abrirLocal(rel, titulo, origem) {
		const tbl = document.getElementById("lc-rows");
		const back = document.getElementById("lc-back");

		document.getElementById("lc-title").textContent = titulo;
		document.getElementById("lc-artist").textContent = "";
		document.getElementById("lc-info").textContent = "Carregando...";

		const coverEl = document.getElementById("lc-cover");
		coverEl.style.background = "";
		coverEl.style.backgroundImage = "";

		back.dataset.view = origem;
		tbl.innerHTML = "";
		showView("local");
		const nav = document.querySelector(`.nav a[data-view="${origem}"]`);
		if (nav) nav.classList.add("on");

		const btnPlay = document.getElementById("lc-play");
		if (btnPlay) {
			btnPlay.disabled = true;
			btnPlay.onclick = () => {
				if (!localFila.length) return;
				tocarFila(localFila, 0);
			};
		}
		localFila = [];

		let faixas = [];
		try {
			faixas = await backend.faixas(rel);
		} catch (e) {
			faixas = [];
		}

		const normRel = String(rel || "").replace(/\\/g, "/");
		const partes = normRel.split("/");
		const pasta = partes.length >= 2 ? partes[partes.length - 2] : "";
		const ehAlbum = /^Albuns$/i.test(partes[0] || "");
		const ehPlaylist = /^Playlists$/i.test(partes[0] || "");

		if (!faixas.length) {
			document.getElementById("lc-info").textContent = ehPlaylist ? "0 faixas" : "";
			tbl.innerHTML = ehPlaylist
				? linhaVazia("Playlist vazia. Adicione faixas pelo botão [+] no player.", 5)
				: linhaVazia("Não foi possível ler as faixas deste arquivo", 5);
			return;
		}

		const primeiraComAlbum = faixas.find((f) => f.albumId);

		if (primeiraComAlbum) {
			capaLocal("album", primeiraComAlbum.albumId).then((url) => {
				if (url) coverEl.style.background = `url("${url}") center/cover`;
			});
		}

		const artista = ehAlbum ? pasta : "";
		document.getElementById("lc-artist").textContent = artista || "";

		const faixasN = faixas.length;
		const partesInfo = [`${faixasN} faixa${faixasN === 1 ? "" : "s"}`];

		const albumId = primeiraComAlbum ? String(primeiraComAlbum.albumId) : "";
		if (albumId && backend.albumInfo) {
			backend.albumInfo(albumId).then((r) => {
				if (r && r.ok && r.data && r.data.release_date) {
					partesInfo.push(formatarData(r.data.release_date));
					document.getElementById("lc-info").textContent = partesInfo.join("  ·  ");
				}
			}).catch(() => {});
		}
		document.getElementById("lc-info").textContent = partesInfo.join("  ·  ");

		tbl.innerHTML = faixas.map((f) => linhaLocalHTML(f)).join("");
		await enriquecerFaixas(faixas);
		tbl.innerHTML = faixas.map((f) => linhaLocalHTML(f)).join("");
		[...tbl.querySelectorAll(".t-cv .cv[data-cover-tipo]")].forEach((el) => aplicarCapa(el));

		localFila = faixas
			.filter((f) => f.id && f.url)
			.map((f) => {
				const sep = f.nome.indexOf(" - ");
				const tituloF = sep > 0 ? f.nome.slice(sep + 3) : f.nome;
				const artistaF = f.artistName || (sep > 0 ? f.nome.slice(0, sep) : "");
				return {
					id: String(f.id),
					preview: f.url,
					title: tituloF,
					artist: artistaF,
					cover: "",
				};
			})
			.filter((x) => x.preview);

		if (btnPlay) btnPlay.disabled = !localFila.length;
		marcarTocando();
	}

	[
		["g-lib-albums", "albums"],
	].forEach(([id, origem]) => {
		const el = document.getElementById(id);
		if (!el) return;
		el.addEventListener("click", (e) => {
			const card = e.target.closest(".card");
			if (!card || !card.dataset.rel) return;
			abrirLocal(card.dataset.rel, card.querySelector("b").textContent, origem);
		});
	});

	const gArtists = document.getElementById("g-lib-artists");
	if (gArtists) {
		gArtists.addEventListener("click", (e) => {
			const card = e.target.closest(".card");
			if (!card) return;
			const cv = card.querySelector(".cv[data-cover-id]");
			const artistId = cv ? cv.dataset.coverId : "";
			openArtist({
				textContent: card.querySelector("b").textContent,
				dataset: { artistId, origemView: "artists" }, // <-- aqui
				origem: "artists",
				closest: () => null,
			});
		});
	}

	document
		.querySelectorAll('.nav a[data-view="artists"], .nav a[data-view="albums"], .nav a[data-view="playlists"]')
		.forEach((a) => a.addEventListener("click", () => carregarBiblioteca()));

	document.querySelectorAll("[data-refresh]").forEach((b) =>
		b.addEventListener("click", () => carregarBiblioteca())
	);

	/* ==========================================================================
		07. PLAYER (fila de execução)
		========================================================================== */
	const seek = document.getElementById("seek");
	const vol = document.getElementById("vol");
	const mpVol = document.getElementById("mp-vol");
	const mpSeek = document.getElementById("mp-seek");
	const mpTempo = document.getElementById("mp-tempo");
	const uPlay = document.getElementById("u-play");
	const uVol = document.getElementById("u-vol");
	const mpUVol = document.getElementById("mp-u-vol");
	const tCur = document.getElementById("t-cur");
	const tDur = document.getElementById("t-dur");

	const audio = new Audio();
	audio.volume = vol.value / 100;
	seek.max = 1000;
	if (mpSeek) mpSeek.max = 1000;
	fill(seek);
	fill(vol);
	if (mpVol) {
		mpVol.value = vol.value;
		fill(mpVol);
	}

	let curRow = null;
	let seeking = false;
	let mpSeeking = false;

	let fila = [];
	let filaFixa = [];
	let filaIdx = -1;

	let tocandoAgora = { id: "", preview: "" };

	const safePlay = () => {
		const p = audio.play();
		if (p) p.catch(() => {});
	};

	const montarItem = (row) => {
		if (!row) return null;
		const b = row.querySelector(".t-cv b");
		const small = row.querySelector(".t-cv small");
		const cv = row.querySelector(".t-cv .cv");
		let cover = "";
		if (cv && cv.style.backgroundImage) {
			const m = cv.style.backgroundImage.match(/url\("?(.*?)"?\)/);
			if (m) cover = m[1];
		}
		return {
			id: row.dataset.id || "",
			preview: row.dataset.preview || "",
			title: b ? b.textContent : "",
			artist: small ? small.textContent : "",
			cover,
			rowRef: row,
		};
	};

	function marcarTocando() {
		document.querySelectorAll("tr.row").forEach((tr) => {
			const bateId = tocandoAgora.id && tr.dataset.id === tocandoAgora.id;
			const batePrev = !tocandoAgora.id && tocandoAgora.preview && tr.dataset.preview === tocandoAgora.preview;
			const bate = bateId || batePrev;
			tr.classList.toggle("playing", !!bate);
			const b = tr.querySelector(".acts .ibtn");
			if (b) b.classList.toggle("on", !!bate);
		});
	}

	const tocarItem = (item) => {
		if (!item || !item.preview) return;
		audio.src = item.preview;
		safePlay();
		document.getElementById("np-title").textContent = item.title || "—";
		document.getElementById("np-artist").textContent = item.artist || "";
		const coverEl = document.getElementById("np-cover");
		coverEl.style.background = item.cover ? `url("${item.cover}") center/cover` : grad(1);
		const bAdd = document.getElementById("b-add-pl");
		if (bAdd) bAdd.disabled = !item.id;
		curRow = item.rowRef || null;
		tocandoAgora = { id: item.id || "", preview: item.preview || "" };
		marcarTocando();
		miniSync();
		if (item.id) {
			const fid = String(item.id);
			for (const [nome, ids] of offPlaylistsIds) {
				if (ids.has(fid)) backend.playlistsTocar?.(nome).catch(() => {});
			}
		}
	};

	const tocarFila = (itens, idxInicial = 0) => {
		const validos = (itens || []).filter((x) => x && x.preview);
		if (!validos.length) return;

		fila = validos;
		filaFixa = validos.slice();
		filaIdx = Math.max(0, Math.min(idxInicial, validos.length - 1));
		tocarItem(fila[filaIdx]);
	};

	const remontarFilaDaTabela = (row) => {
		if (!row) return;
		const tbody = row.closest("tbody");
		if (!tbody) return;
		const rows = [...tbody.querySelectorAll("tr.row")].filter((r) => r.dataset.preview);
		const idx = rows.indexOf(row);
		tocarFila(rows.map(montarItem), idx);
	};

	function playRow(row) {
		if (!row || !row.dataset.preview) return;

		const idNaFila = row.dataset.id
			? fila.findIndex((x) => x.id === String(row.dataset.id) && x.rowRef === row)
			: -1;
		const previewNaFila = fila.findIndex((x) => x.rowRef === row);
		const idx = idNaFila >= 0 ? idNaFila : previewNaFila;

		if (idx >= 0) {
			filaIdx = idx;
			tocarItem(fila[filaIdx]);
			return;
		}

		remontarFilaDaTabela(row);
	}

	const shuffleFila = () => {
		if (!fila.length) return;
		const atual = fila[filaIdx];
		const resto = fila.filter((_, i) => i !== filaIdx);
		for (let i = resto.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[resto[i], resto[j]] = [resto[j], resto[i]];
		}
		fila = [atual, ...resto].filter(Boolean);
		filaIdx = 0;
	};

	const desfazerShuffle = () => {
		if (!filaFixa.length) return;
		const atual = fila[filaIdx];
		const idx = filaFixa.findIndex(
			(x) => x.id === atual?.id && x.preview === atual?.preview
		);
		fila = filaFixa.slice();
		filaIdx = idx >= 0 ? idx : 0;
	};

	function step(dir) {
		if (!fila.length) return;
		filaIdx = (filaIdx + dir + fila.length) % fila.length;
		tocarItem(fila[filaIdx]);
	}

	const bShuffle = document.getElementById("b-shuffle");
	const bRepeat = document.getElementById("b-repeat");
	const bPlay = document.getElementById("b-play");

	bShuffle.addEventListener("click", () => {
		const on = bShuffle.classList.toggle("on");
		if (on) shuffleFila();
		else desfazerShuffle();
	});

	bRepeat.addEventListener("click", () => {
		const on = bRepeat.classList.toggle("on");
		audio.loop = on;
	});

	bPlay.addEventListener("click", () => {
		if (!fila.length) {
			const tbody =
				document.querySelector(".view.on table.tracks tbody") ||
				document.getElementById("t-results");
			if (!tbody) return;
			const rows = [...tbody.querySelectorAll("tr.row")].filter((r) => r.dataset.preview);
			if (!rows.length) return;
			tocarFila(rows.map(montarItem), 0);
			return;
		}
		if (!audio.src) {
			tocarItem(fila[Math.max(0, filaIdx)]);
			return;
		}
		audio.paused ? safePlay() : audio.pause();
	});
	document.getElementById("b-prev").addEventListener("click", () => step(-1));
	document.getElementById("b-next").addEventListener("click", () => step(1));

	audio.addEventListener("play", () => {
		uPlay.setAttribute("href", "#i-pause");
		const mp = document.getElementById("mp-u-play");
		if (mp) mp.setAttribute("href", "#i-pause");
	});
	audio.addEventListener("pause", () => {
		uPlay.setAttribute("href", "#i-play");
		const mp = document.getElementById("mp-u-play");
		if (mp) mp.setAttribute("href", "#i-play");
	});
	audio.addEventListener("ended", () => step(1));
	audio.addEventListener("loadedmetadata", () => {
		tDur.textContent = fmtT(audio.duration);
		if (mpTempo) mpTempo.textContent = `${fmtT(audio.currentTime)} / ${fmtT(audio.duration)}`;
	});
	audio.addEventListener("timeupdate", () => {
		if (!seeking) {
			tCur.textContent = fmtT(audio.currentTime);
			if (audio.duration) {
				seek.value = (audio.currentTime / audio.duration) * 1000;
				fill(seek);
			}
		}
		if (!mpSeeking && audio.duration) {
			mpSeek.value = (audio.currentTime / audio.duration) * 1000;
			fill(mpSeek);
		}
		if (mpTempo) mpTempo.textContent = `${fmtT(audio.currentTime)} / ${fmtT(audio.duration)}`;
	});
	audio.addEventListener("error", () => {
		document.getElementById("np-artist").textContent = "Preview indisponível (buscando…)";
		if (fila.length > 1) step(1);
	});

	seek.addEventListener("input", () => {
		fill(seek);
		seeking = true;
		if (audio.duration) tCur.textContent = fmtT((seek.value / 1000) * audio.duration);
	});
	seek.addEventListener("change", () => {
		if (audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration;
		seeking = false;
	});

	if (mpSeek) {
		mpSeek.addEventListener("input", () => {
			fill(mpSeek);
			mpSeeking = true;
			if (audio.duration && mpTempo) {
				mpTempo.textContent = `${fmtT((mpSeek.value / 1000) * audio.duration)} / ${fmtT(audio.duration)}`;
			}
		});
		mpSeek.addEventListener("change", () => {
			if (audio.duration) audio.currentTime = (mpSeek.value / 1000) * audio.duration;
			mpSeeking = false;
		});
	}

	const syncVolIcon = () => {
		const muted = audio.muted || audio.volume === 0;
		const href = muted ? "#i-mute" : "#i-vol";
		uVol.setAttribute("href", href);
		if (mpUVol) mpUVol.setAttribute("href", href);
	};

	vol.addEventListener("input", () => {
		fill(vol);
		audio.volume = vol.value / 100;
		audio.muted = false;
		if (mpVol) {
			mpVol.value = vol.value;
			fill(mpVol);
		}
		syncVolIcon();
	});

	if (mpVol) {
		mpVol.addEventListener("input", () => {
			fill(mpVol);
			audio.volume = mpVol.value / 100;
			audio.muted = false;
			vol.value = mpVol.value;
			fill(vol);
			syncVolIcon();
		});
	}

	document.getElementById("b-mute").addEventListener("click", () => {
		audio.muted = !audio.muted;
		syncVolIcon();
	});

	document.getElementById("mp-mute")?.addEventListener("click", () => {
		audio.muted = !audio.muted;
		syncVolIcon();
	});

	["t-results", "t-artist-top", "t-album", "lc-rows", "t-favs"].forEach((id) => {
		const el = document.getElementById(id);
		if (!el) return;
		el.addEventListener("click", (e) => {
			if (e.target.closest(".dl") || e.target.closest(".artist-link") || e.target.closest(".album-link")) return;
			if (e.target.closest(".fav-btn")) return;
			if (e.target.closest(".pl-add")) return;
			const row = e.target.closest("tr.row");
			if (!row || !row.dataset.preview) return;
			if (row === curRow && audio.src) audio.paused ? safePlay() : audio.pause();
			else playRow(row);
		});
	});

	/* ==========================================================================
		08. BUSCA
		========================================================================== */
	const q = document.getElementById("q");
	let searchTimer;
	let searchAbort = null;

	q.addEventListener("input", () => {
		clearTimeout(searchTimer);
		if (searchAbort) searchAbort.abort();
		searchTimer = setTimeout(doSearch, 400);
	});

	function applySearchFilter() {
		const sel = document.querySelector('input[name="s-type"]:checked').value;
		let n = 0;
		document.querySelectorAll("#t-results tr.row").forEach((r) => {
			const tipoOk = sel === "all" || (r.dataset.type || "track") === sel;
			const offOk = !soOffline || r.dataset.off === "1";
			const show = tipoOk && offOk;
			r.style.display = show ? "" : "none";
			if (show) r.cells[1].textContent = ++n;
		});
	}

	document.getElementById("s-filter").addEventListener("change", applySearchFilter);

	async function doSearch() {
		const term = q.value.trim();
		if (!term) return showView("favs");
		showView("search");

		if (searchAbort) searchAbort.abort();
		searchAbort = new AbortController();
		const signal = searchAbort.signal;

		const body = document.getElementById("t-results");
		const msg = (txt, color = "var(--mut)") => {
			body.innerHTML = `<tr><td colspan="6" style="color:${color};padding:20px">${txt}</td></tr>`;
		};

		document.querySelectorAll("#v-search th").forEach((x) => delete x.dataset.dir);
		msg("Buscando...");

		await atualizarOffline();
		if (signal.aborted) return;

		const offlineRes = { ok: false, error: "offline" };
		const [rt, ra, rp] = await Promise.all([
			backend.search("track", term),
			backend.searchAlbums ? backend.searchAlbums(term) : offlineRes,
			backend.searchPlaylists ? backend.searchPlaylists(term) : offlineRes,
		]);
		if (signal.aborted) return;
		if (q.value.trim() !== term) return;

		if (!rt.ok && !ra.ok && !rp.ok) {
			const semInternet = /fetch|network|timeout|indispon|ECONNREFUSED/i.test(rt.error || "");
			return msg(
				semInternet
					? "Sem conexão com o Deezer. Você pode ouvir o que já baixou pelo menu lateral."
					: `Não foi possível buscar (${esc(rt.error)})`,
				"var(--mut)"
			);
		}
		const tracks = rt.ok ? rt.data : [];
		const albums = ra.ok ? ra.data : [];
		const lists = rp.ok ? rp.data : [];
		if (!tracks.length && !albums.length && !lists.length) return msg("Nenhum resultado.");

		const rowsTracks = tracks.map((t, i) =>
			rowHTML({
				n: i + 1,
				id: t.id,
				title: esc(t.title),
				artist: esc(t.artist),
				linkArtist: true,
				album: esc(t.album),
				albumId: t.album_id,
				cover: esc(t.img_url),
				preview: esc(t.preview_url),
				showDur: false,
				badge: typeTag("mp3"),
				seed: i + 2,
			})
		);

		const rowsAlbums = albums.map((a, i) =>
			rowHTML({
				n: tracks.length + i + 1,
				id: a.id,
				type: "album",
				title: esc(a.title),
				artist: esc((a.artist && a.artist.name) || ""),
				linkArtist: true,
				artistId: (a.artist && a.artist.id) || "",
				album: `${a.nb_tracks} faixas`,
				nbTracks: a.nb_tracks || 0,
				cover: esc(a.cover_small),
				showDur: false,
				badge: typeTag("album"),
				seed: tracks.length + i + 2,
			})
		);

		const rowsLists = lists.map((p, i) =>
			rowHTML({
				n: tracks.length + albums.length + i + 1,
				id: p.id,
				type: "playlist",
				title: esc(p.title),
				artist: esc((p.user && p.user.name) || ""),
				album: `${p.nb_tracks} faixas`,
				nbTracks: p.nb_tracks || 0,
				cover: esc(p.picture_small),
				showDur: false,
				badge: typeTag("playlist"),
				seed: tracks.length + albums.length + i + 2,
			})
		);

		body.innerHTML = rowsTracks.concat(rowsAlbums, rowsLists).join("");
		applySearchFilter();
		marcarTocando();
		aplicarFiltroOffline();
	}

	/* ==========================================================================
		09. ORDENAÇÃO DAS TABELAS
		========================================================================== */
	const parseDur = (t) => {
		const m = /^(\d+):(\d+)$/.exec(t.trim());
		return m ? +m[1] * 60 + +m[2] : null;
	};

	function sortKey(row, col, type) {
		if (type === "idx") return +row.dataset.i;
		const td = row.cells[col];
		if (type === "dur") return parseDur(td.textContent);
		return (td.querySelector("b")?.textContent ?? td.textContent).trim().toLowerCase();
	}

	function sortTable(table, col, type, dir) {
		const body = table.tBodies[0];
		const k = dir === "asc" ? 1 : -1;
		const rows = [...body.rows].filter((r) => r.cells.length > 1);
		rows.sort((a, b) => {
			const x = sortKey(a, col, type),
				y = sortKey(b, col, type);
			if (x === null && y === null) return 0;
			if (x === null) return 1;
			if (y === null) return -1;
			return (typeof x === "number" ? x - y : x.localeCompare(y, "pt-BR", { numeric: true })) * k;
		});
		rows.forEach((r, i) => {
			r.cells[1].textContent = i + 1;
			body.appendChild(r);
		});
		if (body.id === "t-results") applySearchFilter();
	}

	document.querySelectorAll("table.tracks").forEach((table) => {
		const ths = [...table.tHead.rows[0].cells];
		ths.forEach((th, col) => {
			if (!th.dataset.sort) return;
			th.addEventListener("click", () => {
				const dir = th.dataset.dir === "asc" ? "desc" : "asc";
				ths.forEach((x) => delete x.dataset.dir);
				th.dataset.dir = dir;
				sortTable(table, col, th.dataset.sort, dir);
			});
		});
	});

	/* ==========================================================================
		10. DOWNLOADS
		========================================================================== */
	const stateMap = (s) =>
		s === "active" ? "run" : s === "mission accomplished" ? "done" : s === "failed" ? "err" : "queue";

	let dlMeta = {};
	try {
		dlMeta = JSON.parse(localStorage.getItem("dlMeta") || "{}");
	} catch (e) {}
	const saveMeta = () => {
		try {
			localStorage.setItem("dlMeta", JSON.stringify(dlMeta));
		} catch (e) {}
	};

	const dlHidden = new Set();
	let pollTimer = null;
	let lastTasks = [];

	function dlHTML({ id, title, sub, status, pct, info, cover, seed = 0, metaId = "", metaType = "" }) {
		const bg = cover ? `url('${cover}') center/cover` : grad(seed);
		const podeRefazer = status === "err" && metaId && (metaType === "track" || metaType === "album" || metaType === "playlist");
		const btnRemover =
			status === "done" || status === "err"
				? `<button class="ibtn" data-tip="Remover" data-action="remove"><svg class="i sm"><use href="#i-x"/></svg></button>`
				: "<span></span>";
		const btnRefazer = podeRefazer
			? `<button class="ibtn" data-tip="Tentar novamente" data-action="retry"><svg class="i sm"><use href="#i-repeat"/></svg></button>`
			: "";
		return `<div class="dl-item ${status}" data-id="${esc(id)}" data-meta-id="${esc(metaId)}" data-meta-type="${esc(metaType)}">
			<div class="cv" style="background:${bg}"></div>
			<div><b>${esc(title)}</b><small>${esc(sub)}</small></div>
			<div class="dl-prog"><div class="bar"><i style="width:${pct}%"></i></div><small class="dl-info">${esc(info)}</small></div>
			<span class="dl-pct">${pct}%</span>
			${btnRefazer || btnRemover}
			${btnRefazer ? btnRemover : "<span></span>"}
			</div>`;
	}

	function renderQueue(tasks) {
		const list = document.getElementById("dl-list");
		const items = tasks.filter((t) => !dlHidden.has(String(t.id))).reverse();
		if (!items.length) {
			list.innerHTML = '<p style="color:var(--mut)">Nenhum download.</p>';
			return;
		}

		list.innerHTML = items
			.map((t, i) => {
				const status = stateMap(t.state);
				const meta = dlMeta[String(t.id)];
				const [cur, max] = t.progress || [0, 0];
				const pct = status === "done" ? 100 : max > 0 ? Math.min(100, Math.round((cur / max) * 100)) : 0;
				const files = (dec(t.result).match(/'([^']+)'/g) || []).map((x) =>
					x.slice(1, -1).split("/").pop()
				);

				const info =
					status === "done"
						? files.length > 1
							? `${files.length} arquivos`
							: files[0] || "Concluído"
						: status === "err"
							? dec(t.exception).replace(/^ERROR:\s*/, "")
							: status === "run"
								? max > 0
									? `${cur}/${max}`
									: "Baixando..."
								: "Na fila";

				return dlHTML({
					id: t.id,
					status,
					pct,
					info,
					seed: i + 5,
					title: meta ? meta.title : dec(t.description),
					sub: meta ? meta.artist : "",
					cover: meta ? meta.cover : "",
					metaId: meta ? meta.id || "" : "",
					metaType: meta ? meta.type || "" : "",
				});
			})
			.join("");
	}

	const ultimoEstado = new Map();
	let offlineDebounceTimer = null;

	function agendarAtualizarOffline() {
		if (offlineDebounceTimer) clearTimeout(offlineDebounceTimer);
		offlineDebounceTimer = setTimeout(() => {
			offlineDebounceTimer = null;
			atualizarOffline()
				.then(() => refreshSlots())
				.catch(() => {});
		}, 1500);
	}

	async function pollQueue() {
		const res = await backend.queue();
		const list = document.getElementById("dl-list");

		if (res.ok) {
			res.data = res.data.map((t) =>
				t.state === "mission accomplished" && String(t.result).trim() === "None"
					? { ...t, state: "failed", exception: "Sem arquivo: o servidor não baixou" }
					: t
			);

			const ativas = res.data.some((t) => ["run", "queue"].includes(stateMap(t.state)));
			if (!ativas) res.data.forEach((t) => stateMap(t.state) === "done" && dlHidden.add(String(t.id)));
			renderQueue(res.data);
			lastTasks = res.data;

			let algumDone = false;
			for (const [key, taskId] of Object.entries(jobs)) {
				const [tipo] = key.split(":");
				if (tipo !== "album" && tipo !== "playlist") continue;
				if (typeof taskId !== "string" || taskId === "pending" || taskId === "error") continue;
				const st = jobStatus(key);
				if (st === "done" && ultimoEstado.get(key) !== "done") {
					algumDone = true;
				}
				ultimoEstado.set(key, st);
			}
			if (algumDone) agendarAtualizarOffline();

			refreshSlots();
			marcarTocando();
		} else {
			list.innerHTML = `<p style="color:#ff4d6d">Servidor indisponível (${esc(res.error)})</p>`;
		}

		const busy = res.ok && res.data.some((t) => ["run", "queue"].includes(stateMap(t.state)));
		pollTimer = setTimeout(pollQueue, busy ? 1000 : 4000);
	}

	document.getElementById("dl-list").addEventListener("click", async (e) => {
		const btn = e.target.closest(".ibtn");
		if (!btn) return;
		const item = btn.closest(".dl-item");
		if (!item) return;

		const action = btn.dataset.action;

		if (action === "retry") {
			const metaId = item.dataset.metaId;
			const metaType = item.dataset.metaType || "track";
			if (!metaId) return;

			if (!(await garantirSessao())) {
				btn.disabled = false;
				btn.classList.add("ibtn");
				btn.innerHTML = '<svg class="i sm"><use href="#i-repeat"/></svg>';
				return;
			}

			btn.disabled = true;
			btn.classList.remove("ibtn");
			btn.innerHTML = STATUS_TAG.queue;

			dlHidden.delete(String(item.dataset.id));

			const fake = document.createElement("tr");
			fake.dataset.id = metaId;
			fake.dataset.type = metaType;
			fake.innerHTML = `<td><div class="t-cv"><div class="cv"></div><div><b>${esc(item.querySelector("b")?.textContent || "")}</b><small>${esc(item.querySelector("small")?.textContent || "")}</small></div></div></td>`;

			let ok = false;
			try {
				if (metaType === "playlist") {
					ok = await startPlaylist(fake);
				} else {
					ok = await startDownload(fake);
				}
			} catch (err) {
				ok = false;
			}

			if (!ok) {
				btn.disabled = false;
				btn.classList.add("ibtn");
				btn.innerHTML = '<svg class="i sm"><use href="#i-repeat"/></svg>';
			}
			return;
		}

		dlHidden.add(item.dataset.id);
		item.remove();
	});

	document.getElementById("dl-clear").addEventListener("click", () => {
		lastTasks.forEach((t) => stateMap(t.state) === "err" && dlHidden.add(String(t.id)));
		renderQueue(lastTasks);
	});

	/* ==========================================================================
		11. PÁGINA DO ÁLBUM
		========================================================================== */
	let curAlbum = null;
	let albumFila = [];

	const STATUS_TAG = {
		queue: '<span class="tag s-wait">Aguardando</span>',
		run: '<span class="tag s-run">Baixando...</span>',
		done: '<span class="tag s-ok">Completo</span>',
		err: '<span class="tag s-err">Erro</span>',
	};

		function renderAlbumTracks() {
			const body = document.getElementById("t-album");
			const info = document.getElementById("album-pag-info");
			const prev = document.getElementById("album-pag-prev");
			const next = document.getElementById("album-pag-next");
			if (!body || !curAlbum) return;

			let lista = curAlbum.tracks || [];
			if (soOffline) lista = lista.filter((t) => t.id && offIds.has(String(t.id)));

			const { total, paginas, visiveis } = paginar(lista, albumPag);

			if (info) info.textContent = `${albumPag.pagina + 1} / ${paginas}`;
			if (prev) prev.disabled = albumPag.pagina === 0;
			if (next) next.disabled = albumPag.pagina >= paginas - 1;

			if (!visiveis.length) {
				body.innerHTML = `<tr><td colspan="5" style="color:var(--mut);padding:18px 0">${
				(curAlbum.tracks || []).length ? "Nada offline nesta página." : "Nenhuma faixa."
				}</td></tr>`;
				return;
			}

			body.innerHTML = visiveis.map((t) => albumRowHTML(t, curAlbum)).join("");
			[...body.querySelectorAll(".t-cv .cv[data-cover-tipo]")].forEach((el) => aplicarCapa(el));
		}


	function albumRowHTML(t, a) {
		const bg = a.cover
			? `background:url('${esc(a.cover)}') center/cover`
			: `background:${grad(t.track_position)}`;
		const artistName = esc((t.artist && t.artist.name) || a.artist);
		const artistId = (t.artist && t.artist.id) || "";
		const who = artistId
			? `<span class="artist-link" data-artist-id="${artistId}">${artistName}</span>`
			: artistName;
		const albTitle = esc((t.album && t.album.title) || a.title || "");
		const albId = (t.album && t.album.id) || "";
		const alb = albId
			? `<span class="album-link" data-album-id="${albId}">${albTitle}</span>`
			: albTitle;
		const off = t.id && offIds.has(String(t.id));
		const acao = off
			? seloOffline
			: '<button class="dl"><svg class="i sm"><use href="#i-download"/></svg>Baixar</button>';
		const coverTipo = "album";
		const coverId = a.playlist ? (t.album && t.album.id) || "" : a.id || "";
		const cAttrs = coverId ? ` data-cover-tipo="${coverTipo}" data-cover-id="${coverId}"` : "";
		const addPl = t.id
			? `<button class="ibtn pl-add" data-tip="Adicionar à playlist"><svg class="i sm"><use href="#i-plus"/></svg></button>`
			: "";

		const rem = a.playlist
			? `<button class="ibtn" data-tip="Remover da playlist" data-remove-pl="${esc(a.title)}" data-remove-id="${esc(t.id)}"><svg class="i sm"><use href="#i-x"/></svg></button>`
			: "";

		return `<tr class="row" data-id="${t.id}" data-preview="${esc(t.preview)}" data-off="${off ? "1" : "0"}">
			${favCellHTML(t.id)}
			<td>${t.track_position}</td>
			<td><div class="t-cv"><div class="cv" style="${bg}"${cAttrs}></div><div><b>${checkOff(off)}${esc(t.title)}</b><small>${who}</small></div></div></td>
			<td>${fmtT(t.duration)}</td>
			<td><div class="acts">
				${addPl}
				${off ? "" : '<button class="ibtn" data-tip="Tocar"><svg class="i f"><use href="#i-play"/></svg></button>'}
				${rem}
				${acao}
			</div></td>
			</tr>`;
	}

	function ligarPlayAlbum() {
		const btn = document.getElementById("a-play");
		if (!btn) return;
		btn.onclick = () => {
			if (!albumFila.length) return;
			tocarFila(albumFila, 0);
		};
		btn.disabled = !albumFila.length;
	}

	async function openAlbumData(a) {
		a.tracks = [];
		a.origem = a.origem || "search";
		a.origemView = a.origemView || (a.origem === "artist" ? "artist" : "search");
		curAlbum = a;
		albumFila = [];

		const aAll = document.getElementById("a-all");
		if (aAll) aAll.style.display = "none";

		const backAlbum = document.querySelector("#v-album .sec-h .btn-ghost[data-view]");
		if (backAlbum) {
			backAlbum.dataset.view = a.origem === "search" ? "search" : a.origemView || "search";
		}

		document.getElementById("a-title").textContent = a.title;
		document.getElementById("a-artist").textContent = a.artist || "";
		document.getElementById("a-info").textContent = "Carregando...";

		const coverEl = document.getElementById("a-cover");
		coverEl.style.background = "";
		coverEl.style.backgroundImage = "";

		if (a.cover) {
			coverEl.style.background = `url("${esc(a.cover)}") center/cover`;
		}

		if (a.id) {
			capaLocal("album", a.id).then((url) => {
				if (url && curAlbum === a) coverEl.style.background = `url("${url}") center/cover`;
			});
		}

		const body = document.getElementById("t-album");
		body.innerHTML = '<tr><td colspan="5" style="color:var(--mut);padding:20px">Carregando faixas...</td></tr>';
		showView("album");

		ligarPlayAlbum();

		await atualizarOffline();

		const [resInfo, resTracks] = await Promise.all([
			backend.albumInfo
				? backend.albumInfo(a.id).catch(() => ({ ok: false }))
				: Promise.resolve({ ok: false }),
			backend.albumTracks(a.id).catch(() => ({ ok: false, error: "falha ao carregar" })),
		]);
		if (curAlbum !== a) return;

		if (!resTracks.ok) {
			document.getElementById("a-info").textContent = "";
			body.innerHTML = `<tr><td colspan="5" style="color:#ff4d6d;padding:20px">Não foi possível carregar (${esc(resTracks.error || "sem conexão")})</td></tr>`;
			return;
		}

		a.tracks = resTracks.data || [];

		const info = resInfo.ok ? resInfo.data : null;
		const artista = (info && info.artist && info.artist.name) || a.artist || "";
		const faixasN = (info && info.nb_tracks) || a.tracks.length;
		const data = (info && info.release_date) || "";

		document.getElementById("a-artist").textContent = artista;
		const partes = [`${faixasN} faixa${faixasN === 1 ? "" : "s"}`];
		if (data) partes.push(formatarData(data));
		document.getElementById("a-info").textContent = partes.join("  ·  ");

		if (info && info.cover_big) {
			capaLocal("album", info.id || a.id).then((url) => {
				if (url) {
					if (curAlbum === a) coverEl.style.background = `url("${url}") center/cover`;
				} else if (curAlbum === a) {
					coverEl.style.background = `url("${esc(info.cover_big)}") center/cover`;
				}
			});
		}

		albumPag.pagina = 0;
		renderAlbumTracks();

		albumFila = a.tracks
			.filter((t) => t.id && t.preview)
			.map((t) => {
				const artistaT = (t.artist && t.artist.name) || a.artist || "";
				return {
					id: String(t.id),
					preview: t.preview,
					title: t.title || "",
					artist: artistaT,
					cover: "",
				};
			});
		ligarPlayAlbum();
		marcarTocando();
		refreshSlots();
		aplicarFiltroOffline();
	}

	async function openPlaylist(row) {
		const a = {
			id: row.dataset.id,
			title: row.querySelector(".t-cv b").textContent,
			artist: row.querySelector(".t-cv small").textContent,
			cover:
				(row.querySelector(".t-cv .cv").style.backgroundImage.match(/url\("?(.*?)"?\)/) || [])[1] || "",
			playlist: true,
			origem: "search",
			origemView: "search",
			tracks: [],
		};
		curAlbum = a;
		albumFila = [];

		const aAll = document.getElementById("a-all");
		if (aAll) aAll.style.display = "";

		const backAlbum = document.querySelector("#v-album .sec-h .btn-ghost[data-view]");
		if (backAlbum) backAlbum.dataset.view = "search";

		document.getElementById("a-title").textContent = a.title;
		document.getElementById("a-artist").textContent = a.artist || "";
		document.getElementById("a-info").textContent = "Carregando...";

		const coverEl = document.getElementById("a-cover");
		coverEl.style.background = "";
		coverEl.style.backgroundImage = "";

		const body = document.getElementById("t-album");
		body.innerHTML = '<tr><td colspan="5" style="color:var(--mut);padding:20px">Carregando faixas...</td></tr>';
		showView("album");

		ligarPlayAlbum();

		await atualizarOffline();
		let res;
		try {
			res = await backend.playlistTracks(a.id);
		} catch (e) {
			res = { ok: false, error: e.message };
		}

		if (curAlbum !== a) return;
		if (!res.ok) {
			document.getElementById("a-info").textContent = "";
			body.innerHTML = `<tr><td colspan="5" style="color:#ff4d6d;padding:20px">Não foi possível carregar (${esc(res.error)})</td></tr>`;
			return;
		}
		a.tracks = res.data.tracks.map((t, i) => ({
			id: t.id,
			title: t.title,
			artist: { id: t.artistId || 0, name: t.artist || "" },
			album: { id: t.albumId || 0, title: t.album || "", cover: t.cover || "" },
			preview: t.preview,
			duration: t.duration,
			track_position: i + 1,
		}));

		const faixasN = a.tracks.length;
		const partes = [`${faixasN} faixa${faixasN === 1 ? "" : "s"}`];
		if (res.data.releaseDate) partes.push(formatarData(res.data.releaseDate));
		document.getElementById("a-info").textContent = partes.join("  ·  ");

		const coverDeFaixa = a.tracks.find((t) => t.album && t.album.cover);
		if (coverDeFaixa) {
			coverEl.style.background = `url("${esc(coverDeFaixa.album.cover)}") center/cover`;
		}
		if (a.id) {
			capaLocal("playlist", a.id).then((url) => {
				if (url && curAlbum === a) coverEl.style.background = `url("${url}") center/cover`;
			});
		}

		albumPag.pagina = 0;
		renderAlbumTracks();

		albumFila = a.tracks
			.filter((t) => t.id && t.preview)
			.map((t) => ({
				id: String(t.id),
				preview: t.preview,
				title: t.title || "",
				artist: (t.artist && t.artist.name) || a.artist || "",
				cover: "",
			}));
		ligarPlayAlbum();
		marcarTocando();
		refreshSlots();
		aplicarFiltroOffline();
	}

	function openAlbum(row) {
		const link = row.querySelector(".t-cv .artist-link");
		openAlbumData({
			id: row.dataset.id,
			title: row.querySelector(".t-cv b").textContent,
			artist: link ? link.textContent : row.querySelector(".t-cv small").textContent,
			cover:
				(row.querySelector(".t-cv .cv").style.backgroundImage.match(/url\("?(.*?)"?\)/) || [])[1] || "",
			origem: "search",
		});
	}
	document.getElementById("album-pag-prev")?.addEventListener("click", () => {
		albumPag.pagina--;
		renderAlbumTracks();
	});
	document.getElementById("album-pag-next")?.addEventListener("click", () => {
		albumPag.pagina++;
		renderAlbumTracks();
	});
	document.getElementById("t-results").addEventListener("click", (e) => {
		if (e.target.closest("button") || e.target.closest(".artist-link") || e.target.closest(".album-link")) return;
		const row = e.target.closest("tr.row");
		if (!row) return;
		if (row.dataset.type === "album") openAlbum(row);
		else if (row.dataset.type === "playlist") openPlaylist(row);
	});

	const jobs = {};
	const jobKey = (type, id) => `${type}:${id}`;

	function taskStatus(taskId, tipo, id) {
		let t = lastTasks.find((x) => String(x.id) === String(taskId));
		if (!t) {
			const campo = tipo === "album" ? "album_id" : tipo === "playlist" ? "playlist_url" : "track_id";
			const alvo = tipo === "playlist" ? String(id) : id;
			const argsDec = dec(String(t.args || ""));
			const re = new RegExp(campo + "['\"]?:\\s*['\"]?([^,}\\]]+)");
			t = lastTasks
				.filter((x) => {
					const m = re.exec(argsDec);
					return m && String(m[1]).includes(String(alvo));
				})
				.pop();
		}
		return t ? stateMap(t.state) : "queue";
	}

	function jobStatus(key) {
		const j = jobs[key];
		if (j === undefined) return "";
		if (j === "pending") return "queue";
		if (j === "error") return "err";

		if (typeof j === "object") {
			if (j.sending) return "run";
			if (!j.tasks.length) return "queue";
			const sts = j.tasks.map(([taskId, id]) => taskStatus(taskId, "track", id));
			if (sts.some((s) => s === "run" || s === "queue")) return "run";
			return sts.every((s) => s === "err") ? "err" : "done";
		}

		const [tipo, id] = key.split(":");
		const st = taskStatus(j, tipo, id);

		const aindaNaFila = lastTasks.some((t) => String(t.id) === String(j));
		if (!aindaNaFila) {
			if (tipo === "track") {
				return offIds.has(String(id)) ? "done" : st;
			}
			return st;
		}

		return st;
	}

	const SLOT_HTML = {
		"": '<button class="dl"><svg class="i sm"><use href="#i-download"/></svg>Baixar</button>',
		queue: STATUS_TAG.queue,
		run: STATUS_TAG.run,
		done: STATUS_TAG.done,
		err: '<button class="dl"><svg class="i sm"><use href="#i-download"/></svg>Erro, tentar de novo</button>',
	};

	function refreshSlots() {
		const albumEmAndamento = (() => {
			if (!curAlbum) return null;
			const key = jobKey(curAlbum.playlist ? "playlist" : "album", curAlbum.id);
			const st = jobStatus(key);
			return st === "queue" || st === "run" ? st : null;
		})();

		document.querySelectorAll( "#t-results tr.row, #t-artist-top tr.row, #t-album tr.row, #ex-tracks tr.row").forEach((row) => {
			const acts = row.querySelector(".acts");
			if (!acts) return;
			let slot = acts.querySelector(".dl-slot");
			if (!slot) {
				const btn = acts.querySelector(".dl");
				if (!btn) return;
				slot = document.createElement("span");
				slot.className = "dl-slot";
				btn.replaceWith(slot);
			}

			const emAlbum = row.closest("#t-album") && albumEmAndamento;
			const st = emAlbum ? albumEmAndamento : jobStatus(jobKey(row.dataset.type || "track", row.dataset.id));

			if (slot.dataset.st !== st) {
				slot.innerHTML = SLOT_HTML[st];
				slot.dataset.st = st;
			}
		});

		const aAll = document.getElementById("a-all");
		if (!aAll || !curAlbum) return;

		if (curAlbum.origem !== "search" && curAlbum.origem !== "explore") {
			aAll.style.display = "none";
			return;
		}
		const keyAlbum = jobKey(curAlbum.playlist ? "playlist" : "album", curAlbum.id);
		const stAlbum = jobStatus(keyAlbum);
		const label = aAll.lastChild;

		const todasOffline =
			curAlbum.tracks &&
			curAlbum.tracks.length > 0 &&
			curAlbum.tracks.every((t) => offIds.has(String(t.id)));

		if (stAlbum === "done" || todasOffline) {
			aAll.style.display = "none";
			aAll.disabled = false;
			if (label && label.nodeType === 3) label.textContent = "Baixar todas";
			return;
		}

		aAll.style.display = "";
		if (stAlbum === "queue" || stAlbum === "run") {
			aAll.disabled = true;
			if (label && label.nodeType === 3) label.textContent = "Baixando...";
		} else {
			aAll.disabled = false;
			if (label && label.nodeType === 3) label.textContent = "Baixar todas";
		}
	}

	const slotObserver = new MutationObserver(refreshSlots);
	["t-results", "t-artist-top", "t-album", "ex-tracks"].forEach((id) => {
		const el = document.getElementById(id);
		if (el) slotObserver.observe(el, { childList: true });
	});

	const offlineObserver = new MutationObserver((mutations) => {
		for (const m of mutations) {
			for (const node of m.addedNodes) {
				if (node.nodeType !== 1) continue;
				const rows = node.matches?.("tr.row") ? [node] : [...(node.querySelectorAll?.("tr.row") || [])];
				for (const row of rows) {
					if (row.dataset.off === "1" && row.dataset.id && !row.dataset.preview?.startsWith("file:")) {
						prepararLinhaOffline(row, row.dataset.id);
					}
					const cv = row.querySelector?.(".t-cv .cv[data-cover-tipo]");
					if (cv) aplicarCapa(cv);
				}
			}
		}
		marcarTocando();
	});
["t-results", "t-artist-top", "t-album", "lc-rows", "ar-albums", "t-favs", "ex-tracks"].forEach((id) => {
	const el = document.getElementById(id);
	if (el) offlineObserver.observe(el, { childList: true });
});

	async function startPlaylist(row) {
		if (!(await garantirSessao())) return false;
		const key = jobKey("playlist", row.dataset.id);
		jobs[key] = "pending";
		refreshSlots();

		const url = `https://www.deezer.com/playlist/${row.dataset.id}`;
		const res = await backend.playlist(url);

		if (!res.ok) {
			jobs[key] = "error";
			refreshSlots();
			return false;
		}

		jobs[key] = res.data.task_id;
		dlMeta[String(res.data.task_id)] = {
			title: row.querySelector(".t-cv b").textContent,
			artist: row.querySelector(".t-cv small").textContent,
			cover:
				(row.querySelector(".t-cv .cv").style.backgroundImage.match(/url\("?(.*?)"?\)/) || [])[1] || "",
			id: row.dataset.id,
			type: "playlist",
		};
		saveMeta();
		clearTimeout(pollTimer);
		pollQueue();
		return true;
	}

	async function startDownload(row) {
		if (!(await garantirSessao())) return false;
		const type = row.dataset.type || "track";

		if (row.closest("#t-album") && curAlbum) {
			const albumKeyJ = jobKey(curAlbum.playlist ? "playlist" : "album", curAlbum.id);
			const st = jobStatus(albumKeyJ);
			if (st === "queue" || st === "run") {
				return false;
			}
		}

		if (type === "playlist") return startPlaylist(row);

		const key = jobKey(type, row.dataset.id);
		jobs[key] = "pending";
		refreshSlots();

		if (type === "album" && backend.registrarAlbum) {
			try {
				const at = await backend.albumTracks(row.dataset.id);
				if (at.ok && at.data && at.data.length) {
					const artistLink = row.querySelector(".t-cv .artist-link");
					backend.registrarAlbum({
						id: row.dataset.id,
						title: row.querySelector(".t-cv b").textContent,
						artist: artistLink ? artistLink.textContent : row.querySelector(".t-cv small").textContent,
						trackIds: at.data.map((t) => t.id),
					});
				}
			} catch (e) {
				/* sem trackIds */
			}
		}

		if (type === "track" && backend.registrarAlbum) {
			if (curAlbum && !curAlbum.playlist && row.closest("#t-album") && curAlbum.tracks && curAlbum.tracks.length) {
				backend.registrarAlbum({
					id: curAlbum.id,
					title: curAlbum.title,
					artist: curAlbum.artist,
					trackIds: curAlbum.tracks.map((t) => t.id),
				});
			} else {
				(async () => {
					try {
						const info = await backend.trackInfo(row.dataset.id);
						if (!info.ok || !info.data || !info.data.album) return;
						const alb = info.data.album;
						const art = info.data.artist || {};
						const albTracks = await backend.albumTracks(alb.id);
						if (!albTracks.ok || !albTracks.data || !albTracks.data.length) return;
						backend.registrarAlbum({
							id: alb.id,
							title: alb.title || "",
							artist: art.name || "",
							trackIds: albTracks.data.map((t) => t.id),
						});
					} catch (e) {
						/* silencioso */
					}
				})();
			}
		}

		const res = await backend.download(type === "album" ? "album" : "track", row.dataset.id);

		if (!res.ok) {
			jobs[key] = "error";
			refreshSlots();
			return false;
		}

		jobs[key] = res.data.task_id;
		dlMeta[String(res.data.task_id)] = {
			title: row.querySelector(".t-cv b").textContent,
			artist: row.querySelector(".t-cv small").textContent,
			cover:
				(row.querySelector(".t-cv .cv").style.backgroundImage.match(/url\("?(.*?)"?\)/) || [])[1] || "",
			id: row.dataset.id,
			type,
		};
		saveMeta();
		clearTimeout(pollTimer);
		pollQueue();
		return true;
	}

	["t-results", "t-artist-top", "t-album", "ex-tracks"].forEach((id) => {
		const el = document.getElementById(id);
		if (!el) return;
		el.addEventListener("click", (e) => {
			const btn = e.target.closest(".dl");
			if (btn) startDownload(btn.closest("tr.row"));
		});
	});

	document.getElementById("a-all").addEventListener("click", async (e) => {
		const btn = e.currentTarget;
		if (btn.disabled || !curAlbum) return;

		const keyAlbum = jobKey(curAlbum.playlist ? "playlist" : "album", curAlbum.id);
		const st = jobStatus(keyAlbum);
		if (st === "queue" || st === "run") return;

		const fake = document.createElement("tr");
		fake.dataset.id = curAlbum.id;
		fake.dataset.type = curAlbum.playlist ? "playlist" : "album";
		fake.innerHTML = `<td><div class="t-cv"><div class="cv" style="background:url('${esc(curAlbum.cover || "")}') center/cover"></div><div><b>${esc(curAlbum.title)}</b><small>${esc(curAlbum.artist)}</small></div></div></td>`;

		const ok = await startDownload(fake);

		if (ok) showView("downloads");
	});

	document.getElementById("t-album").addEventListener("click", async (e) => {
		const btn = e.target.closest("[data-remove-pl]");
		if (!btn) return;
		e.stopPropagation();
		const pl = btn.dataset.removePl;
		const id = btn.dataset.removeId;
		if (!pl || !id || !backend.playlistsRemoveFaixa) return;
		btn.disabled = true;
		try {
			const r = await backend.playlistsRemoveFaixa(pl, id);
			if (!r || !r.ok) throw new Error((r && r.error) || "falha ao remover");
			const fakeRow = document.createElement("tr");
			fakeRow.dataset.id = curAlbum.id;
			fakeRow.innerHTML = `<td><div class="t-cv"><div class="cv"></div><div><b>${esc(curAlbum.title)}</b><small>${esc(curAlbum.artist)}</small></div></div></td>`;
			openPlaylist(fakeRow);
		} catch (err) {
			btn.disabled = false;
			alert(err.message || "erro ao remover");
		}
	});

	/* ==========================================================================
		12. PÁGINA DO ARTISTA
		========================================================================== */
	let curArtist = null;
	const artistCache = new Map();

	const arMusicas = {
		todas: [],
		filtro: "",
		pagina: 0,
		porPagina: 20,
	};

	let arFila = [];

	// paginação client-side da aba Álbuns do artista
	const arAlbuns = { todas: [], pagina: 0, porPagina: 20 };

	// paginação client-side da página de álbum/playlist
	const albumPag = { pagina: 0, porPagina: 20 };

	// helper de paginação reutilizável
	function paginar(lista, estado) {
	const total = lista.length;
	const paginas = Math.max(1, Math.ceil(total / estado.porPagina));
	if (estado.pagina >= paginas) estado.pagina = paginas - 1;
	if (estado.pagina < 0) estado.pagina = 0;
	const ini = estado.pagina * estado.porPagina;
	return {
		total,
		paginas,
		ini,
		visiveis: lista.slice(ini, ini + estado.porPagina),
	};
	}

	// NOVO — ✓ verde no nome quando offline
	function checkOff(off) {
	return off
		? `<svg class="i sm" style="color:#1db954;vertical-align:-3px;margin-right:4px" title="Já está no disco"><use href="#i-check"/></svg>`
		: "";
	}


	function tabAtiva(name) {
		document.querySelectorAll("#ar-tabs .tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
		document.querySelectorAll("#v-artist .tab-panel").forEach((p) => p.classList.toggle("on", p.id === `ar-panel-${name}`));
	}

	document.querySelectorAll("#ar-tabs .tab").forEach((b) =>
		b.addEventListener("click", () => tabAtiva(b.dataset.tab))
	);

	function filaArtistaVisivel() {
		let lista = arMusicas.todas;
		if (soOffline) lista = lista.filter((x) => x.offline);
		const f = norm(arMusicas.filtro);
		if (f) lista = lista.filter((x) => norm(x.titulo).includes(f) || norm(x.album).includes(f));
		return lista;
	}

	function atualizarFilaArtista() {
		const lista = filaArtistaVisivel();
		arFila = lista
			.filter((x) => x.id)
			.map((x) => ({
				id: x.id,
				preview: x.url || "",
				title: x.titulo || "",
				artist: x.artista || "",
				cover: "",
			}))
			.filter((x) => x.preview);
		return arFila;
	}

	function ligarPlayArtista() {
		const btn = document.getElementById("ar-play");
		if (!btn) return;
		btn.onclick = () => {
			const itens = atualizarFilaArtista();
			if (!itens.length) {
				mostrarToast("Nenhuma faixa tocável");
				return;
			}
			tocarFila(itens, 0);
		};
	}

	function renderMusicasOffline() {
		const body = document.getElementById("t-artist-top");
		const contagem = document.getElementById("ar-contagem");
		const pagInfo = document.getElementById("ar-pag-info");
		const prev = document.getElementById("ar-pag-prev");
		const next = document.getElementById("ar-pag-next");

		let lista = arMusicas.todas;
		if (soOffline) lista = lista.filter((x) => x.offline);
		const f = norm(arMusicas.filtro);
		if (f) lista = lista.filter((x) => norm(x.titulo).includes(f) || norm(x.album).includes(f));

		const total = lista.length;
		const paginas = Math.max(1, Math.ceil(total / arMusicas.porPagina));
		if (arMusicas.pagina >= paginas) arMusicas.pagina = paginas - 1;
		if (arMusicas.pagina < 0) arMusicas.pagina = 0;

		const ini = arMusicas.pagina * arMusicas.porPagina;
		const fim = ini + arMusicas.porPagina;
		const visiveis = lista.slice(ini, fim);

		const sufixos = [];
		if (soOffline) sufixos.push("offline");
		if (arMusicas.filtro) sufixos.push(`filtro: "${arMusicas.filtro}"`);
		const suf = sufixos.length ? ` (${sufixos.join(" · ")})` : "";
		contagem.textContent = `${total} música${total === 1 ? "" : "s"}${suf}`;

		pagInfo.textContent = `Página ${arMusicas.pagina + 1} de ${paginas}`;
		prev.disabled = arMusicas.pagina === 0;
		next.disabled = arMusicas.pagina >= paginas - 1;

		if (!visiveis.length) {
			body.innerHTML = `<tr><td colspan="5" style="color:var(--mut);padding:18px 0">${
				arMusicas.todas.length
					? "Nada casou com o filtro."
					: "Nenhuma faixa deste artista."
			}</td></tr>`;
			atualizarFilaArtista();
			marcarTocando();
			return;
		}

		body.innerHTML = visiveis
			.map((x, i) => {
				const n = ini + i + 1;
				const cAttrs = x.albumId ? ` data-cover-tipo="album" data-cover-id="${esc(x.albumId)}"` : "";
				const coverRemota = x.coverRemota || '';
				const bg = x.coverRemota ? `background:url('${esc(x.coverRemota)}') center/cover` : `background:${grad(n + 1)}`;
				const album = x.album || "";
				const albLink =
					x.albumId && album
						? `<span class="album-link" data-album-id="${esc(x.albumId)}" data-artist="${esc(curArtist ? curArtist.name : "")}">${esc(album)}</span>`
						: album
							? esc(album)
							: "";
				const addPl = x.id
					? `<button class="ibtn pl-add" data-tip="Adicionar à playlist"><svg class="i sm"><use href="#i-plus"/></svg></button>`
					: "";
				const off = x.offline ? "1" : "0";
				return `<tr class="row" data-i="${n}" data-id="${esc(x.id || "")}" data-preview="${esc(x.url)}" data-off="${off}" data-offline="${off}">
					${favCellHTML(x.id)}
					<td>${n}</td>
					<td><div class="t-cv"><div class="cv" style="${bg}"${cAttrs}></div><div><b>${checkOff(x.offline)}${esc(x.titulo)}</b>${albLink ? `<small>${albLink}</small>` : ""}</div></div></td>
					<td>${x.dur > 0 ? fmtT(x.dur) : "--:--"}</td>
					<td><div class="acts">${addPl}${x.url ? '<button class="ibtn" data-tip="Tocar"><svg class="i f"><use href="#i-play"/></svg></button>' : ""}</div></td>
					</tr>`;
			})
			.join("");

		[...body.querySelectorAll(".t-cv .cv[data-cover-tipo]")].forEach((el) => aplicarCapa(el));

		atualizarFilaArtista();
		marcarTocando();
	}

	function renderAlbunsArtista() {
		const grid = document.getElementById("ar-albums");
		const info = document.getElementById("ar-pag-albuns-info");
		const prev = document.getElementById("ar-pag-albuns-prev");
		const next = document.getElementById("ar-pag-albuns-next");
		if (!grid) return;

		let lista = arAlbuns.todas;
		if (soOffline) lista = lista.filter((a) => a.temOffline);

		const { total, paginas, ini, visiveis } = paginar(lista, arAlbuns);

		if (info) info.textContent = `${arAlbuns.pagina + 1} / ${paginas}`;
		if (prev) prev.disabled = arAlbuns.pagina === 0;
		if (next) next.disabled = arAlbuns.pagina >= paginas - 1;

		if (!visiveis.length) {
			grid.innerHTML = `<small style="color:var(--mut)">${
			arAlbuns.todas.length ? "Nada offline nesta aba." : "Nenhum álbum disponível."
			}</small>`;
			return;
		}

		grid.innerHTML = visiveis
			.map((a, i) => {
			const cAttrs = a.id ? ` data-cover-tipo="album" data-cover-id="${esc(a.id)}"` : "";
			const bg = a.cover ? "" : `style="background:${grad(ini + i + 1)}"`;
			const img = a.cover ? `<img src="${esc(a.cover)}" alt="">` : "";
			const check = checkOff(a.temOffline);
			return `<div class="card" data-album-id="${esc(a.id)}" data-title="${esc(a.title)}" data-cover="${esc(a.cover || "")}" data-off="${a.temOffline ? "1" : "0"}">
				<div class="cv" ${bg}${cAttrs}>${img}</div>
				<b>${check}${esc(a.title)}</b>
				<small>${esc(a.artist || (curArtist ? curArtist.name : ""))}</small>
			</div>`;
			})
			.join("");

		[...grid.querySelectorAll(".cv[data-cover-tipo]")].forEach((el) => aplicarCapa(el));
	}
	function ligarFiltro() {
		const inp = document.getElementById("ar-filtro");
		if (inp.dataset.ligado === "1") return;
		inp.dataset.ligado = "1";
		let t;
		inp.addEventListener("input", () => {
			clearTimeout(t);
			t = setTimeout(() => {
				arMusicas.filtro = inp.value;
				arMusicas.pagina = 0;
				renderMusicasOffline();
			}, 200);
		});
	}

	function ligarPaginacao() {
		const prev = document.getElementById("ar-pag-prev");
		const next = document.getElementById("ar-pag-next");
		if (prev.dataset.ligado === "1") return;
		prev.dataset.ligado = "1";
		next.dataset.ligado = "1";
		prev.addEventListener("click", () => {
			arMusicas.pagina--;
			renderMusicasOffline();
		});
		next.addEventListener("click", () => {
			arMusicas.pagina++;
			renderMusicasOffline();
		});
	}

	function artistTopRowHTML(t, i) {
		const cover = (t.album && t.album.cover_small) || "";
		const albTitle = esc((t.album && t.album.title) || "");
		const albId = (t.album && t.album.id) || "";
		const albLink = albId && albTitle
			? `<span class="album-link" data-album-id="${albId}" data-artist="${esc(curArtist ? curArtist.name : "")}">${albTitle}</span>`
			: albTitle;
		const off = t.id && offIds.has(String(t.id));
		const acao = off
			? seloOffline
			: '<button class="dl"><svg class="i sm"><use href="#i-download"/></svg>Baixar</button>';
		const cAttrs = albId ? ` data-cover-tipo="album" data-cover-id="${albId}"` : "";
		const bg = cover ? `background:url('${esc(cover)}') center/cover` : `background:${grad(i + 1)}`;
		const addPl = t.id
			? `<button class="ibtn pl-add" data-tip="Adicionar à playlist"><svg class="i sm"><use href="#i-plus"/></svg></button>`
			: "";
		return `<tr class="row" data-id="${t.id}" data-preview="${esc(t.preview)}" data-off="${off ? "1" : "0"}">
			${favCellHTML(t.id)}
			<td>${i + 1}</td>
			<td><div class="t-cv"><div class="cv" style="${bg}"${cAttrs}></div><div><b>${esc(t.title)}</b>${albLink ? `<small>${albLink}</small>` : ""}</div></div></td>
			<td>${fmtT(t.duration)}</td>
			<td><div class="acts">
				${addPl}
				${off ? "" : '<button class="ibtn" data-tip="Tocar"><svg class="i f"><use href="#i-play"/></svg></button>'}
				${acao}
			</div></td>
			</tr>`;
	}

	function artistAlbumCardHTML(a) {
		const nomeArtista = curArtist ? curArtist.name : "";
		const off = (offAlbumsFaixas.get(albumKey(nomeArtista, a.title)) || 0) > 0;
		const selo = off ? ` ${seloOffline}` : "";
		return `<div class="card" data-album-id="${a.id}" data-title="${esc(a.title)}" data-cover="${esc(a.cover_small)}">
			<div class="cv" data-cover-tipo="album" data-cover-id="${a.id}"><img src="${esc(a.cover_medium || a.cover || "")}" alt=""></div>
			<b>${esc(a.title)}${selo}</b><small>${esc((a.release_date || "").slice(0, 4))}</small>
			</div>`;
	}

	function artistPlaylistCardHTML(p, i) {
		const cAttrs = p.playlistId ? ` data-cover-tipo="playlist" data-cover-id="${esc(p.playlistId)}"` : "";
		const bg = p.cover ? "" : `style="background:${grad(i + 1)}"`;
		const img = p.cover ? `<img src="${p.cover}" alt="">` : "";
		return `<div class="card" data-playlist-local="${esc(p.title)}">
			<div class="cv" ${bg}${cAttrs}>${img}</div>
			<b>${esc(p.title)}</b>
			<small>${p.faixasDoArtista} de ${p.faixasNoTotal} faixa${p.faixasNoTotal === 1 ? "" : "s"} deste artista</small>
			</div>`;
	}

	async function openArtist(link) {
		const row = link.closest && link.closest("tr.row");
		const token = { name: link.textContent };
		curArtist = token;
		arFila = [];

		// ===== CORREÇÃO 2: origem do botão "Voltar" =====
		const origemView = (link.dataset && link.dataset.origemView) || link.origem || "search";
		const backBtn = document.querySelector('#v-artist .art-head .btn-ghost[data-view]');
		if (backBtn) backBtn.dataset.view = origemView;

		const sub = document.getElementById("ar-sub");
		document.getElementById("ar-name").textContent = token.name;
		document.getElementById("ar-pic").style.backgroundImage = "";
		document.getElementById("t-artist-top").innerHTML = "";
		document.getElementById("ar-albums").innerHTML = "";
		document.getElementById("ar-panel-playlists").innerHTML = "";
		document.getElementById("ar-contagem").textContent = "";
		sub.textContent = "Carregando...";
		tabAtiva("musicas");
		showView("artist");

		// 1) Tenta online
		let online = null;
		let id = link.dataset && link.dataset.artistId;
		try {
			if (!id && row && row.dataset.id && backend.trackInfo) {
				const r = await backend.trackInfo(row.dataset.id);
				if (r && r.ok && r.data && r.data.artist) id = r.data.artist.id;
			}
			if (id && backend.artistPage) {
				const res = await backend.artistPage(id);
				if (res && res.ok) online = res.data;
			}
		} catch (e) { /* cai no offline */ }
		if (curArtist !== token) return;

		// 2) Monta a lista de músicas e álbuns
		let todas = [];
		let albums = [];
		let artistaIdParaCapa = id;

		if (online) {
			const { info, top, albums: alb } = online;
			token.name = info.name;
			document.getElementById("ar-name").textContent = info.name;
			document.getElementById("ar-pic").style.backgroundImage = `url("${info.picture_big}")`;
			sub.textContent = `${(info.nb_fan || 0).toLocaleString("pt-BR")} fãs · ${info.nb_album || alb.length} álbuns`;
			artistaIdParaCapa = info.id;

			todas = (top || []).map((t) => {
				const tid = String(t.id);
				return {
					id: tid,
					titulo: t.title,
					artista: (t.artist && t.artist.name) || info.name,
					album: (t.album && t.album.title) || "",
					albumId: (t.album && t.album.id) || "",
					// ===== CORREÇÃO 1: capa remota do álbum =====
					coverRemota: (t.album && (t.album.cover_small || t.album.cover_medium)) || "",
					dur: t.duration || -1,
					url: t.preview || "",
					offline: offIds.has(tid),
				};
			});

			albums = (alb || [])
				.slice()
				.sort((a, b) => (b.release_date || "").localeCompare(a.release_date || ""));

			// Quais álbuns deste artista têm pelo menos uma faixa no disco?
			let albunsComOffline = new Set();
			try {
				const lib = await backend.libraryArtistAlbums(token.name);
				(lib || []).forEach((a) => {
					if ((a.faixasNoDisco || 0) > 0 && a.albumId) {
						albunsComOffline.add(String(a.albumId));
					}
				});
			} catch (e) { /* segue sem o check */ }
			if (curArtist !== token) return;

			albums = albums.map((a) => ({
				id: a.id,
				title: a.title,
				artist: info.name,
				cover: a.cover_medium || a.cover || "",
				cover_small: a.cover_small || a.cover || "",
				temOffline: albunsComOffline.has(String(a.id)),
			}));
		} else {
			// 2b) Fallback offline
			let faixas = [];
			try { faixas = await backend.libraryArtist(token.name); } catch (e) {}
			if (curArtist !== token) return;

			todas = (faixas || [])
				.filter((f) => f.id)
				.map((f) => {
					const sep = f.nome.indexOf(" - ");
					const titulo = sep > 0 ? f.nome.slice(sep + 3) : f.nome;
					return {
						id: String(f.id),
						titulo,
						artista: token.name,
						album: f.albumTitle || "",
						albumId: f.albumId || "",
						// offline: capa virá do aplicarCapa() se estiver em disco
						coverRemota: "",
						dur: f.dur || -1,
						url: f.url || "",
						offline: true,
					};
				});
			sub.textContent = `${contar(todas.length)} · offline`;

			let lib = [];
			try { lib = (await backend.libraryArtistAlbums(token.name)) || []; } catch (e) { lib = []; }
			if (curArtist !== token) return;

			albums = lib.map((a) => ({
				id: a.albumId,
				title: a.title,
				artist: token.name,
				cover: a.cover || "",
				cover_small: a.cover || "",
				temOffline: (a.faixasNoDisco || 0) > 0,
			}));
		}
		if (curArtist !== token) return;

		// 3) Playlists locais do artista (sempre)
		let playlists = [];
		try { playlists = (await backend.libraryArtistPlaylists(token.name)) || []; } catch (e) {}
		if (curArtist !== token) return;

		// 4) Aba Músicas
		arMusicas.todas = todas;
		arMusicas.filtro = "";
		arMusicas.pagina = 0;

		const inp = document.getElementById("ar-filtro");
		inp.value = "";
		inp.disabled = false;
		ligarFiltro();
		ligarPaginacao();
		renderMusicasOffline();
		ligarPlayArtista();

		arAlbuns.todas = albums;
		arAlbuns.pagina = 0;
		renderAlbunsArtista();

		// 6) Aba Playlists
		const plEl = document.getElementById("ar-panel-playlists");
		plEl.innerHTML = playlists.length
			? `<div class="grid">${playlists.map((p, i) => artistPlaylistCardHTML(p, i)).join("")}</div>`
			: '<p style="color: var(--mut)">Nenhuma playlist com faixas deste artista.</p>';
		[...plEl.querySelectorAll(".cv[data-cover-tipo]")].forEach((el) => aplicarCapa(el));

		// 7) Capa do artista
		if (artistaIdParaCapa) {
			capaLocal("artist", artistaIdParaCapa).then((url) => {
				if (url && curArtist === token) {
					document.getElementById("ar-pic").style.backgroundImage = `url("${url}")`;
				}
			});
		}

		aplicarFiltroOffline();
		marcarTocando();
	}
	document.getElementById("ar-pag-albuns-prev")?.addEventListener("click", () => {
		arAlbuns.pagina--;
		renderAlbunsArtista();
	});
	document.getElementById("ar-pag-albuns-next")?.addEventListener("click", () => {
		arAlbuns.pagina++;
		renderAlbunsArtista();
	});



	["t-results", "t-album", "lc-rows", "t-favs", "ex-tracks"].forEach((id) => {
		const el = document.getElementById(id);
		if (!el) return;
		el.addEventListener("click", (e) => {
			const link = e.target.closest(".artist-link");
			if (link) {
			link.dataset.origemView = viewDoLink(id); // "search", "album", "local", "favs", "explore"
			openArtist(link);
			}
		});
	});

	const viewDoLink = (tabelaId) => {
	const map = {
		"t-results": "search",
		"t-artist-top": "artist",
		"t-album": "album",
		"lc-rows": "local",
		"t-favs": "favs",
		"ex-tracks": "explore",   // <-- adicione
	};
	return map[tabelaId] || "search";
	};

	["t-results", "t-artist-top", "t-album", "lc-rows", "t-favs", "ex-tracks"].forEach((id) => {
		const el = document.getElementById(id);
		if (!el) return;
		el.addEventListener("click", (e) => {
			const link = e.target.closest(".album-link");
			if (!link) return;
			const row = link.closest("tr.row");
			const artistaDoLink = link.dataset.artist || "";
			const artistaDoRow = row.querySelector(".t-cv small")?.textContent || "";
			openAlbumData({
				id: link.dataset.albumId,
				title: link.textContent,
				artist: artistaDoLink || artistaDoRow,
				cover:
					(row.querySelector(".t-cv .cv").style.backgroundImage.match(/url\("?(.*?)"?\)/) || [])[1] || "",
				origem: "album-link",
				origemView: viewDoLink(id),
			});
		});
	});

	const arAlbumsEl = document.getElementById("ar-albums");
	if (arAlbumsEl) {
		arAlbumsEl.addEventListener("click", (e) => {
			const card = e.target.closest(".card");
			if (!card || !curArtist) return;
			openAlbumData({
				id: card.dataset.albumId,
				title: card.dataset.title,
				artist: curArtist.name,
				cover: card.dataset.cover,
				origem: "artist",
				origemView: "artist",
			});
		});
	}

	const arPlEl = document.getElementById("ar-panel-playlists");
	if (arPlEl) {
		arPlEl.addEventListener("click", (e) => {
			const card = e.target.closest(".card[data-playlist-local]");
			if (!card) return;
			const titulo = card.dataset.playlistLocal;
			const rel = `Playlists/${titulo}.m3u8`;
			abrirLocal(rel, titulo, "artists");
		});
	}

	/* ==========================================================================
		13. FAVORITOS
		========================================================================== */
	let favsBusy = false;

	async function renderFavs() {
		const tbl = document.getElementById("t-favs");
		if (!tbl) return;

		let ids = [];
		try {
			ids = (backend.favoritesList ? await backend.favoritesList() : []) || [];
		} catch (e) {
			ids = [];
		}
		offFavs.clear();
		ids.forEach((id) => offFavs.add(String(id)));

		if (!ids.length) {
			tbl.innerHTML = linhaVazia(
				"Nenhuma faixa favorita ainda. Clique no ♥ em qualquer tabela para adicionar.",
				7
			);
			marcarTocando();
			return;
		}

		let faixas = [];
		try {
			faixas = await backend.faixas(FAVS_REL);
		} catch (e) {
			faixas = [];
		}

		if (!faixas.length) {
			tbl.innerHTML = linhaVazia("Não foi possível ler o arquivo de favoritos.", 7);
			marcarTocando();
			return;
		}

		tbl.innerHTML = faixas
			.map((f, i) => {
				const sep = f.nome.indexOf(" - ");
				const artista = sep > 0 ? f.nome.slice(0, sep) : "";
				const titulo = sep > 0 ? f.nome.slice(sep + 3) : f.nome;
				const cAttrs = f.albumId ? ` data-cover-tipo="album" data-cover-id="${esc(f.albumId)}"` : "";
				const who = f.artistId
					? `<span class="artist-link" data-artist-id="${esc(f.artistId)}">${esc(artista)}</span>`
					: esc(artista);
				const addPl = f.id
					? `<button class="ibtn pl-add" data-tip="Adicionar à playlist"><svg class="i sm"><use href="#i-plus"/></svg></button>`
					: "";
				return `<tr class="row" data-i="${i + 1}" data-id="${esc(f.id || "")}" data-preview="${esc(f.url)}" data-offline="1">
					${favCellHTML(f.id)}
					<td>${i + 1}</td>
					<td><div class="t-cv"><div class="cv" style="background:${grad(i + 1)}"${cAttrs}></div><div><b>${esc(titulo)}</b><small>${who}</small></div></div></td>
					<td>${esc(f.albumTitle || "")}</td>
					<td><span class="tag d">Deezer</span></td>
					<td>${f.dur > 0 ? fmtT(f.dur) : "--:--"}</td>
					<td><div class="acts">${addPl}<button class="ibtn" data-tip="Tocar"><svg class="i f"><use href="#i-play"/></svg></button></div></td>
					</tr>`;
			})
			.join("");

		[...tbl.querySelectorAll(".t-cv .cv[data-cover-tipo]")].forEach((el) => aplicarCapa(el));
		marcarTocando();
	}

	async function toggleFav(id, btnEl) {
		const fid = String(id || "");
		if (!/^\d+$/.test(fid)) return;
		if (favsBusy) return;

		const ja = offFavs.has(fid);
		if (btnEl) {
			btnEl.classList.add("loading");
			btnEl.disabled = true;
		}

		try {
			if (ja) {
				const r = await backend.favoritesRemove(fid);
				if (!r || !r.ok) throw new Error((r && r.error) || "falha ao remover");
				offFavs.delete(fid);
			} else {
				const r = await backend.favoritesAdd(fid);
				if (!r || !r.ok) throw new Error((r && r.error) || "falha ao adicionar");
				offFavs.add(fid);
				await atualizarOffline();
			}

			document.querySelectorAll(`.fav-btn[data-fav-id="${fid}"]`).forEach((b) => {
				b.classList.toggle("on", offFavs.has(fid));
				b.title = offFavs.has(fid) ? "Remover das mais queridas" : "Adicionar às mais queridas";
			});

			if (document.getElementById("v-favs")?.classList.contains("on")) {
				await renderFavs();
			}
		} catch (e) {
			alert(e.message || "erro ao favoritar");
		} finally {
			favsBusy = false;
			if (btnEl) {
				btnEl.classList.remove("loading");
				btnEl.disabled = false;
			}
		}
	}

	document.addEventListener("click", (e) => {
		const b = e.target.closest(".fav-btn");
		if (!b) return;
		e.stopPropagation();
		toggleFav(b.dataset.favId, b);
	});
/* Badge "Disponível" — clique leva ao item (faixa/álbum/playlist) */
document.addEventListener("click", (e) => {
    const badge = e.target.closest(".tag.s-off");
    if (!badge) return;
    e.stopPropagation();

    const row = badge.closest("tr.row");
    const card = badge.closest(".card");

    // 1) Linha de tabela (busca, álbum, artista, favoritas, local)
    if (row) {
        const tipo = row.dataset.type || "track";
        const id = row.dataset.id || "";

        if (tipo === "album") {
            openAlbumData({
                id,
                title: row.querySelector(".t-cv b")?.textContent || "",
                artist: row.querySelector(".t-cv small")?.textContent || "",
                cover:
                    (row.querySelector(".t-cv .cv")?.style.backgroundImage.match(/url\("?(.*?)"?\)/) || [])[1] || "",
                origem: "search",
            });
            return;
        }
        if (tipo === "playlist") {
            openPlaylist(row);
            return;
        }

        // Faixa: se está na biblioteca local, abre a view da pasta/álbum dela.
        // Caso contrário, abre a página do álbum da faixa (se houver albumId).
        if (row.closest("#t-album, #lc-rows, #t-favs, #t-artist-top")) {
            // já estamos numa lista local — só toca
            if (row.dataset.preview) playRow(row);
            return;
        }
        if (curAlbum && row.closest("#t-album")) {
            if (row.dataset.preview) playRow(row);
            return;
        }
        if (row.dataset.preview) {
            playRow(row);
            return;
        }
        return;
    }

    // 2) Card da biblioteca (álbum ou artista)
    if (card) {
        if (card.dataset.rel) {
            const origem = card.closest("#g-lib-albums") ? "albums" : "playlists";
            abrirLocal(card.dataset.rel, card.querySelector("b")?.textContent || "", origem);
            return;
        }
        if (card.closest("#g-lib-artists")) {
            gArtists?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            card.click();
            return;
        }
        if (card.dataset.albumId) {
            openAlbumData({
                id: card.dataset.albumId,
                title: card.querySelector("b")?.textContent || "",
                artist: card.querySelector("small")?.textContent || "",
                cover: card.dataset.cover || "",
                origem: "artist",
                origemView: "artist",
            });
        }
    }
});


	/* ==========================================================================
		14. ADICIONAR À PLAYLIST (modal unificado)
		========================================================================== */
	const addPlModal = document.getElementById("m-add-pl");
	const addPlListaEl = document.getElementById("m-add-pl-lista");
	const addPlFiltro = document.getElementById("m-add-pl-filtro");
	const addPlNome = document.getElementById("m-add-pl-nome");
	const addPlCriar = document.getElementById("m-add-pl-criar");
	const addPlErro = document.getElementById("m-add-pl-erro");
	const addPlFecharBtn = document.getElementById("m-add-pl-fechar");
	const addPlTitulo = document.getElementById("m-add-pl-titulo");
	const addPlSub = document.getElementById("m-add-pl-sub");
	const bAddPl = document.getElementById("b-add-pl");

	let addPlFaixaId = null;
	let addPlFaixaNome = "";
	let addPlLista = [];

	const addPlFiltrada = () => {
		const f = norm(addPlFiltro?.value || "");
		if (!f) return addPlLista;
		return addPlLista.filter((p) => norm(p.title).includes(f));
	};

	const addPlRenderLista = () => {
		if (!addPlListaEl) return;
		const lista = addPlFiltrada();
		if (!lista.length) {
			addPlListaEl.innerHTML = "";
			return;
		}
		addPlListaEl.innerHTML = lista
			.map(
				(p) => `<div class="pl-item" data-title="${esc(p.title)}">
					<span class="pl-chk">+</span>
					<span class="pl-nome">${esc(p.title)}</span>
					<span class="pl-cont">${p.faixas || 0}</span>
				</div>`
			)
			.join("");
	};

	const addPlCarregar = async () => {
		if (!backend.playlistsList) return;
		try {
			addPlLista = (await backend.playlistsList()) || [];
		} catch (e) {
			addPlLista = [];
		}
		addPlRenderLista();
	};

	const addPlLimparErro = () => {
		if (!addPlErro) return;
		addPlErro.textContent = "";
		addPlErro.classList.remove("on");
	};

	const addPlMostrarErro = (msg) => {
		if (!addPlErro) return;
		addPlErro.textContent = msg;
		addPlErro.classList.add("on");
	};

	let toastTimer = null;
	const mostrarToast = (msg) => {
		const el = document.getElementById("toast");
		if (!el) return;
		el.innerHTML = `<span class="toast-ok">✓</span>${esc(msg)}`;
		el.classList.add("on");
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => el.classList.remove("on"), 2500);
	};

	const addPlAbrir = async (id, nome) => {
		if (!backend.playlistsList || !backend.playlistsAddFaixa) return;
		addPlFaixaId = String(id || "");
		addPlFaixaNome = String(nome || "");
		if (!addPlFaixaId) return;

		if (addPlTitulo) addPlTitulo.textContent = addPlFaixaNome ? `Adicionar "${addPlFaixaNome}"` : "Adicionar à playlist";
		if (addPlSub) addPlSub.textContent = "Escolha uma playlist ou crie uma nova.";
		if (addPlFiltro) addPlFiltro.value = "";
		if (addPlNome) addPlNome.value = "";
		addPlLimparErro();

		addPlModal?.classList.add("on");
		await addPlCarregar();
		setTimeout(() => addPlFiltro?.focus(), 30);
	};

	const addPlFecharModal = () => {
		addPlModal?.classList.remove("on");
		addPlFaixaId = null;
		addPlFaixaNome = "";
		addPlLimparErro();
		if (addPlFiltro) addPlFiltro.value = "";
		if (addPlNome) addPlNome.value = "";
	};

	const addPlAdicionar = async (title) => {
		if (!addPlFaixaId || !backend.playlistsAddFaixa) return false;
		addPlLimparErro();
		try {
			const r = await backend.playlistsAddFaixa(title, addPlFaixaId);
			if (!r || !r.ok) throw new Error((r && r.error) || "falha ao adicionar");
			addPlFecharModal();
			mostrarToast(r.jaExistia ? `Já estava em "${title}"` : `Adicionado a "${title}"`);
			await addPlCarregar();
			carregarBiblioteca();
			return true;
		} catch (e) {
			addPlMostrarErro(e.message || "erro ao adicionar");
			return false;
		}
	};

	const addPlCriarEAdicionar = async () => {
		if (!addPlNome || !addPlFaixaId) return;
		const nome = addPlNome.value.trim();
		if (!nome) {
			addPlMostrarErro("Digite um nome.");
			addPlNome.focus();
			return;
		}

		addPlCriar.disabled = true;
		addPlLimparErro();
		try {
			const c = await backend.playlistsCreate(nome);
			if (!c || !c.ok) throw new Error((c && c.error) || "falha ao criar");
			const add = await backend.playlistsAddFaixa(nome, addPlFaixaId);
			if (!add || !add.ok) throw new Error((add && add.error) || "falha ao adicionar");
			addPlNome.value = "";
			addPlFecharModal();
			mostrarToast(c.jaExistia ? `Adicionado a "${nome}"` : `Playlist "${nome}" criada e faixa adicionada`);
			await addPlCarregar();
			carregarBiblioteca();
		} catch (e) {
			addPlMostrarErro(e.message || "erro ao criar/adicionar");
		} finally {
			addPlCriar.disabled = false;
		}
	};

	document.addEventListener("click", (e) => {
		const b = e.target.closest(".pl-add");
		if (!b) return;
		e.stopPropagation();
		const row = b.closest("tr.row");
		const id = row?.dataset.id || "";
		const nome = row?.querySelector(".t-cv b")?.textContent || "";
		if (id) addPlAbrir(id, nome);
	});

	if (bAddPl) {
		bAddPl.addEventListener("click", (e) => {
			e.stopPropagation();
			if (!curRow?.dataset.id) return;
			const nome = curRow.querySelector(".t-cv b")?.textContent || "";
			addPlAbrir(curRow.dataset.id, nome);
		});
	}

	addPlFiltro?.addEventListener("input", addPlRenderLista);

	addPlListaEl?.addEventListener("click", async (e) => {
		const item = e.target.closest(".pl-item");
		if (!item) return;
		const title = item.dataset.title;
		if (title) await addPlAdicionar(title);
	});

	addPlCriar?.addEventListener("click", addPlCriarEAdicionar);

	addPlNome?.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			addPlCriarEAdicionar();
		} else if (e.key === "Escape") {
			e.preventDefault();
			addPlFecharModal();
		}
	});

	addPlFecharBtn?.addEventListener("click", addPlFecharModal);
	addPlModal?.addEventListener("click", (e) => {
		if (e.target === addPlModal) addPlFecharModal();
	});

	/* ==========================================================================
		14b. NOVA PLAYLIST
		========================================================================== */
	const novaPlModal = document.getElementById("m-nova-pl");
	const novaPlNome = document.getElementById("m-nova-pl-nome");
	const novaPlErro = document.getElementById("m-nova-pl-erro");
	const novaPlOk = document.getElementById("m-nova-pl-ok");
	const novaPlCancel = document.getElementById("m-nova-pl-cancel");

	const novaPlFechar = () => {
		novaPlModal?.classList.remove("on");
		novaPlErro?.classList.remove("on");
		if (novaPlErro) novaPlErro.textContent = "";
	};

	const novaPlAbrir = () => {
		if (!backend.playlistsCreate) return;
		if (novaPlNome) novaPlNome.value = "";
		if (novaPlErro) {
			novaPlErro.textContent = "";
			novaPlErro.classList.remove("on");
		}
		novaPlModal?.classList.add("on");
		setTimeout(() => novaPlNome?.focus(), 30);
	};

	document.getElementById("pl-nova")?.addEventListener("click", novaPlAbrir);
	novaPlCancel?.addEventListener("click", novaPlFechar);

	novaPlOk?.addEventListener("click", async () => {
		if (!novaPlNome || !backend.playlistsCreate) return;
		const nome = novaPlNome.value.trim();
		if (!nome) {
			if (novaPlErro) {
				novaPlErro.textContent = "Digite um nome.";
				novaPlErro.classList.add("on");
			}
			novaPlNome.focus();
			return;
		}

		novaPlOk.disabled = true;
		try {
			const r = await backend.playlistsCreate(nome);

			if (r && r.ok && r.jaExistia) {
				if (novaPlErro) {
					novaPlErro.textContent = `Já existe uma playlist chamada "${nome}".`;
					novaPlErro.classList.add("on");
				}
				novaPlNome.select();
				return;
			}

			if (!r || !r.ok) throw new Error((r && r.error) || "falha ao criar");

			novaPlFechar();
			await carregarBiblioteca();
			mostrarToast(`Playlist "${nome}" criada`);
		} catch (e) {
			if (novaPlErro) {
				novaPlErro.textContent = e.message || "erro ao criar";
				novaPlErro.classList.add("on");
			}
		} finally {
			if (novaPlOk) novaPlOk.disabled = false;
		}
	});

	novaPlNome?.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			novaPlOk?.click();
		} else if (e.key === "Escape") {
			e.preventDefault();
			novaPlFechar();
		}
	});

	novaPlModal?.addEventListener("click", (e) => {
		if (e.target === novaPlModal) novaPlFechar();
	});

	/* ==========================================================================
		15. CONFIGURAÇÕES
		========================================================================== */
	const form = document.getElementById("f-settings");

	const SETTINGS_DEFAULTS = {
		"download.base": "",
		"deezer.arl": "",
		"deezer.quality": "mp3_320",
		"spotify.client_id": "",
		"spotify.client_secret": "",
		"server.host": "127.0.0.1",
		"server.port": "5000",
	};

	function loadSettings(cfg) {
		Object.entries(cfg).forEach(([k, v]) => {
			const el = form.elements[k];
			if (el) el.value = v;
		});
	}
	const getSettings = () => Object.fromEntries(new FormData(form));

	loadSettings(SETTINGS_DEFAULTS);

	form.addEventListener("submit", (e) => {
		e.preventDefault();
		console.log("salvar", getSettings());
		const lbl = document.querySelector("#s-save span");
		lbl.textContent = "Salvo!";
		setTimeout(() => {
			lbl.textContent = "Salvar";
		}, 1500);
	});

	document.getElementById("s-reset").addEventListener("click", () => loadSettings(SETTINGS_DEFAULTS));

	document.querySelectorAll("[data-eye]").forEach((b) =>
		b.addEventListener("click", () => {
			const inp = b.parentElement.querySelector("input");
			const show = inp.type === "password";
			inp.type = show ? "text" : "password";
			b.querySelector("use").setAttribute("href", show ? "#i-eye-off" : "#i-eye");
		})
	);

	document.querySelectorAll("[data-pick]").forEach((b) =>
		b.addEventListener("click", async () => {
			if (!backend.pickBase) return;
			b.disabled = true;
			const res = await backend.pickBase();
			b.disabled = false;
			if (!res.ok) return;
			basePath = res.basePath;
			form.elements[b.dataset.pick].value = basePath;
			carregarBiblioteca();
			initServidor();
		})
	);

	const loginBtn = document.getElementById("s-login");
	const loginMsg = document.getElementById("s-login-msg");

	function pintarStatusConta(status) {
		if (!loginMsg) return;
		if (status === "ok") {
			loginMsg.style.color = "#1db954";
			loginMsg.textContent = "Conectado ✅";
		} else if (status === "expired") {
			loginMsg.style.color = "#ff4d6d";
			loginMsg.textContent = "Sessão vencida — entre de novo";
		} else if (status === "unknown") {
			loginMsg.style.color = "var(--mut)";
			loginMsg.textContent = "Sem conexão com o Deezer (não deu para verificar)";
		} else {
			loginMsg.style.color = "var(--mut)";
			loginMsg.textContent = "";
		}
	}

	async function verificarContaNaTela() {
		if (!backend.deezerRequireSession) return;
		pintarStatusConta("checking");
		try {
			const st = await backend.deezerRequireSession();
			pintarStatusConta(st && st.status ? st.status : "unknown");
		} catch (e) {
			pintarStatusConta("unknown");
		}
	}

	loginBtn.addEventListener("click", async () => {
		if (!backend.deezerLogin) {
			loginMsg.style.color = "#ff4d6d";
			loginMsg.textContent = "Disponível só no app Electron";
			return;
		}
		loginBtn.disabled = true;
		loginMsg.style.color = "var(--mut)";
		loginMsg.textContent = "Faça login na janela do Deezer...";

		const res = await backend.deezerLogin();

		loginBtn.disabled = false;
		if (res.ok) {
			loginMsg.style.color = "#1db954";
			loginMsg.textContent = "Conectado! Servidor reiniciado ✅";
			try { await backend.deezerSessao?.({ forcar: true }); } catch (e) {}
		} else {
			loginMsg.style.color = "#ff4d6d";
			loginMsg.textContent = res.error;
		}
	});

	const checkBtn = document.getElementById("s-check");
	const checkMsg = document.getElementById("s-check-msg");

	checkBtn.addEventListener("click", async () => {
		if (!backend.serverStatus) {
			checkMsg.style.color = "#ff4d6d";
			checkMsg.textContent = "Disponível só no app Electron";
			return;
		}
		checkBtn.disabled = true;
		const st = await backend.serverStatus();
		checkBtn.disabled = false;
		if (st.ready) {
			checkMsg.style.color = "#1db954";
			checkMsg.textContent = "Tudo certo ✅";
		} else if (checarServidor) {
			checkMsg.style.color = "var(--mut)";
			checkMsg.textContent = "Abrindo o passo a passo...";
			checarServidor();
		}
	});

	/* ==========================================================================
		16. BANNER DE "SEM CONEXÃO"
		========================================================================== */
	const bannerEl = document.getElementById("aviso-sessao");
	const bannerTxt = bannerEl ? bannerEl.querySelector("span") : null;
	const bannerBtn = document.getElementById("aviso-sessao-btn");
	let bannerMotivo = "";

	function mostrarBannerOffline(motivo) {
		if (!bannerEl || !bannerTxt) return;
		if (bannerEl.classList.contains("on") && bannerMotivo === motivo) return;
		bannerMotivo = motivo;

		if (motivo === "sessao") {
			bannerTxt.textContent =
				"⚠️ Sua sessão do Deezer venceu. Você pode ouvir e navegar no que já baixou; os downloads vão falhar até entrar de novo.";
			if (bannerBtn) {
				bannerBtn.style.display = "";
				bannerBtn.textContent = "Entrar novamente";
			}
		} else if (motivo === "rede") {
			bannerTxt.textContent =
				"⚠️ Sem conexão com o Deezer. Você pode ouvir e navegar no que já baixou; buscas online e downloads voltam quando a conexão voltar.";
			if (bannerBtn) bannerBtn.style.display = "none";
		} else {
			bannerTxt.textContent =
				"⚠️ Sem conexão com o servidor local. Você pode ouvir e navegar no que já baixou; os downloads vão falhar até o servidor voltar.";
			if (bannerBtn) bannerBtn.style.display = "none";
		}

		bannerEl.classList.add("on");
	}

	function esconderBannerOffline() {
		if (!bannerEl) return;
		bannerEl.classList.remove("on");
		bannerMotivo = "";
	}

	let saudeTimer = null;
	let saudeIntervalo = 30000;
	let falhasSeguidas = 0;

	async function checarSaude() {
		if (!backend.serverStatus) return;
		const st = await backend.serverStatus();
		if (st.ready) {
			falhasSeguidas = 0;
			saudeIntervalo = 30000;
			if (bannerMotivo === "servidor") esconderBannerOffline();
		} else {
			falhasSeguidas++;
			if (falhasSeguidas >= 4 && saudeIntervalo !== 60000) {
				saudeIntervalo = 60000;
			}
			const lib = backend.biblioteca ? await backend.biblioteca().catch(() => null) : null;
			const tem =
				lib &&
				((lib.artists && lib.artists.length) ||
					(lib.albums && lib.albums.length) ||
					(lib.playlists && lib.playlists.length));
			if (tem && bannerMotivo !== "sessao") mostrarBannerOffline("servidor");
		}

		clearTimeout(saudeTimer);
		saudeTimer = setTimeout(checarSaude, saudeIntervalo);
	}

	if (bannerBtn) {
		bannerBtn.addEventListener("click", async () => {
			if (!backend.deezerLogin) return;
			bannerBtn.disabled = true;
			bannerBtn.textContent = "Aguarde...";
			const r = await backend.deezerLogin();
			bannerBtn.disabled = false;
			bannerBtn.textContent = "Entrar novamente";
			if (r && r.ok) esconderBannerOffline();
		});
	}

	let sessaoTimer = null;
	let sessaoOcupado = false;

	function abrirModalLogin() {
		if (typeof checarServidor === "function") {
			checarServidor();
			return;
		}
		document.getElementById("s-login")?.click();
	}
	// ===== Modal de pré-requisitos (#m-docker) =====
	const modalDocker = document.getElementById("m-docker");
	const dockerTitle = document.getElementById("m-docker-title");
	const dockerSub = document.getElementById("m-docker-sub");
	const dockerSteps = document.getElementById("m-docker-steps");
	const dockerMsg = document.getElementById("m-docker-msg");
	const dockerAction = document.getElementById("m-docker-action");
	const dockerActionLabel = document.getElementById("m-docker-action-label");
	const dockerRecheck = document.getElementById("m-docker-recheck");

	let dockerAcao = null; // 'login' | 'start' | null

	function dockerFechar() {
		modalDocker?.classList.remove("on");
		dockerAcao = null;
	}

	async function checarServidor() {
		if (!backend.serverStatus) return;
		if (dockerMsg) dockerMsg.textContent = "";
		if (dockerRecheck) dockerRecheck.disabled = true;

		const st = await backend.serverStatus();
		if (dockerRecheck) dockerRecheck.disabled = false;

		if (st && st.ready) {
			dockerFechar();
			const checkMsg = document.getElementById("s-check-msg");
			if (checkMsg) {
				checkMsg.style.color = "#1db954";
				checkMsg.textContent = "Tudo certo ✅";
			}
			return;
		}

		let titulo = "";
		let sub = "";
		let passos = [];
		let acaoLabel = "";
		let acao = null;

		if (!st || st.engine === "missing") {
			titulo = "Falta o componente de download";
			sub = "O app precisa do Python com o pacote deezer_downloader para baixar.";
			passos = [
				"Feche o app.",
				"Reinstale o Deezer Player (o instalador já traz o Python embutido).",
				"Abra o app de novo.",
			];
		} else if (st.arl !== "saved") {
			titulo = "Falta entrar com o Deezer";
			sub = "O app baixa usando a sua conta Deezer. Entre uma vez para autorizar.";
			passos = [
				"Clique em Entrar com Deezer.",
				"Faça login na janela que abrir.",
				"Volte pro app — o servidor sobe sozinho.",
			];
			acaoLabel = "Entrar com Deezer";
			acao = "login";
		} else if (!st.running) {
			titulo = "O Deezer está desligado";
			sub = "O servidor local está parado. Ligue para poder baixar.";
			passos = [
				"Clique em Ligar o Deezer.",
				"Aguarde alguns segundos.",
				"Verifique de novo.",
			];
			acaoLabel = "Ligar o Deezer";
			acao = "start";
		} else {
			titulo = "O Deezer não respondeu";
			sub = "O servidor está rodando mas não respondeu à verificação.";
			passos = [
				"Clique em Entrar novamente para renovar a sessão.",
				"Se continuar, feche e abra o app.",
			];
			acaoLabel = "Entrar novamente";
			acao = "login";
		}

		if (dockerTitle) dockerTitle.textContent = titulo;
		if (dockerSub) dockerSub.textContent = sub;
		if (dockerSteps) {
			dockerSteps.innerHTML = passos
				.map((p) => `<li>${esc(p)}</li>`)
				.join("");
		}
		if (dockerActionLabel) dockerActionLabel.textContent = acaoLabel || "";
		if (dockerAction) dockerAction.style.display = acao ? "" : "none";
		dockerAcao = acao;
		modalDocker?.classList.add("on");
	}

	dockerRecheck?.addEventListener("click", () => checarServidor());

	dockerAction?.addEventListener("click", async () => {
		if (!dockerAcao) return;
		dockerAction.disabled = true;
		try {
			if (dockerAcao === "login") {
				const r = await backend.deezerLogin?.();
				if (r && r.ok) {
					esconderBannerOffline();
					await checarServidor();
				} else if (dockerMsg) {
					dockerMsg.textContent = (r && r.error) || "login cancelado";
				}
			} else if (dockerAcao === "start") {
				const r = await backend.serverStart?.();
				if (r && r.ready) {
					await checarServidor();
				} else if (dockerMsg) {
					dockerMsg.textContent = (r && r.error) || "não subiu";
				}
			}
		} finally {
			dockerAction.disabled = false;
		}
	});

	modalDocker?.addEventListener("click", (e) => {
		if (e.target === modalDocker) dockerFechar();
	});




	document.getElementById("m-docker-action")?.addEventListener("click", async () => {
		const r = await backend.deezerLogin?.();
		if (r && r.ok) {
			esconderBannerOffline();
			document.getElementById("m-docker")?.classList.remove("on");
			try { await backend.deezerSessao?.({ forcar: true }); } catch (e) {}
			carregarBiblioteca();
		}
	});

	let garantindo = false;
	async function garantirSessao() {
		if (!backend.deezerRequireSession) return true;
		if (garantindo) return false;
		garantindo = true;
		try {
			const st = await backend.deezerRequireSession();
			if (st && st.ok) return true;

			if (st && st.status === "expired") {
				mostrarBannerOffline("sessao");
				abrirModalLogin();
				return false;
			}

			// 'unknown' = rede/gateway. NÃO é sessão vencida.
			// Deixa o download tentar; se falhar, o servidor retorna o erro.
			mostrarBannerOffline("rede");
			return false;
		} finally {
			garantindo = false;
		}
	}

	async function verificarSessao() {
		if (!backend.deezerSessao) return;
		if (sessaoOcupado) return;
		sessaoOcupado = true;
		try {
			const s = await backend.deezerSessao();
			if (s === "expired") {
				mostrarBannerOffline("sessao");
			} else if (s === "unknown") {
				// rede caiu / gateway fora: avisa, mas não fala em "sessão vencida"
				mostrarBannerOffline("rede");
			} else if (s === "ok" && bannerMotivo === "sessao") {
				esconderBannerOffline();
			}
		} finally {
			sessaoOcupado = false;
		}
		clearTimeout(sessaoTimer);
		sessaoTimer = setTimeout(verificarSessao, 60000);
	}

	/* ==========================================================================
		17. JANELA
		========================================================================== */
	document
		.querySelectorAll("[data-win]")
		.forEach((b) => b.addEventListener("click", () => backend.win(b.dataset.win)));

	/* ==========================================================================
		18. MINI PLAYER (modo compactado)
		========================================================================== */
	let modoMini = false;

	function miniSync() {
		const capa = document.getElementById("mp-capa");
		const titulo = document.getElementById("mp-titulo");
		const artista = document.getElementById("mp-artista");

		const row = curRow;
		if (row && row.isConnected) {
			const b = row.querySelector(".t-cv b");
			const small = row.querySelector(".t-cv small");
			const cv = row.querySelector(".t-cv .cv");
			if (titulo) titulo.textContent = b ? b.textContent : "—";
			if (artista) artista.textContent = small ? small.textContent : "—";
			if (capa && cv) capa.style.background = cv.style.background || grad(1);
		} else {
			if (titulo) titulo.textContent = "—";
			if (artista) artista.textContent = "—";
			if (capa) capa.style.background = grad(1);
		}

		if (mpUVol) mpUVol.setAttribute("href", audio.muted || audio.volume === 0 ? "#i-mute" : "#i-vol");
		if (mpTempo) mpTempo.textContent = `${fmtT(audio.currentTime)} / ${fmtT(audio.duration)}`;
		if (mpSeek && audio.duration) {
			mpSeek.value = (audio.currentTime / audio.duration) * 1000;
			fill(mpSeek);
		}
	}

	async function setModoMini(ativo) {
		if (ativo === modoMini) return;
		modoMini = ativo;
		document.body.classList.toggle("modo-mini", ativo);

		if (ativo) {
			miniSync();
			await backend.winCompactar?.();
		} else {
			await backend.winDescompactar?.();
		}
	}

	document.getElementById("b-mini")?.addEventListener("click", () => setModoMini(true));
	document.getElementById("mp-max")?.addEventListener("click", () => setModoMini(false));
	document.getElementById("mp-fechar")?.addEventListener("click", () => backend.win("close"));
	document.getElementById("mp-prev")?.addEventListener("click", () => step(-1));
	document.getElementById("mp-next")?.addEventListener("click", () => step(1));
	document.getElementById("mp-play")?.addEventListener("click", () => {
		if (!audio.src) {
			const tbody =
				document.querySelector(".view.on table.tracks tbody") ||
				document.getElementById("t-results");
			if (tbody) {
				const rows = [...tbody.querySelectorAll("tr.row")].filter((r) => r.dataset.preview);
				if (rows.length) {
					tocarFila(rows.map(montarItem), 0);
					return;
				}
			}
		}
		audio.paused ? safePlay() : audio.pause();
	});

	if (backend.onModoMini) {
		backend.onModoMini((v) => {
			modoMini = v;
			document.body.classList.toggle("modo-mini", v);
			if (v) miniSync();
		});
	}

	/* ==========================================================================
		19. INICIALIZAÇÃO
		========================================================================== */
	initBase();
	checarSaude();
	verificarSessao();
	verificarContaNaTela();
	pollQueue();

	async function initBase() {
		try {
			const cfg = backend.configGet ? await backend.configGet() : null;
			if (cfg && cfg.basePath) {
				const el = document.getElementById("s-base");
				if (el) el.value = cfg.basePath;
			}
		} catch (e) { /* segue */ }
		try {
			await carregarBiblioteca();
		} catch (e) { /* segue */ }

		// abre direto no Explorar e já carrega o conteúdo
			try {
				await carregarExplorar();
			} catch (e) { /* segue */ }




	}

	backend.winEstadoMini?.()
		.then((s) => {
			if (s && s.modoMini) setModoMini(true);
		})
		.catch(() => {});
})();