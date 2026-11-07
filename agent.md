# agent.md — 9router-kiyoshi

Dokumen ini adalah **sumber kebenaran tunggal** untuk seluruh modifikasi, arsitektur, prosedur build, anti-ban, dan aturan kerja di proyek `9router-kiyoshi`.

> **Versi basis**: `v0.6.6` (`9router-plinian`, tag `ba3bec1bd9b4dd70d16d48220383bcb0c81d4b3e`)
> **Repo hulu**: `https://github.com/Azhar457/9router.git`
> **Rebrand**: `9router-kiyoshi` (CLI alias `9router-kiyoshi` + `9router-plinian`)
> **Repo sumber permanen**: `/root/9router-kiyoshi` (git)
> **Deploy terakhir**: 2026-11-07 — Node A build `bl1a6KQsmzYF0s2mHmyzI` (v0.6.6) | **Node B build `bl1a6KQsmzYF0s2mHmyzI` (v0.6.6)**, commit `56d5488e` (diperintahkan Manuel, deploy via proxy tunnel). Keduanya identik.

---

## 0. ATURAN WAJIB SETIAP COMMIT

Setiap kali ada commit baru yang mengubah perilaku, konfigurasi, atau arsitektur proyek ini:

1. **Wajib update file ini (`agent.md`) di commit yang sama atau commit tepat setelahnya.**
2. **Wajib menyertakan commit hash terakhir dan BUILD_ID** pada header dokumen ini:
   ```markdown
   > **Deploy terakhir**: <YYYY-MM-DD> — Node A build `<BUILD_ID>`, commit `<SHORT_HASH>` | Node B: `<BUILD_ID atau "belum di-deploy">`
   ```
3. **Wajib mencatat perubahannya di tabel yang sesuai** (§2-A, B, C, D, E, atau F). Jangan biarkan perubahan hidup hanya di git log.
4. **Dilarang menunda update dokumen ke turn berikutnya.** Commit selesai → `agent.md` di-update → baru melapor ke Manuel.

---

## 1. Topologi Dua Node

### ATURAN DEPLOY (WAJIB)

> **Deploy HANYA ke Node A secara default.**
> Node B **tidak boleh** disentuh kecuali Manuel memerintahkannya secara eksplisit.
> Jangan menyimpulkan "dua node" dari dokumen lama, dari kebiasaan sebelumnya, atau dari fakta bahwa build-nya bisa dikirim. Tunggu perintah.

| | Node A (lokal) | Node B (remote) |
|---|---|---|
| **Boleh deploy?** | **Ya, selalu** | **Hanya bila Manuel menyuruh** |
| Akses | host ini | `root@43.217.113.207` (pw `89895535`) |
| Hostname | `hirohito` | `hirohito` |
| Tunnel | `https://9router.hirohitokiyoshi.web.id` | `https://9router.hirohitokiyoshi.site` |
| Instalasi | `/usr/local/lib/node_modules/9router-plinian` | `/usr/lib/node_modules/9router-plinian` |
| Binari aktif | `/usr/local/bin/9router-kiyoshi` | `/usr/bin/9router-plinian` |
| Port | `0.0.0.0:20128` | `0.0.0.0:20128` |
| Build Node | Node 20 (`/usr/bin/node`) | Tidak pernah build — selalu terima rsync dari Node A |
| Runtime Node | Node 24 (`/usr/local/bin/node`) | Node 24 (`/usr/local/bin/node`) |

Konsekuensi: kedua node bisa berada di BUILD_ID berbeda. Itu **normal dan disengaja**. Saat melapor setelah deploy Node A, sebutkan bahwa Node B masih di build lama dan belum disentuh — jangan diamkan, jangan deploy diam-diam.

### Invariant Node Runtime (WAJIB INGAT)

- **Runtime server wajib Node ≥ 22.5** (saat ini v24.22.1 di `/usr/local/bin/node`). Di Node 20, 9router jatuh ke driver WASM `sql.js` yang memicu `SIGSEGV` (exit 139) setelah ~62 detik idle. Node 24 otomatis mengaktifkan driver C++ native `node:sqlite`.
- **Build Next.js wajib Node 20** (`/usr/bin/node`). Node 24 memiliki bug bus-error di parser SWC saat compile Next 16.3.2.
- **Node B menjalankan binari `/usr/bin/9router-plinian`, BUKAN `9router-kiyoshi`.** Proses supervisor-nya adalah `node /usr/bin/9router-plinian -p 20128 ...`. Kalau dipanggil dengan nama `9router-kiyoshi`, ia tidak jalan karena symlink di Node B mengarah ke plinian.

---

## 2. Daftar Modifikasi Aktif (JANGAN HILANG SAAT UPDATE)

### A. Modifikasi Warisan (Pertahankan Selalu)

| # | File | Fungsi | Tujuan |
|---|---|---|---|
| 1 | `open-sse/executors/codebuddy-intl.js` | `transformRequest()` | Passthrough system/developer prompt milik pemanggil alih-alih ditimpa identitas statis Tencent |
| 2 | `open-sse/executors/codebuddy-cn.js` | `transformRequest()` | Hapus regex `AGENT_PATTERN` dan override prompt netral Tencent |
| 3 | `src/dashboardGuard.js` | `canAccessLocalOnlyRoute()` | Developer tab & CLI tools bisa diakses dari LAN/tunnel (autentikasi JWT/API key tetap wajib) |
| 4 | `src/dashboardGuard.js` | `canAccessPublicLlmApi()` | Fix error `Failed to load models (401)` saat dashboard dibuka lewat Cloudflare tunnel |
| 5 | `src/app/(dashboard)/dashboard/developer/TransparencyClient.js` | `run()` | Fix bug TDZ: `targetModel` dideklarasikan sebelum dibaca |
| 6 | `custom-server.js` (root repo) | `http.createServer` wrapper | Prioritaskan `cf-connecting-ip` untuk deteksi IP asli klien via Cloudflare Tunnel |
| 7 | `open-sse/executors/codebuddy-intl.js` + registry | `buildHeaders()` + transport | WorkBuddy identity + conversation header family (`X-Conversation-ID` UUIDv7, dll — PR #4949) |

### B. Anti-Ban Antigravity (7 Lapis)

| # | File | Fungsi | Tujuan |
|---|---|---|---|
| 8 | `open-sse/services/antigravityHeaderScrub.js` | `scrubProxyAndFingerprintHeaders()` | **L1**: Cabut 24 header bocor (proxy, Chromium, Stainless). `Authorization` paling akhir |
| 9 | `open-sse/services/antigravity429Guard.js` | `fingerprintAntigravityRequest()`, `rememberAntigravity429Refusal()` | **L2**: Stop request-hammering saat prompt ditolak (`429 Resource has been exhausted`). Balas lokal 2–30m, 0 upstream |
| 10 | `open-sse/services/antigravity429Engine.js` | `classify429()`, `decide429()`, `isDurable429()` | **L3**: Klasifikasi 429 (burst, RPM, quota 24h, generic). Quota habis → cooldown 24h, jangan retry ke akun mati |
| 11 | `open-sse/services/antigravityFamilyCooldown.js` | `getFamilyLockCandidates()` | **L4**: Lockout per rumpun (`gemini`, `claude`, `argon`). Kuota Gemini habis tidak mengunci Claude pada akun yang sama |
| 12 | `open-sse/services/antigravityPacing.js` | `isAccountPaced()`, `markAccountRequest()` | **L5**: Pacing 1200ms ±30% jitter per akun. Menghilangkan pola burst paralel ke satu identitas Google |
| 13 | `open-sse/executors/antigravity.js` | `transformRequest()` | **L6**: Kirim `projectId` asli apa adanya. **JANGAN mengarang ID baru** (lihat §2-D) |
| 14 | `src/sse/services/antigravityQuota.js` | `MIN_REFRESH_INTERVAL_MS` | **L7**: Polling kuota diturunkan dari 30 detik ke 5 menit per akun (kurangi 10x traffic otomasi ke Google) |

### C. Fitur Dashboard & Akses

| # | Area | Komponen | Tujuan |
|---|---|---|---|
| 15 | `dashboard/overview/` | `specs/route.js`, `ServerOverviewClient.js` | Menu Server Overview di sidebar: CPU/RAM/Disk, load 1/5/15m, thermals, listening ports, Tailscale/Cloudflare status, uptime |
| 16 | `dashboard/api-keys/` | `AccessKeysClient.js`, `keyAccess.js` | Access Keys: token quota (lifetime/daily), expiry (1d/2d/7d/30d/unlimited), whitelist model per key. 429 kuota, 403 model, 401 expired |
| 17 | `apiKeys.injection` | Kolom DB + UI switch | **Toggle injection per key** — satu switch simpel ON/OFF. NULL dibaca ON |
| 18 | `src/store/themeStore.js` | `globals.css`, `ThemeToggle.js` | **Tiga tema**: Paper (light), Charcoal (dark), AMOLED (true black). Default AMOLED. Theme store v2 dengan auto-migrasi |
| 19 | `globals.css` | CSS tokens | Palet Kiyoshi: forest green (`brand`), brass, warm paper, ink, clay. Skala `clay` didaftarkan di `@theme inline` |
| 20 | `public/favicon.svg` | `src/app/favicon.ico` | Favicon charcoal + forest green, multi-size ico |
| 21 | `dashboard/usage/` | `OverviewCards.js` | Angka penuh tanpa singkatan k/M/B, satu baris, ukuran asli 9Router (`text-lg min-[1440px]:text-xl`), `tracking-[-0.045em]`, `px-2` |
| 22 | `dashboard/usage/` | `ProviderTopology.js` | Topology glow: ring bloom radial-gradient + blur (bukan kotak border), beam 4 lapis, 10 orb + 8 spark |

### D. Perbaikan Kritis Antigravity 2026-11-07 (commit `90152684`)

| # | File | Perubahan | Alasan |
|---|---|---|---|
| 23 | `open-sse/executors/antigravity.js` | `buildUrl()`: model teks **selalu** `streamGenerateContent?alt=sse`; hanya model gambar yang `generateContent` | Non-streaming `generateContent` mengembalikan body yang memicu `502 Invalid JSON response` di setiap `stream:false`. chatCore sudah menangani SSE→JSON untuk klien non-stream |
| 24 | `open-sse/executors/antigravity.js` | `transformRequest()`: `projectId = credentials?.projectId`. **Hapus semua generator** | `loadCodeAssist` mengembalikan `aicode-consumers` untuk SEMUA akun Antigravity — itu project asli mereka, bukan placeholder. Mengarang ID acak membuat Google selalu miss prompt cache (Google key cache pada `(project, model, prefix)`) dan mengirim project asing yang dicurigai bot |
| 25 | `open-sse/translator/request/openai-to-gemini.js` | `projectId = credentials?.projectId \|\| ""` | Menghilangkan pemanggilan generator pada jalur `gemini-cli` dan antigravity |
| 26 | `open-sse/translator/formats/gemini.js` | `generateProjectId()` **dihapus total** | Menghilangkan generator yang berpotensi dipakai lagi |
| 27 | `src/sse/handlers/chat.js` | Gerbang project: tolak lokal 400 bila akun benar-benar tidak punya project | Nol byte ke Google bila akun belum punya project. Jauh lebih aman gagal lokal daripada mengirim project palsu |
| 28 | `open-sse/services/projectId.js` | `isPlaceholderProjectId()`: hanya menolak `test-project`, `project-id`, dan kosong. **`aicode-consumers` DITERIMA** | Menjaga agar project asli tidak dianggap kosong |
| 29 | `open-sse/services/projectId.js` | Negative-cache 5 menit untuk discovery yang gagal | Tanpa ini tiap request mengulang `loadCodeAssist` + `onboardUser` (2 panggilan lambat, hingga 30 detik) |
| 30 | `open-sse/translator/concerns/thinkingUnified.js` | `ensureGeminiOutputFloor(..., { honorClientCap: true })` untuk `gemini-level` | Dulu `max_tokens: 400` dinaikkan paksa ke 65535 → model membakar ribuan token thinking sebelum token pertama keluar (TTFT 20–70s). Sekarang cap klien dihormati |
| 31 | `open-sse/translator/concerns/thinkingUnified.js` | `includeThoughts` **dihilangkan** dari payload kecuali klien meminta reasoning text eksplisit | Thinking text berbagi `maxOutputTokens` dengan jawaban; memintanya tanpa diminta membuat komputasi 2x lipat |
| 32 | `open-sse/rtk/index.js` | `compressGeminiFormat()` untuk `contents[].parts[].functionResponse.response.result` | RTK sebelumnya tidak membaca body Gemini → melaporkan `RTK:0` di Antigravity vs `RTK:15` di CodeBuddy |

### E. Perbaikan Lainnya

| # | File | Tujuan |
|---|---|---|
| 33 | `open-sse/executors/codebuddy-intl.js` + `codebuddy-cn.js` | Fallback `"You are a helpful coding assistant."` bila request tidak membawa system prompt — fix 400 `11128 first message is not system prompt` |
| 34 | `src/lib/db/repos/apiKeysRepo.js` | `getKeyUsageTotals()` menghitung langsung dari `usageHistory` agar total tidak turun saat key dihapus |
| 35 | `src/lib/db/repos/usageRepo.js` | `extractCachedTokens()`: membaca cache dari 4 slot berbeda (`prompt_tokens_details.cached_tokens`, dll). Memperbaiki angka kartu Overview & agregasi harian yang sebelumnya 0 untuk Antigravity |
| 36 | `src/app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js` | `getCachedTokens()`: membaca 4 slot yang sama. Memperbaiki kolom "Cached" di tabel Details yang sebelumnya menampilkan `—` untuk semua baris Antigravity |
| 37 | `open-sse/handlers/chatCore/requestDetail.js` | Progress bar overview: skala `clay` didaftarkan di `@theme inline`, ambang 65%/80% |

### F. Konfigurasi Runtime di Database (`settings.data`)

| Setting | Nilai Benar | Keterangan |
|---|---|---|
| `enableObservability` | **`true`** | **WAJIB.** Jika `false`, tabel `requestDetails` tidak pernah diisi dan tab Request Details di Usage kosong |
| `providerThinking.antigravity.mode` | `xhigh` | Default kita. Turunkan ke `medium`/`low` kalau ingin TTFT lebih cepat (Google menghabiskan waktu pada thinking level tinggi) |
| `rtkEnabled`, `cavemanEnabled`, `ponytailEnabled` | `true` | Token saver tetap aktif walau per-key injection dimatikan |
| `apiKeys.injection` | `1` atau `0` | Nilai `NULL` otomatis dibaca sebagai `1` (ON) |

---

## 3. Detail Kode Kunci (Jangan Sampai Hilang Saat Merge)

### 3.1 `open-sse/executors/antigravity.js` — `buildUrl()`
```js
  buildUrl(model, stream, urlIndex = 0) {
    const baseUrls = this.getBaseUrls();
    const baseUrl = baseUrls[urlIndex] || baseUrls[0];
    const forceNonStream = isImageModel(model);
    const action = forceNonStream ? "generateContent" : "streamGenerateContent?alt=sse";
    return `${baseUrl}/v1internal:${action}`;
  }
```

### 3.2 `open-sse/executors/antigravity.js` — `transformRequest()` (awal)
```js
  transformRequest(model, body, stream, credentials) {
    const projectId = credentials?.projectId;
    // JANGAN tambahkan fallback || generateProjectId(...) atau || this.stableProjectId(...)!
```

### 3.3 `open-sse/services/projectId.js` — `isPlaceholderProjectId()`
```js
const TEST_STUB_PROJECT_IDS = new Set(["test-project", "project-id"]);

export function isPlaceholderProjectId(value) {
    if (typeof value !== "string") return true;
    const trimmed = value.trim().toLowerCase();
    return trimmed === "" || TEST_STUB_PROJECT_IDS.has(trimmed);
}
```

### 3.4 `src/sse/handlers/chat.js` — Gerbang Project ID
```js
    if ((provider === "antigravity" || provider === "gemini-cli") && isPlaceholderProjectId(refreshedCredentials.projectId)) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    if (provider === "antigravity" && !refreshedCredentials.projectId) {
      log.warn("AUTH", `${credentials.connectionName || credentials.connectionId} has no Cloud Code project id — refusing to send a fabricated one`);
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        `[${provider}/${model}] This account has no Google Cloud Code project id. Reconnect the OAuth account and finish Gemini Code Assist onboarding, then retry. No request was sent upstream.`
      );
    }
```

### 3.5 `open-sse/translator/concerns/thinkingUnified.js` — Floor & Thoughts
```js
function ensureGeminiOutputFloor(body, floor, caps, { honorClientCap = false } = {}) {
  const cap = Number.isFinite(caps?.maxOutput) ? caps.maxOutput : floor;
  const target = Math.min(floor, cap);
  const gc = getGeminiGenerationConfig(body);
  const current = Number(gc.maxOutputTokens);
  if (honorClientCap && Number.isFinite(current) && current > 0) return;
  if (!Number.isFinite(current) || current < target) {
    gc.maxOutputTokens = target;
  }
}
```
Dan pada case `"gemini-level"`:
```js
      const wantsThoughts = Boolean(display) && level !== "minimal";
      setGeminiThinking(body, wantsThoughts
        ? { thinkingLevel: level, includeThoughts: true }
        : { thinkingLevel: level });
      ensureGeminiOutputFloor(body, geminiLevelOutputFloor(level), caps, { honorClientCap: true });
```

### 3.6 `open-sse/rtk/index.js` — `compressGeminiFormat()`
```js
  // Gemini / Antigravity format: contents[].parts[].functionResponse
  if (!Array.isArray(body.messages) && !Array.isArray(body.input) && (body.request?.contents || body.contents)) {
    return compressGeminiFormat(body, enabled);
  }
```

### 3.7 `open-sse/translator/request/openai-to-gemini.js`
```js
function wrapInCloudCodeEnvelope(model, geminiCLI, credentials = null, isAntigravity = false) {
  const projectId = credentials?.projectId || "";
```
Dan `wrapInCloudCodeEnvelopeForClaude` juga menggunakan `projectId = credentials?.projectId || ""`.

---

## 4. Alur Build & Deploy Resmi

### A. Build Node A (Lokal)

```bash
cd /root/9router-kiyoshi

# 1. Pastikan source BEKU (tidak boleh diedit selama build jalan)
git status --short

# 2. Build Next.js (WAJIB Node 20)
/usr/bin/npm run build > /tmp/opencode/build.log 2>&1; echo "EXIT=$?"

# 3. Build paket CLI
/usr/bin/node cli/scripts/build-cli.js > /tmp/opencode/cli.log 2>&1; echo "EXIT=$?"

# 4. Sync ke instalasi aktif Node A
DST=/usr/local/lib/node_modules/9router-plinian
cd /root/9router-kiyoshi/cli
rsync -a --delete app/ "$DST/app/"
rsync -a cli.js hooks/ src/ DISCLOSURE LICENSE README.md package.json "$DST/"

# 5. Restart Node A per-PID
PIDS=$(ss -ltnp | grep 20128 | grep -oP 'pid=\K[0-9]+' | tr '\n' ' ')
MAIN=$(ps -ef | grep "9router-kiyoshi -p 20128" | grep -v grep | awk '{print $2}' | tr '\n' ' ')
kill -15 $PIDS $MAIN 2>/dev/null; sleep 3
P2=$(ss -ltnp | grep 20128 | grep -oP 'pid=\K[0-9]+' | tr '\n' ' ')
[ -n "$P2" ] && kill -9 $P2 2>/dev/null; sleep 1
cd "$DST" && nohup /usr/local/bin/node /usr/local/bin/9router-kiyoshi \
  -p 20128 --host 0.0.0.0 --skip-update --no-browser > /tmp/opencode/nodeA.log 2>&1 &
sleep 18; ss -ltnp | grep 20128
```

### B. Deploy ke Node B (Remote — HANYA BILA DIPERINTAHKAN)

> **JANGAN jalankan bagian ini secara otomatis.**
> Tunggu Manuel berkata "deploy node b", "push ke node b", atau perintah serupa.
> Jika tidak ada perintah itu, deploy berhenti di Bagian A.

> **Rute SSH Node B**: port 22 langsung dari Node A (Indosat) sering timeout karena routing transit. Jika SSH langsung gagal, gunakan proxy helper:
> `-o ProxyCommand="/usr/local/bin/node /root/9router-kiyoshi/scripts/ssh/proxy-connect.js %h %p"` (helper ini sudah tersimpan dan permanen).

```bash
# 1. Backup remote
sshpass -p "89895535" ssh -o StrictHostKeyChecking=no root@43.217.113.207 "
TS=\$(date +%Y%m%dT%H%M%S)
tar -czf /root/.9router/backups/pre-update-nodeB-\$TS.tar.gz \
  -C /usr/lib/node_modules 9router-plinian/app 9router-plinian/cli.js \
  9router-plinian/src 9router-plinian/hooks 9router-plinian/package.json
echo BACKUP=\$TS"

# 2. Kirim tarball build dari Node A
cd /root/9router-kiyoshi/cli
tar -czf /tmp/opencode/nodeB-sync.tar.gz app cli.js hooks src DISCLOSURE LICENSE README.md package.json
md5sum /tmp/opencode/nodeB-sync.tar.gz
sshpass -p "89895535" scp -o StrictHostKeyChecking=no /tmp/opencode/nodeB-sync.tar.gz root@43.217.113.207:/root/
sshpass -p "89895535" ssh -o StrictHostKeyChecking=no root@43.217.113.207 "md5sum /root/nodeB-sync.tar.gz"

# 3. Extract & timpa di remote
sshpass -p "89895535" ssh -o StrictHostKeyChecking=no root@43.217.113.207 "
cd /usr/lib/node_modules/9router-plinian
rm -rf /tmp/nb-extract && mkdir -p /tmp/nb-extract
tar -xzf /root/nodeB-sync.tar.gz -C /tmp/nb-extract
rm -rf app && mv /tmp/nb-extract/app ./app
cp -f /tmp/nb-extract/cli.js /tmp/nb-extract/package.json ./
rm -rf src hooks && cp -a /tmp/nb-extract/src /tmp/nb-extract/hooks ./
for f in DISCLOSURE LICENSE README.md; do [ -f /tmp/nb-extract/\$f ] && cp -f /tmp/nb-extract/\$f ./; done
cat app/.next-cli-build/BUILD_ID"

# 4. Restart Node B (GUNAKAN NAMA /usr/bin/9router-plinian)
sshpass -p "89895535" ssh -o StrictHostKeyChecking=no root@43.217.113.207 "
PIDS=\$(ss -ltnp | grep 20128 | grep -oP 'pid=\K[0-9]+' | tr '\n' ' ')
MAIN=\$(ps -ef | grep '9router-plinian -p 20128' | grep -v grep | awk '{print \$2}' | tr '\n' ' ')
kill -15 \$PIDS \$MAIN 2>/dev/null; sleep 3
P2=\$(ss -ltnp | grep 20128 | grep -oP 'pid=\K[0-9]+' | tr '\n' ' ')
[ -n \"\$P2\" ] && kill -9 \$P2 2>/dev/null; sleep 1
cd /usr/lib/node_modules/9router-plinian
nohup /usr/local/bin/node /usr/bin/9router-plinian -p 20128 --host 0.0.0.0 --skip-update --no-browser > /tmp/9router-nb.log 2>&1 &
sleep 18; ss -ltnp | grep 20128"

# 5. Bersihkan file sementara di remote
sshpass -p "89895535" ssh root@43.217.113.207 "rm -rf /root/nodeB-sync.tar.gz /tmp/nb-extract /tmp/9router-nb.log"
```

### C. Aturan Disiplin Build

1. **Source WAJIB BEKU selama build.** Jangan mengedit file apa pun setelah perintah `npm run build` dijalankan. Jika ada bug yang disadari saat build jalan: matikan prosesnya dulu (`kill -9`), edit, verifikasi sintaks, baru build ulang.
2. **Verifikasi sebelum build**: `node --check` semua file yang diubah.
3. **Satu build, satu deploy.** Jangan deploy build usang.

---

## 5. Verifikasi Wajib Setelah Deploy

Jalankan rangkaian pengecekan ini di terminal:

```bash
# 1. BUILD_ID harus identik di kedua node
cat /usr/local/lib/node_modules/9router-plinian/app/.next-cli-build/BUILD_ID
sshpass -p "89895535" ssh root@43.217.113.207 "cat /usr/lib/node_modules/9router-plinian/app/.next-cli-build/BUILD_ID"

# 2. Tunnel kedua node harus HTTP 200
curl -s -o /dev/null -w "Node A: %{http_code}\n" https://9router.hirohitokiyoshi.web.id/login
curl -s -o /dev/null -w "Node B: %{http_code}\n" https://9router.hirohitokiyoshi.site/login

# 3. Non-streaming Antigravity HARUS HTTP 200 (bukan 502)
curl -s -m 90 -X POST http://127.0.0.1:20128/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sk-c310cadaaa14eda2-uxdag5-17815236' \
  -d '{"model":"ag/gemini-3.8-flash","messages":[{"role":"user","content":"say ok"}],"stream":false,"max_tokens":60}' \
  -w "\nHTTP: %{http_code} | time: %{time_total}s\n"

# 4. Project ID tidak boleh ada yang dikarang (semua harus aicode-consumers atau project GCP asli)
/usr/local/bin/node -e "
const db=require('node:sqlite');const s=new db.DatabaseSync('/root/.9router/db/data.sqlite');
for (const r of s.prepare(\"SELECT email,data FROM providerConnections WHERE provider='antigravity' AND isActive=1\").all()) {
  const d=JSON.parse(r.data||'{}'); console.log((r.email||'?').padEnd(28), 'projectId=' + (d.projectId||'-'));
}"

# 5. Tabel requestDetails harus terisi request baru (bukan mentok di 16 Oktober)
/usr/local/bin/node -e "
const db=require('node:sqlite');const s=new db.DatabaseSync('/root/.9router/db/data.sqlite');
console.log('newest detail:', s.prepare('SELECT timestamp,provider,model,status FROM requestDetails ORDER BY timestamp DESC LIMIT 1').get());
console.log('observability:', JSON.parse(s.prepare('SELECT data FROM settings WHERE id=1').get().data).enableObservability);"
```

---

## 6. Perlindungan Database

Database `/root/.9router/db/data.sqlite` adalah jantung sistem (kredensial akun, prompt injection, API keys, usage).

- **Build dan swap TIDAK PERNAH menyentuh `/root/.9router/db/`.** Swap hanya mengganti direktori modul di `/usr/local/lib/node_modules/9router-plinian/`.
- **Wajib backup sebelum operasi yang menyentuh DB**: gunakan selalu API `sqlite3.backup()` Python karena mode WAL aktif (jangan `cp` mentah):
  ```bash
  python3 - <<'PY'
  import sqlite3
  src = sqlite3.connect('/root/.9router/db/data.sqlite')
  dst = sqlite3.connect('/root/.9router/backups/data-backup.sqlite')
  src.backup(dst); src.close(); dst.close()
  print("DB backup OK")
  PY
  ```
- Kolom `providerConnections` yang berubah saat server hidup adalah hal normal (refresh `accessToken` dan `expiresAt`).

---

## 7. Prosedur Update Hulu (Ketika 9router-plinian Rilis Versi Baru)

**Prinsip dasar**: Repo lokal `/root/9router-kiyoshi` adalah sumber kebenaran. Update hulu dilakukan dengan melakukan merge/rebase modifikasi kita di atas versi baru hulu, bukan menimpa repo lokal dengan file hulu.

### Langkah 1 — Buat Snapshot Cadangan
```bash
cd /root/9router-kiyoshi
git tag pre-upstream-$(date +%Y%m%d)
git branch backup-pre-upstream-$(date +%Y%m%d)
```

### Langkah 2 — Ambil Update Hulu
```bash
git remote add upstream https://github.com/Azhar457/9router.git 2>/dev/null || true
git fetch upstream --tags
git log --oneline HEAD..upstream/<TAG_BARU> | head -40
```

### Langkah 3 — Merge & Selesaikan Konflik Mengacu ke §2
```bash
git merge upstream/<TAG_BARU>
```

Jika terjadi konflik, **jadikan Bagian 2 dan Bagian 3 di dokumen ini sebagai acuan perilaku yang harus menang**. File yang paling sering bentrok:

1. `open-sse/executors/antigravity.js` → `buildUrl()` wajib selalu SSE untuk teks, `transformRequest()` wajib hanya membaca `credentials.projectId` tanpa generator.
2. `open-sse/translator/concerns/thinkingUnified.js` → `ensureGeminiOutputFloor` wajib mempertahankan cap klien, `includeThoughts` wajib dihilangkan kecuali klien meminta reasoning text.
3. `open-sse/translator/request/openai-to-gemini.js` → `projectId = credentials?.projectId || ""` (tanpa generator).
4. `open-sse/rtk/index.js` → blok `compressGeminiFormat()` wajib ada.
5. `src/sse/handlers/chat.js` → pengecekan `isPlaceholderProjectId()` dan penolakan lokal 400 bila akun tidak punya project id.
6. `src/lib/db/repos/apiKeysRepo.js` → `getKeyUsageTotals()` wajib menghitung dari `usageHistory`.
7. `src/store/themeStore.js` + `globals.css` → tema tiga mode (Paper, Charcoal, AMOLED) dan palet Kiyoshi.

### Langkah 4 — Verifikasi Sintaks & Regression Gate Sebelum Build
```bash
# 1. Cek sintaks
for f in $(git diff --name-only | grep -E '\.js$'); do
  /usr/local/bin/node --check "$f" || echo "SYNTAX FAIL: $f"
done

# 2. Pastikan TIDAK ADA generator project yang kembali masuk
grep -rn "generateProjectId\|stableProjectId" --include=*.js open-sse src | grep -v node_modules && echo "GAGAL: generator project muncul lagi!"

# 3. Pastikan model teks tetap memakai endpoint stream
grep -n "forceNonStream ? \"generateContent\"" open-sse/executors/antigravity.js || echo "GAGAL: buildUrl Antigravity salah!"

# 4. Pastikan aicode-consumers tetap diterima sebagai project valid
grep -n "TEST_STUB_PROJECT_IDS" open-sse/services/projectId.js || echo "GAGAL: placeholder check salah!"
```

### Langkah 5 — Build & Deploy Sesuai §4
Setelah semua verifikasi lolos, jalankan build dan deploy sesuai Bagian 4-A (Node A) dan 4-B (Node B).

### Langkah 6 — Verifikasi Runtime Pasca-Update
1. Cek flag `enableObservability` di DB tetap `true`.
2. Tes Antigravity non-streaming: harus HTTP 200 (bukan 502).
3. Tes toggle injection di Access Keys: mode ON menghasilkan prefix `[@an0ym on telegram]`, mode OFF menghasilkan jawaban polos.
4. Buka dashboard: tema AMOLED aktif, angka usage satu baris tanpa singkatan, topology menyala.
5. Jalankan regression gate §7 lalu update baris header `> **Deploy terakhir**` di `agent.md` dengan commit hash dan BUILD_ID baru.
