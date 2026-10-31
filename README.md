<p align="center">
  <img src="renderer/topo-readme-md.png" alt="Deezer Offline" width="100%">
</p>

<h1 align="center">Deezer Offline</h1>

<p align="center">
  <b>Baixe, organize e ouça sua biblioteca do Deezer no desktop — sem Docker, sem Python instalado.</b>
</p>

<p align="center">
  <a href="https://github.com/israel-nogueira/deezer-downloader/releases/latest/download/deezer-offline-setup.exe">
    <img src="https://img.shields.io/badge/Baixar%20instalador-%C3%BAltimo%20release-a238ff?style=for-the-badge&logo=windows&logoColor=white" alt="Baixar instalador">
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-45-2b2b3c?style=for-the-badge&logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/Runtime-0%20depend%C3%AAncias-3fb950?style=for-the-badge" alt="Zero dependências em runtime">
  <img src="https://img.shields.io/badge/Plataforma-Windows-0078D6?style=for-the-badge&logo=windows11&logoColor=white" alt="Windows">
  <img src="https://img.shields.io/badge/Status-Em%20desenvolvimento-a238ff?style=for-the-badge" alt="Status">
  <img src="https://img.shields.io/badge/Licen%C3%A7a-ISC-4c4c55?style=for-the-badge" alt="Licença">
</p>

---

## 🎧 O que é

O **Deezer Offline** é um app de desktop (Electron) que funciona como um painel completo para baixar e organizar músicas do Deezer. Ele busca faixas, álbuns e playlists, toca preview de 30 segundos, baixa no formato que você escolher e organiza tudo numa biblioteca no disco — com capas, pastas por artista e listas `.m3u8`. E o melhor: funciona **offline** e **não exige Docker nem Python instalado** na sua máquina.

> Feito sobre o [`kmille2/deezer-downloader`](https://github.com/kmille2/deezer-downloader). Precisa de uma conta Deezer.

## ✨ Funcionalidades

<div align="center">

| | |
|:---|:---|
| 🔍 **Busca unificada** | Ache faixas, álbuns e playlists num campo só, com filtros por tipo |
| 🎨 **Páginas de Artista e Álbum** | Top músicas, discografia e capas em alta |
| ▶️ **Preview de 30s** | Ouça antes de baixar, direto no player integrado |
| ⬇️ **Downloads** | Faixa avulsa, álbum inteiro ou playlist, com status em tempo real |
| 🗂️ **Biblioteca organizada** | Pastas por artista, álbuns e playlists — com capas salvas no disco |
| 🎵 **Player completo** | Shuffle, anterior/próxima, repetir, volume e capa local |
| 🏷️ **Selo [offline]** | Veja o que já está no disco sem precisar rebaixar |
| 🔐 **Login seguro** | Sua credencial fica criptografada, nunca em texto puro |

</div>

---

## 🚀 Como conseguir o app

Três caminhos, do mais rápido ao mais completo:

### 1️⃣ Rodar pelo Node

Ideal pra testar e fuçar no código:

```powershell
git clone https://github.com/israel-nogueira/deezer-downloader.git
cd deezer-downloader
npm install
npm start
```

### 2️⃣ Compilar e gerar o instalador

Pra empacotar o app do seu jeito, a partir do código que você acabou de clonar:

```powershell
npm run dist
```

O `electron-builder` gera o instalador em `dist\` — e ele já leva o **motor de download embutido**, então quem instala **não precisa ter Node, Python ou Docker** na máquina.

### 3️⃣ Baixar o `.exe` pronto

Sem clonar nada, apenas baixar instalar e pronto:

<p >
  <a href="https://github.com/israel-nogueira/deezer-downloader/releases/latest/download/deezer-offline-setup.exe">
  <b>⬇️ Baixar o instalador — deezer-offline-setup.exe (136 MB)</b></a>
</p>

--- 

### 🧩 100% standalone em runtime

O app **não usa nenhuma biblioteca de terceiros**: o `package.json` não tem `dependencies`, e o `npm install` traz **apenas ferramentas de desenvolvimento** (Electron e o empacotador) — nenhuma delas entra no app exportado. O código do app é só seu, mais built-ins do Node. Instalou, exportou, pronto.

## 🔒 Sua credencial

O app guarda sua credencial de acesso (ARL) **criptografada** no cofre do próprio sistema operacional (DPAPI do Windows) — nunca em texto puro e nunca em arquivo versionado. Ela é usada apenas para autorizar seus downloads.

## 🗺️ Status

Em desenvolvimento ativo. A busca, os downloads, o player, o login e a organização automática da biblioteca já funcionam. O próximo grande passo é o **empacotamento com instalador** — é ele que publica o primeiro `.exe` em *Releases*.

## 👩‍💻 Para desenvolvedores

Arquitetura, APIs internas, estrutura de arquivos, decisões de produto e as armadilhas conhecidas estão no **[README-DEV.md](README-DEV.md)**.

---

<p align="center">
  Feito com 🎧 e Electron · sobre o <a href="https://github.com/kmille2/deezer-downloader">kmille2/deezer-downloader</a>
</p>
