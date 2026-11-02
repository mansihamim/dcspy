# discord-keep-online (Node.js)

Versi **Node.js** dari `dc3.php` — keep-online akun Discord + status **DND** +
**custom status yang TIDAK hilang walau aplikasi Discord ditutup** +
presence **"Listening to Spotify"** real-time.

> ⚠️ Ini **self-bot** (pakai user token). Self-bot **melanggar ToS Discord** →
> risiko akun di-banned/disabled. Pakai dengan risiko sendiri, jangan akun utama.

---

## 🎮 Dashboard PS5 (on/off + pilih game)

Ada panel web kecil untuk menyalakan/mematikan mode pura-pura main PS5 tanpa
perlu buka `.env` atau restart server:

```
http://<host-panel>:<DASH_PORT>/?k=<DASH_KEY>
```

- **1.501 game PS5** (nama + ikon resmi Discord) dengan pencarian yang juga
  mengenali **alias**: `fifa`, `gta 5`, `re2`, `pubg`, `wedge` tetap ketemu.
- **Game yang belum rilis di PS5** ditandai `released: 0` → di dashboard tampil redup
  berlabel "belum rilis", tidak bisa dipilih, dan ON-nya ditolak (400).
- **Filter tahun**: tombol `Semua · 2026 · 2025 · …` di atas kotak pencarian; daftar
  otomatis diurutkan dari game paling baru. Tiap game punya `year` di `src/ps5.js`
  dan ikut dikirim lewat `/api/games` (plus ringkasan `years`).
- **Panel quest Discord** (lihat bagian di bawah): status & progres quest. Quest layak
  diterima/dikerjakan otomatis; tidak ada tombol "kerjakan semua". Klaim hadiah tetap manual.
- **Wajib pilih game dulu** sebelum bisa ON (kalau belum, tombolnya terkunci).
- ON/OFF berlaku **langsung** — tanpa restart, timer jalan terus.
- Ganti game saat ON juga langsung berlaku (nama + ikon resmi ikut ganti).
- Pilihan disimpan otomatis ke `.env` → tetap terpakai walau server restart.
- Hemat: panel ini **nempel di proses yang sama** (tidak ada proses baru, tidak
  ada port baru, tidak ada dependency baru, ~nol RAM tambahan). Halaman HTML
  dikirim sekali lalu di-cache browser; selanjutnya hanya JSON ~1 KB / 5 detik.
- Ada kunci (`DASH_KEY`). Buka `/?k=KUNCI` sekali → kunci disimpan sebagai cookie.
- **Port tambahan** (`DASH_PORT_EXTRA=80,3000,8080`): dashboard bisa didengar di beberapa port
  sekaligus. Berguna kalau hosting memberi alamat lewat **subdomain** dan meneruskannya ke port
  tertentu, atau kalau port utama tidak bisa dipakai. Port yang gagal (mis. 80 tanpa izin root)
  hanya dicatat sebagai peringatan — port lain tetap jalan.

Alamat yang sedang didengar kelihatan di `/api/status` → `dash.ports`.

Endpoint yang tersedia: `GET /api/status`, `GET /api/games`, `GET /api/resolve?game=`,
`POST /api/on {game}`, `POST /api/off`, `POST /api/game {game}`, `GET /api/quests`,
`POST /api/quest/start {qid}`, `POST /api/quest/auto {on}`, `POST /api/quest/stop`,
`GET /healthz`.

---

## 🏆 Penjalan quest — cara kerjanya (diperbarui 1 Okt)

Runner quest (`src/quest.js`) memakai **endpoint yang sama dengan klien resmi Discord**:

| Langkah | Endpoint | Catatan |
|---|---|---|
| Terima quest | `POST /quests/{id}/enroll` | body `{location:11, is_targeted:false, metadata_raw:null}` — wajib; tanpa ini semua heartbeat ditolak 403 (260000) |
| Main game (desktop) | `POST /quests/{id}/heartbeat` | `{application_id, terminal:false}` tiap **20 detik** selama presence menampilkan aplikasi itu; terakhir `terminal:true` |
| Nonton video | `POST /quests/{id}/video-progress` | `{timestamp}` naik ±7 detik per detik; server hanya menerima sampai (lama sejak diterima + 10 detik); lompatan langsung ditolak HTTP 400 |
| Semua panggilan | header `X-Super-Properties` | **wajib** — tanpa header ini Discord tidak menyajikan quest bertarget/video sama sekali (uji: 0 quest vs 97 quest) |

Penting:
- **Klaim hadiah tetap manual** (Discord meminta captcha) — quest selesai 900/900 lalu muncul di
  Quests/Gift Inventory untuk di-klaim sekali tap.
- Quest jalur konsol (PSN/Xbox) tidak bisa dikerjakan skrip; quest yang punya jalur desktop tetap
  dikerjakan lewat jalur desktop.
- Quest dibedakan jenisnya di dashboard: 🎮 main di PC, 🎬 nonton video.
- `QUEST_OTOMATIS=true` (default) → bot memeriksa berkala dan langsung menerima serta
  mengerjakan semua quest yang layak tanpa klik. `QUEST_AUTO_START=true` adalah opsi tambahan
  untuk memicu satu pemeriksaan saat startup; tidak ada tombol "kerjakan semua" di dashboard.
- **Semua quest dikerjakan SEKALIGUS (paralel)**, bukan antre satu per satu: enroll borongan lalu
  tiap quest punya loop-nya sendiri (desktop: heartbeat 20 detik; video: timestamp naik).
  Uji langsung: 3 quest video selesai di detik yang sama; 3 quest desktop naik bersamaan.
- **Quest TIDAK menyentuh presence/status profil.** Menuntaskan quest cukup dari heartbeat;
  mengganti status adalah jalur terpisah (panel PS5 / Roblox). Perilaku lama bisa dinyalakan
  dengan `QUEST_UBAH_PRESENCE=true` kalau memang diperlukan.
- Quest yang sudah **kedaluwarsa** tidak bisa diakali — Discord menjawab
  `404 Quest has expired` untuk enroll maupun heartbeat (sudah diuji).

| Variable | Default | Keterangan |
|---|---|---|
| `QUEST_AUTO_START` | `false` | pemicu tambahan satu kali saat startup (opsional) |
| `QUEST_OTOMATIS` | `true` | cek, terima, dan kerjakan quest layak otomatis |
| `QUEST_OTOMATIS_MENIT` | `1` | jarak pemeriksaan otomatis (menit) |
| `QUEST_BEAT_SEC` | `20` | jeda heartbeat quest desktop (detik) |

---

## 🌐 Alamat tetap untuk dashboard (tunnel + halaman di Vercel)

Server panel/hosting kadang tidak memberi alamat/port publik, jadi dashboard tidak
bisa dibuka dari HP. Solusinya dua bagian:

1. **Tunnel keluar dari bot** (`src/tunnel.js`): bot menjalankan *Cloudflare Quick
   Tunnel* ke dashboard-nya sendiri (`cloudflared`, diunduh sekali ke `./bin`,
   **bukan** dependency npm). Hasilnya URL HTTPS publik seperti
   `https://xxxx-yyyy.trycloudflare.com` — tanpa perlu port dari hosting dan tanpa
   membuka port baru di server (murni koneksi keluar).
2. **Halaman alamat tetap** (mis. `https://flodismy-dash.vercel.app`): setiap kali URL
   tunnel berubah (bot restart), bot melaporkannya ke halaman itu, jadi kamu cukup
   **bookmark satu alamat** — halaman itu selalu menunjuk ke dashboard yang hidup.

| Variable | Default | Keterangan |
|---|---|---|
| `TUNNEL_ENABLED` | `true` | Nyalakan tunnel keluar. Matikan kalau server sudah punya alamat/port sendiri |
| `TUNNEL_DIR` | `./bin` | Tempat menyimpan `cloudflared` |
| `TUNNEL_LAPOR_URL` | kosong | Endpoint halaman tetap, mis. `https://…vercel.app/api/publish` |
| `TUNNEL_LAPOR_SECRET` | kosong | Rahasia untuk melapor ke endpoint itu |

Catatan jujur: Quick Tunnel gratis (tanpa SLA, URL berubah saat restart — ditangani
halaman tetap), dan kalau server **sudah** punya alamat dari hosting, matikan saja
tunnel-nya (`TUNNEL_ENABLED=false`) dan pakai alamat itu langsung.

---

## 🏆 Penjalan quest Discord (otomatis)

Beberapa quest Discord (mis. "The Hunt") meminta progres desktop/video. Saat
`QUEST_OTOMATIS=true`, bot memeriksa daftar sendiri dan langsung menerima serta
mengerjakan semua quest yang layak secara paralel — tanpa menekan tombol.
Tidak ada tombol "kerjakan semua"; tombol stop hanya tampil saat pekerjaan berjalan.
Klaim hadiah tetap manual di aplikasi Discord bila diminta captcha.

Dashboard menampilkan progres, yang selesai/gagal, serta quest kedaluwarsa (baris
redup + 🚫). Bila perlu, tombol `kerjakan` per quest tetap tersedia untuk tindakan
manual pada satu quest.

### Soal jalur konsol (PlayStation/Xbox) — hasil audit

Hasil audit ke `GET /quests/@me` (30 Sep 2026, 31 quest):

| Bentuk quest | Jumlah | Bisa dikerjakan? |
|---|---|---|
| `PLAY_ON_DESKTOP` saja | 11 | ✅ ya |
| desktop + PlayStation + Xbox | 11 | ✅ ya (lewat jalur desktop) |
| desktop + PlayStation | 7 | ✅ ya (lewat jalur desktop) |
| desktop + Xbox | 2 | ✅ ya (lewat jalur desktop) |
| **hanya konsol (tanpa desktop)** | **0** | — (tidak ada) |

Artinya: **20 quest punya jalur PSN dan 13 punya jalur Xbox, tapi semuanya juga
punya jalur desktop** — dan Discord menerima jalur desktopnya, jadi semuanya tetap
selesai lewat panel. Tidak ada quest yang hilang karena “cuma bisa di PlayStation”.

Kalau nanti muncul quest yang **hanya** jalur konsol, panel akan menandainya
`🚫 dilewati` dengan alasannya. Ini bukan bisa dipaksa: Discord memverifikasi
`PLAY_ON_PLAYSTATION` / `PLAY_ON_XBOX` dari akun PSN/Xbox yang benar-benar
terhubung dan benar-benar main di konsol. Buktinya saat heartbeat quest PSN diuji
langsung dengan app PSN-nya: `HTTP 403 {"code":260000,"message":"User is not
enrolled in the given quest"}` — jalur itu memang bukan untuk sesi desktop.

Begitu juga penanda platform di profil: yang bisa ditiru adalah **aktivitasnya**
(nama game resmi + ikon + timer + `platform: "ps5"` di payload, persis bentuk
aktivitas pemain konsol — sudah dicek balik dari sesi akun sendiri, field itu
disimpan apa adanya oleh Discord). Yang **tidak** bisa ditiru dari sesi desktop
adalah penanda sesi konsolnya (`client_status.embedded` / `client_info.os =
playstation`) — Discord hanya membuatnya untuk sesi konsol asli. Sudah dicoba
IDENTIFY dengan `os` = `PlayStation`, `playstation`, `ps5`, `PS5`, `PlayStation 5`
→ semuanya dipetakan Discord jadi `os: other`, bukan `playstation`. Jadi ikon
perangkat tetap ikon perangkatmu, tapi aktivitas game + ikon game + timer tampil
normal seperti orang sedang main.

Yang perlu kamu tahu (jujur, tanpa janji berlebihan):

- Quest yang **sudah kedaluwarsa** tidak dikerjakan (Discord menolak enroll/heartbeat).
- Quest yang punya jalur desktop/video diproses lewat jalur tersebut; hanya quest
  yang eksklusif membutuhkan konsol asli yang dilewati.
- Runner **tidak mengubah presence/status**. Progres quest dikirim lewat endpoint
  quest; tidak ada game/platform/status yang perlu dipulihkan.
- **Klaim hadiah tetap di aplikasi Discord** (tombol Claim). Endpoint klaimnya
  dijaga captcha (hCaptcha), jadi hadiah tidak bisa diambil dari skrip — kalau ada
  kode (mis. quest Roblox), kodenya ditampilkan di log/panel untuk ditukar manual.
- Quest jalan tanpa env baru: cuma butuh token yang sudah ada. Panel tetap aman
  kalau `DASH_KEY` dipakai — semua endpoint quest butuh kunci sama seperti endpoint lain.

## Apa saja yang dikerjakan

| Fitur | Keterangan |
|---|---|
| Keep online | Connect ke gateway Discord → akun terus online walau app ditutup |
| Status dasar | `online` / `idle` / `dnd` / `invisible` (default `dnd`), tersimpan permanen |
| **Custom status permanen** | Disimpan di setting akun dengan expiry `0` = "Don't clear", jadi tidak hilang walaupun app ditutup, HP restart, atau logout-login |
| Penjaga status | Status diubah di app → kunci status baru. Status dihapus → tetap terhapus (tidak “bangkit” lagi) |
| Roblox "Playing" | Tampil "Playing Roblox" walau main dari HP (`manual`), atau mengikuti game yang benar-benar dimainkan (`auto`) |
| Pura-pura PS5 | Aktivitas "Playing <game PS5>" (1.501 game + ikon resmi), dinyalakan/dimatikan dari dashboard |
| Penjalan quest | Quest desktop/video yang layak diterima & dikerjakan otomatis secara paralel |
| Spotify "Listening" | Judul, artis, album, cover, progress bar — Dealer bila tersedia, polling sebagai fallback |
| Auto reconnect | Heartbeat + watchdog untuk gateway Discord & dealer Spotify |

---

## Kenapa custom status bisa hilang, dan bagaimana ini menyelesaikannya

1. **Status jelas-jelas hilang karena app ditutup**
   Custom status hanya tampil kalau akun terlihat online. Script ini menjaga
   koneksi gateway tetap hidup → akun tetap online → status tetap tampil.
2. **Status dihapus sendiri setelah beberapa jam/hari**
   Aplikasi Discord menyimpan custom status dengan `expires_at_ms` (opsi
   "Clear after: Today / 4 hours"). Script ini menulis ulang status dengan
   `expires_at_ms = 0` → **"Don't clear" / permanen**, langsung di setting
   akun (server Discord), bukan cuma di sesi app.
3. **Status ke-reset kalau app dibuka/tutup atau login di perangkat lain**
   Script memantau event `USER_SETTINGS_PROTO_UPDATE` dari gateway + melakukan
   pengecekan tiap `CUSTOM_STATUS_REFRESH_MIN` menit, lalu memasang kembali
   status kamu.

**Mode "kunci" (default):** kamu tidak perlu mengetik status di file config.
Cukup set custom status seperti biasa di aplikasi Discord (mis. `sibuk, balas
lambat`), jalankan script → status itu otomatis diambil, dikunci, dan dijadikan
permanen (disimpan di `data/status-lock.json`).

**Mode "patok":** isi `CUSTOM_STATUS_TEXT` di `.env` kalau mau script selalu
memaksa satu teks status tertentu (teks ini akan dipasang ulang kalau hilang).

### Aturan penghapusan (penting)

| Yang kamu lakukan di aplikasi Discord | Mode `keep` (default) | Mode `enforce` |
|---|---|---|
| Set status baru | Dikunci & dijadikan permanen | Tetap teks dari config |
| Ubah teksnya | Status baru yang dikunci | Dikembalikan ke teks config |
| **Hapus status** | **Tetap terhapus** (kunci dilepas) | Dipasang ulang |
| Diamkan saja | Permanen, tidak pernah kedaluwarsa | Permanen |

Kalau script sedang mati saat kamu hapus, status juga tidak dibangkitkan lagi
saat script dihidupkan (file kunci ikut dihapus).

---

## Instalasi

Butuh **Node.js 18+**. **Tanpa dependency** — cukup `node index.js`,
tidak perlu `npm install` dan tidak perlu folder `node_modules`
(WebSocket-nya implementasi sendiri di `src/wsclient.js`).

### Termux (Android)

```bash
pkg update && pkg upgrade
pkg install nodejs-lts git
# (opsional) biar tetap jalan walau layar mati
termux-wake-lock

cd ~/discord-keep-online      # folder project ini
cp .env.example .env
nano .env                     # isi DISCORD_TOKEN
node index.js
```

### VPS / PC (Linux)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
cd discord-keep-online
cp .env.example .env && nano .env
node index.js
```

---

## Konfigurasi (`.env`)

| Variable | Default | Keterangan |
|---|---|---|
| `DISCORD_TOKEN` | — | **Wajib.** User token akun Discord (bukan bot token) |
| `STATUS` | `dnd` | `online` / `idle` / `dnd` / `invisible` |
| `DEVICE` | `macos` | Perangkat yang terlihat di profil: `macos` (MacBook), `windows`, `linux`, `web` (Chrome), `android`, `ios` |
| `ENABLE_SPOTIFY` | `true` | Tampilkan lagu Spotify di profil |
| `ROBLOX_ENABLED` | `false` | Tampilkan aktivitas Roblox buatan VPS (nonaktif secara default) |
| `ROBLOX_MODE` | `manual` | `manual` = selalu tampil · `auto` = ikut game yang sedang dimainkan |
| `ROBLOX_NAME` | `ROBLOX` | Nama aktivitas → "Playing <nama>". Pakai `ROBLOX` (kapital) supaya sama persis dengan deteksi asli Discord |
| `ROBLOX_GAME` | kosong | Baris kedua di mode `manual` (mis. nama game) |
| `ROBLOX_USER_ID` | kosong | (mode `auto`) angka dari `roblox.com/users/<angka>/profile` |
| `ROBLOX_COOKIE` | kosong | (mode `auto`) **opsional** — cookie `.ROBLOSECURITY`, hanya kalau deteksi gagal |
| `ROBLOX_POLL_SEC` | `15` | (mode `auto`) interval cek presence Roblox (minimal 15) |
| `ROBLOX_STICKY_MIN` | `0` | (mode `auto`) jendela anti-kedip: aktivitas bertahan sekian menit setelah berhenti main (`0` = langsung hilang) |
| `ROBLOX_SHOW_GAME` | `true` | `true` = tampilkan nama game (ada tanda Rich Presence kecil) · `false` = hanya "Playing ROBLOX" + timer (persis seperti deteksi Roblox asli) |
| `ROBLOX_TIMER_GRACE_MIN` | `10` | Timer "Playing for ..." tidak direset kalau jeda main masih di bawah ini (menit); `0` = reset tiap berhenti |
| `ROBLOX_APP_ID` | `363445589247131668` | ID aplikasi "Roblox" di Discord → agar **logo Roblox resmi** yang tampil (kosongkan untuk mematikan) |
| `SPOTIFY_ACCESS_TOKEN` | kosong | Opsional; kalau kosong diambil otomatis lewat Discord API |
| `CUSTOM_STATUS_ENABLED` | `true` | Aktifkan penjaga custom status |
| `CUSTOM_STATUS_TEXT` | kosong | Kosong = mode kunci otomatis. Isi = patok teks status ini |
| `CUSTOM_STATUS_EMOJI` | kosong | Emoji unicode (`🔥`) atau custom (`nama:123456789012345678`) |
| `CUSTOM_STATUS_MODE` | `keep` | `keep` = permanen tapi hapus tetap bisa · `enforce` = dipaksa selalu ada · `off` = tidak disentuh |
| `CUSTOM_STATUS_NEVER_EXPIRE` | `true` | Ubah "Clear after …" jadi "Don't clear" |
| `CUSTOM_STATUS_REFRESH_MIN` | `10` | Interval pengecekan status (menit) |
| `PRESENCE_CUSTOM_STATUS` | `true` | Sertakan custom status di presence gateway |
| `PERSIST_STATUS` | `true` | Simpan juga pilihan online/idle/dnd di setting akun |
| `PRESENCE_REFRESH_SEC` | `15` | Interval kirim ulang presence (progress bar akurat) |
| `SPOTIFY_POLL_SEC` | `10` | Fallback polling Spotify |
| `SPOTIFY_STALE_SEC` | `90` | Hapus activity jika data playback terlalu lama tidak tervalidasi |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `USER_AGENT` | otomatis | Override User-Agent (default menyesuaikan `DEVICE`) |
| `DEBUG_DEALER` | `false` | Tampilkan pesan mentah dealer.spotify.com |

---

## Aktivitas "Playing Roblox" (walau main di HP)

Discord **tidak bisa** mendeteksi game di HP (batasan iOS/Android), jadi main
Roblox dari HP tidak pernah muncul sebagai aktivitas, dan integrasi resmi
Roblox→Discord juga hanya jalan di PC & game tertentu. Solusinya: script ini
yang mengirim aktivitas "Playing Roblox" ke gateway Discord — dan karena
sesinya terdaftar sebagai **desktop/macOS**, orang lain melihatnya seperti kamu
main dari PC/laptop.

| Mode | Cara kerja | Butuh |
|---|---|---|
| `manual` | "Playing Roblox" tampil **terus** selama script jalan | — |
| `auto` | Mengikuti game asli: "Playing Roblox · Blox Fruits"; aktivitas hilang sendiri setelah berhenti main | `ROBLOX_USER_ID` saja |

### Cara set mode auto

Cukup **satu** nilai: `ROBLOX_USER_ID`.

1. **User ID**: buka profil Roblox-mu — URL-nya `roblox.com/users/123456789/profile`,
   angka itu `ROBLOX_USER_ID`. (Atau ambil otomatis dari koneksi Discord: script
   versi CLI bisa membacanya dari `GET /users/@me/connections`.)
2. Isi di `.env`: `ROBLOX_MODE=auto` + `ROBLOX_USER_ID=...`, lalu restart.

**Cookie tidak wajib.** Presence Roblox (tipe + nama game) bisa dibaca tanpa
login. Kalau browser/akunmu punya setelan privasi ketat dan nama game kosong terus,
baru isi `ROBLOX_COOKIE` (`.ROBLOSECURITY`) sebagai cadangan:

> ⚠️ `.ROBLOSECURITY` = kunci login penuh akun Roblox (bisa dipakai login tanpa
> password & OTP). Simpan hanya di `.env`, jangan pernah kirim ke orang lain.
> Kalau bocor: ganti password Roblox + logout semua sesi. Kalau tidak mau ambil
> risiko, pakai `manual` saja — sudah cukup untuk status "Playing Roblox".

#### Bagaimana nama game dipastikan sama

1. `POST presence.roblox.com/v1/presence/users` → dapat `userPresenceType`
   (0 offline, 1 online, 2 InGame, 3 Studio) + `universeId`/`placeId`.
2. Kalau hanya ada `placeId`: `GET apis.roblox.com/universes/v1/places/<placeId>/universe`.
3. `GET games.roblox.com/v1/games?universeIds=<id>` → **nama resmi game**
   (sama persis dengan yang tampil di situs Roblox).
4. Kalau semua gagal, dipakai `lastLocation` dari presence (kecuali kata umum
   seperti "Website" yang bukan nama game).
5. `ROBLOX_STICKY_MIN` (default `0` = aktivitas langsung hilang begitu keluar Roblox; naikkan
   mis. ke `5` kalau kamu merasa aktivitasnya berkedip-kedip saat pindah game) menjaga aktivitas tidak berkedip saat
   loading/ganti server, lalu hilang sendiri setelah benar-benar berhenti main.

---

## Terlihat online dari PC/laptop (bukan HP)

Indikator di profil Discord (ikon komputer vs ikon hp) ditentukan oleh
`properties` saat IDENTIFY ke gateway + User-Agent yang dipakai. Atur lewat `DEVICE`:

| `DEVICE=` | Yang dilihat orang lain |
|---|---|
| `macos` | Ikon **komputer**, terdaftar sebagai **Mac OS X** (MacBook) |
| `windows` | Ikon komputer, Windows |
| `linux` | Ikon komputer, Linux |
| `web` | Ikon **browser** (Chrome di macOS) |
| `android` / `ios` | Ikon **hp** |

Ganti `DEVICE` di `.env` lalu restart. Script otomatis memakai User-Agent yang
cocok dengan pilihannya (mis. `discord/0.0.310 … Electron/33.2.1` +
`os: "Mac OS X"` untuk `macos`), jadi properties dan User-Agent selalu konsisten.

Catatan: status online di panel "Perangkat yang terhubung" akan berubah setelah
beberapa detik–beberapa menit (Discord menyimpan sesi lama sebentar).

---

## Cara pakai harian

```bash
npm start          # jalankan
npm test           # 16 test (encoder protobuf + penjaga status, pakai API tiruan)
```

Mau **ganti status**? Dua cara:

1. Ganti langsung di aplikasi Discord (mis. jadi `lagi di luar`) → script
   otomatis mendeteksi & menguncinya jadi permanen, atau
2. Ubah `CUSTOM_STATUS_TEXT` di `.env` lalu restart.

**Mematikan script tidak menghapus status** — status tetap tersimpan di akun
(itu justru tujuannya). Mau benar-benar hapus? Set di aplikasi jadi kosong
lalu matikan `CUSTOM_STATUS_ENFORCE`, atau jalankan dengan `CUSTOM_STATUS_ENABLED=false`.

---

## Biar jalan terus 24 jam

**Termux**

```bash
termux-wake-lock
nohup node index.js > dc.log 2>&1 &
tail -f dc.log
```

Matikan penghemat baterai untuk Termux (Settings → Apps → Termux → Battery →
Unrestricted), kalau tidak Android akan mematikan prosesnya.

**VPS/PC — pm2**

```bash
npm i -g pm2
pm2 start index.js --name dc-keep
pm2 save && pm2 startup
```

**VPS/PC — systemd**

```ini
# /etc/systemd/system/dc-keep.service
[Unit]
Description=discord-keep-online
After=network-online.target

[Service]
WorkingDirectory=/root/discord-keep-online
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

---

## Struktur file

```
discord-keep-online/
├── index.js              # entrypoint: rakit semua komponen + shutdown rapi
├── .env.example          # template konfigurasi
├── src/
│   ├── config.js         # baca .env (tanpa dependency)
│   ├── logger.js         # log berlevel + timestamp
│   ├── http.js           # fetch wrapper (timeout, JSON)
│   ├── proto.js          # encoder/decoder protobuf PreloadedUserSettings
│   ├── settings.js       # StatusKeeper: simpan & jaga custom status permanen
│   ├── wsclient.js       # WebSocket RFC 6455 buatan sendiri (tanpa dependency)
│   ├── discord.js        # gateway v9: identify, heartbeat, presence
│   ├── spotify.js        # dealer.spotify.com + metadata + fallback poll
│   ├── roblox.js         # presence Roblox (manual/auto, timer anti-reset)
│   ├── ps5.js            # 1.501 game PS5 + ikon resmi + flag "belum rilis"
│   ├── dashboard.js      # panel web (status, pilih game, panel quest)
│   ├── tunnel.js         # tunnel keluar Cloudflare (alamat publik tanpa port hosting)
│   └── quest.js          # penjalan quest desktop (satu per satu / otomatis)
├── test/
│   ├── proto.test.js     # uji encoder protobuf
│   ├── wsclient.test.js  # uji WebSocket sendiri
│   ├── roblox.test.js    # uji presence Roblox
│   ├── ps5.test.js       # uji tabel game & aturan "belum rilis"
│   ├── quest.test.js     # uji penjalan quest (mode satu + otomatis)
│   ├── dashboard.test.js # uji API dashboard (kunci, game, quest)
│   └── keeper.test.js    # uji penjaga status vs API tiruan
├── data/
│   ├── icons.json        # hash ikon resmi tiap game
│   ├── years.json        # id → tahun rilis
│   └── released.json     # id → 0/1 (belum rilis di PS5)
└── status-lock.json      # dibuat saat jalan
```

### Detail teknis custom status

Custom status disimpan di setting akun (`PreloadedUserSettings`):

```
PreloadedUserSettings
  └─ field 11 : StatusSettings
       ├─ 1 : status             (StringValue "online"|"idle"|"dnd"|"invisible")
       ├─ 2 : custom_status      (CustomStatus)
       │      ├─ 1 : text
       │      ├─ 2 : emoji_id    (fixed64)
       │      ├─ 3 : emoji_name
       │      ├─ 4 : expires_at_ms  ← 0 / kosong = TIDAK PERNAH kedaluwarsa
       │      └─ 5 : created_at_ms
       └─ 4 : status_expires_at_ms
```

Script memakai endpoint `GET/PATCH /api/v9/users/@me/settings-proto/1`
(base64 protobuf). Decoder di `src/proto.js` menulis hanya bagian status dan
**mempertahankan field lain apa adanya**, jadi setting Discord lain tidak rusak.

---

## Troubleshooting

**`Discord: token ditolak / tidak valid`**
Token akun yang tersimpan mendapat penolakan autentikasi. Jangan tempel token di chat
atau mengambilnya dari browser devtools; automasi token akun normal tidak didukung
Discord. Gunakan Discord Desktop/Spotify/PSN resmi untuk aktivitas yang nyata.

**`Tidak ada koneksi Spotify di akun Discord ini`**
Link dulu: Discord → User Settings → Connections → Spotify, lalu restart script.

**Spotify tidak mengikuti lagu baru / judul lama tertahan**
Periksa `/api/status`: `spotify.polling.lastSuccessAt`, `lastStatus`, `lastError`, dan
`tokenError`; Dealer harus punya `fresh=true` atau polling berhasil. Jika `tokenError`
menunjukkan Discord connections HTTP 401, VPS tidak bisa membaca playback terbaru.
Presence lama kini dibersihkan saat autentikasi ditolak atau data terlalu lama stale
(bawaan `SPOTIFY_STALE_SEC=90`). Jangan tempel token di chat; gunakan Discord/Spotify
resmi, karena automasi token akun biasa tidak didukung Discord.

**`Spotify: update real-time tidak tersedia untuk token ini — pakai polling`**
Dealer *connect-state* memang tidak tersedia untuk sebagian kredensial. Bot lalu
menggunakan interval `SPOTIFY_POLL_SEC`; jika responsnya 401, token Discord tidak
bisa mengambil playback dan activity lama akan dihapus. Status `/api/status`
menunjukkan sumber, kesegaran Dealer, hasil poll, dan usia data terakhir.

**`Spotify: /me/player tidak didukung token ini (polling dimatikan)`**
Token tidak punya scope itu → presence Spotify tidak bisa jalan (jarang terjadi;
token dari Discord biasanya punya `user-read-playback-state`).

**Custom status tidak mengikuti aplikasi**
Untuk mode yang sudah dipilih, gunakan `CUSTOM_STATUS_MODE=keep` dan
`CUSTOM_STATUS_NEVER_EXPIRE=true`; mode `keep` tidak memaksa status lama kembali
setelah kamu menghapusnya.
Kalau kamu memang ingin ganti status, ganti dari aplikasi Discord (mode kunci)
atau lewat `CUSTOM_STATUS_TEXT`.

**`Error: Cannot find module 'ws'`**
Tidak akan terjadi lagi di versi ini (WebSocket dibuat sendiri, tanpa `ws`).
Kalau muncul error module lain, pastikan menjalankan dari folder project:
`cd /home/container && node index.js`.

**Server start lalu langsung crash dengan exit code 1**
Cek console: kalau tertulis `DISCORD_TOKEN belum diisi`, isi token di `.env`.
Kalau cuma `node index.js` yang jalan (npm install dilewati), itu **tidak masalah** —
project ini tidak butuh dependency.

**PC/HP restart → script mati, status hilang?**
Status **tidak** ikut hilang (tersimpan di server). Yang hilang hanya efek
online-nya. Pakai pm2/systemd/nohup + `termux-wake-lock` supaya script ikut jalan lagi.

---

## Lisensi & tanggung jawab

Dibagikan apa adanya untuk pembelajaran. Penggunaan self-bot sepenuhnya
tanggung jawab pengguna dan berpotensi melanggar Terms of Service Discord.

## 🎮 "Pura-pura main PS5" (atau konsol lain)

Discord menyimpan aktivitas bersama **field `platform`**. Nilai resminya:
`desktop`, `ps4`, `ps5`, `xbox`, `ios`, `android`, `meta_quest`, `samsung`.
Kalau aktivitas dikirim dengan `platform: "ps5"`, profil Discord menampilkannya
**seperti orang yang benar-benar main di PlayStation 5**.

```env
PS5_ENABLED=true
PS5_GAME=Fortnite        # nama game yang tampil
PS5_PLATFORM=ps5         # ps5 | ps4 | xbox | desktop | ios | android
PS5_TIMER=true           # tampilkan timer "Playing for ..."
PS5_APP_ID=              # (opsional) kosong = otomatis dari daftar game
PS5_DETAILS=             # (opsional) baris kedua
```

Yang terjadi saat aktif:
- Aktivitas yang dikirim: `{ name: "<game>", type: 0, platform: "ps5", application_id: <game> }`
- `application_id` bikin **ikon game aslinya** muncul. **1.501 game** sudah terdaftar
  di `src/ps5.js`, dan **semuanya sudah diverifikasi** langsung ke API Discord:
  aplikasinya ada, namanya cocok, dan punya ikon (hash ikon tidak kosong).
  Artinya ikon yang muncul = ikon resmi yang dipakai Discord sendiri saat
  mendeteksi game itu (identik dengan orang yang main betulan).
- `PS5_OFFICIAL_NAME=true` (default) memakai **nama persis** seperti yang Discord
  simpan (mis. "Returnal™", "DEATH STRANDING") — jadi tampilannya 100% sama.
- Aktivitas Roblox otomatis **dimatikan** (kamu tidak mungkin main dua-duanya).

⚠️ **Batasnya:** ini mengubah tampilan di Discord saja. Trofi/quest yang dicek
Sony (atau Roblox) dari server mereka tidak terpengaruh — mereka tetap tahu
kamu tidak benar-benar online di konsol. Quest Discord yang butuh
`PLAY_ON_DESKTOP` juga tidak ikut terhitung dari mode ini.



---

## 🌍 Scout Orb — country quest scan via Tor (opt-in)

Quest Orb Discord dapat berbeda menurut negara IP. **Scout dinonaktifkan secara
default** setelah audit risiko token/logout. Pilihan yang disarankan adalah token
khusus quest (`QUEST_TOKEN`). Sweep dengan token utama tetap ditolak kecuali pemilik
secara eksplisit mengatur `SCOUT_TOKEN_UTAMA=izin`; mode itu dibatasi 3 negara/putaran,
jeda minimal 8 detik antarnegara, dan cooldown minimal 5 menit antar putaran.

Saat diaktifkan secara sengaja, Scout mengambil daftar exit negara dari Onionoo
dan memverifikasi negara sebelum membaca quest. Temuan ditampilkan di kartu
**Scout Orb**. Bila ada quest yang layak, konfigurasi `SCOUT_AUTO_KERJA=true`
akan meneruskannya ke QuestRunner; klaim hadiah tetap manual.

| hal | perilaku |
|---|---|
| negara | daftar Onionoo segar (cache maksimal 24 jam; cache lama tidak dipakai) |
| rotasi | negara kosong langsung dilewati dalam satu putaran; batas `SCOUT_BURST_MAKS` |
| mode token utama | perlu `SCOUT_TOKEN_UTAMA=izin` secara eksplisit; maksimum 3 negara/putaran, jeda ≥8 detik, dan cooldown ≥5 menit antar putaran |
| jeda | `SCOUT_JEDA_ANTAR_NEGARA` (default 11 detik) untuk batas Tor |
| lalu lintas bot | status/presence/Spotify tidak melewati Tor |
| token ditolak / Tor gagal | scan dijeda; proses utama tetap hidup |

Ada sakelar Scout di dashboard untuk pilihan eksplisit. Perubahan yang diterapkan
di server saat ini tetap OFF; jangan mengaktifkannya kembali tanpa keputusanmu.


---

## 🎯 Halaman QUEST AUTO (dashboard) & Token quest

Dashboard sekarang punya **dua halaman** dengan tombol di atas:
**🎮 PS5 MODE** (status & pilihan game) dan **🎯 QUEST AUTO** (quest, scout, token).

**Token quest** — kartu di halaman QUEST AUTO:

- Default: memakai **token bot** (`DISCORD_TOKEN` di `.env`) — tidak ada yang berubah.
- Bisa **diganti** dengan token Discord lain khusus untuk quest (disimpan sebagai
  `QUEST_TOKEN` di `.env`). Berguna kalau kamu mau quest jalan dari akun lain.
- Ada tombol **🗑 hapus token** untuk kembali ke token bot.
- Token ini **HANYA** dipakai untuk quest: presence/status, PS5, Roblox, dan
  Spotify tetap memakai token bot. Token diverifikasi ke Discord dulu
  (`GET /users/@me`) sebelum disimpan — token salah tidak akan masuk.

## ⚡ Scout keliling cepat + kerja otomatis

- **Saat Scout diaktifkan secara eksplisit:** negara tanpa quest langsung dilewati
  (tidak menunggu 5 menit), dengan batas `SCOUT_BURST_MAKS` (default 10 untuk
  token khusus; maksimal 3 dalam mode hati-hati) dan jeda antar negara.
- **Ketemu = dikerjakan sampai selesai.** Jika Scout diaktifkan dan quest yang
  terlihat hanya muncul dari negara lain, quest itu diteruskan ke QuestRunner
  lewat rute negara tersebut. Scout menunggu pekerjaan selesai sebelum rotasi.
- **Hemat kalau sudah ada.** Kalau quest yang bisa dikerjakan sudah tersedia
  dari IP Indonesia, scout **tidak** keliling sama sekali pada putaran itu.
- **Klaim tetap manual** di aplikasi Discord (klaim otomatis tidak diaktifkan).


---

## ⚡ Serba otomatis — tanpa tombol

- **Quest otomatis (`QUEST_OTOMATIS=true`, default ON).** Tiap
  `QUEST_OTOMATIS_MENIT` menit (default 1) bot memeriksa sendiri:
  kalau ada quest yang bisa dikerjakan — baik yang terlihat dari ID maupun
  yang hanya muncul dari negara lain — **langsung dikerjakan**, dan semua
  quest itu dijalankan bersamaan sampai selesai. Tidak ada tombol yang perlu
  ditekan.
- Pemeriksaan tambahan dijalankan **20 detik setelah semua quest selesai**,
  jadi quest baru yang muncul langsung diambil.
- Tombol **⚡ kerjakan semua otomatis sudah dihapus** dari dashboard. Quest
  baru dikerjakan otomatis; saat pekerjaan aktif hanya tersedia kendali stop.
- **Notifikasi “dilewati” kini menyebut alasan aslinya** (mis. `HTTP 429`),
  dan penerimaan quest (`enroll`) sekarang **dicoba 3× + diverifikasi ulang** —
  dulu satu balasan gagal/limit membuat quest langsung dilewati.
- Kalau token mati (401), otomatis berhenti dengan sopan dan lanjut sendiri
  begitu token diganti.


### Jalur kerja quest lintas negara (perbaikan penting)

- **Pendaftaran (enroll) quest yang terkunci wilayah** memang harus lewat rute
  negara itu (Tor). Kalau didaftarkan langsung, Discord membalas
  `404 Unknown quest` — itu normal.
- **Progres (video-progress / heartbeat) TIDAK perlu lewat Tor**: begitu quest
  sudah terdaftar, laporan progres diterima dari koneksi biasa. Karena itu bot
  sekarang: coba **langsung dulu** (cepat & stabil), dan **otomatis pindah ke
  rute Tor** hanya kalau Discord menolak. Tor yang tadinya dipakai untuk semua
  permintaan (lambat & sering putus) kini dipakai seminimal mungkin.
- Kalau rute gagal di level jaringan, bot **memutar sirkuit Tor** lalu mencoba
  lagi; kalau tetap gagal, alasannya ditulis apa adanya (bukan lagi “HTTP 0”).
- Bug lama yang diperbaiki: `scout.js` membuat rute SOCKS **sebelum** portnya
  diisi → port jadi `NaN` → setiap permintaan quest lewat rute gagal tanpa
  jejak ("HTTP 0"). Sekarang rutenya dibuat *lazy* (membaca port saat dipakai).


---

## 🔄 Rotasi tanpa jeda & serba otomatis (pembaruan terbaru)

- **Scout saat diaktifkan:** negara kosong dilewati tanpa jeda 5 menit; batas
  putaran dan jeda kecil antar negara tetap berlaku. Secara default Scout OFF,
  dan token utama ditolak. Untuk menyalakannya perlu keputusan eksplisit dan
  token quest terpisah.
- Tidak perlu klik untuk pekerjaan otomatis. Quest langsung:
  1. **terlihat oleh scout** → penjalan quest dipicu **saat itu juga**;
  2. **muncul dari ID** → pemantau otomatis mengambilnya tiap **1 menit**;
  3. **selesai semua** → diperiksa ulang **20 detik** kemudian.
- Quest dari negara lain: **daftar (enroll) lewat rute negara itu** (perlu),
  lalu **progres lewat koneksi biasa** (cepat & stabil). Kalau rute gagal,
  bot memutar sirkuit Tor dan mencoba lagi; kalau tetap gagal, alasannya
  ditulis apa adanya.
