# Panduan Modifikasi Lokal — 9router-kiyoshi (VPS Hirohito)

> **Versi basis**: `v0.6.4` (berbasis `9router-plinian` / commit tag `1bd64c504f4b1e4e4fbcb35c4872e29653d5edf8` + commit `dd19bda`)
> **Repo hulu**: `https://github.com/Azhar457/9router.git`
> **Rebrand**: `9router-kiyoshi` (CLI alias `9router-kiyoshi` + `9router-plinian`)
> **Deploy terakhir**: 2026-11-05 — Anti-Ban Antigravity Suite + Server Overview Page + Rebrand diterapkan di **dua node**.

## Topologi Dua Node

| | Node A (lokal) | Node B (remote) |
|---|---|---|
| Akses | host ini | `root@43.217.113.207` (pw `89895535`) |
| Hostname | `hirohito` | `hirohito` |
| Tunnel | `https://9router.hirohitokiyoshi.web.id` | `https://9router.hirohitokiyoshi.site` |
| Instalasi | `/usr/local/lib/node_modules/9router-plinian` | `/usr/lib/node_modules/9router-plinian` |
| Binari | `/usr/local/bin/9router-kiyoshi` (+ `/usr/bin/` symlink) | `/usr/local/bin/9router-kiyoshi` (+ `/usr/bin/` symlink) |
| Alias lama | `/usr/local/bin/9router-plinian` | `/usr/bin/9router-plinian` |
| Backup pre-antiban | `/root/.9router/backups/pre-antiban-20261105T033921` | `/root/.9router/backups/pre-antiban-20261105T040425` |
| Build Node | Node LTS v20.20.2 (`/usr/bin/node`) | Diterima via rsync dari Node A |
| Runtime Node | Node v24.22.1 (`/usr/local/bin/node`) | Node v24.22.1 (`/usr/local/bin/node`) |

> **Catatan penting Node Runtime**: 9router v0.6.4 wajib dijalankan di bawah **Node >= 22.5** (saat ini v24.22.1) agar otomatis memakai driver native C++ `node:sqlite`. Pada Node 20, ia jatuh ke driver WASM `sql.js` yang memicu `SIGSEGV` (exit 139) setelah ~62 detik idle. Untuk proses **build Next.js** tetap gunakan Node 20 (`/usr/bin/node`) untuk menghindari bug SWC bus-error.

---

## 0. Ringkasan Modifikasi (10 Modifikasi Aktif)

### A. Modifikasi Warisan (Pertahankan Selalu)

| # | File | Fungsi | Tujuan |
|---|------|--------|--------|
| 1 | `open-sse/executors/codebuddy-intl.js` | `transformRequest()` | Passthrough caller system prompt (CodeBuddy International) |
| 2 | `open-sse/executors/codebuddy-cn.js` | `transformRequest()` | Hapus override prompt netral Tencent |
| 3 | `src/dashboardGuard.js` | `canAccessLocalOnlyRoute()` | Developer tab & CLI tools bisa diakses dari LAN/Tunnel |
| 4 | `src/dashboardGuard.js` | `canAccessPublicLlmApi()` | Fix error `Failed to load models (401)` lewat tunnel |
| 5 | `src/app/(dashboard)/dashboard/developer/TransparencyClient.js` | `run()` | Fix bug TDZ `Cannot access 'r' before initialization` |
| 6 | `custom-server.js` (root repo) | `http.createServer` wrapper | Prioritas `cf-connecting-ip` untuk deteksi IP via Cloudflare Tunnel |
| 7 | `open-sse/executors/codebuddy-intl.js` + registry | `buildHeaders()` + transport | WorkBuddy identity + `X-Conversation-*` family (PR #4949) |

### B. Modifikasi Baru (2026-11-05): Anti-Ban Antigravity + Features

| # | File | Modul / Fungsi | Tujuan |
|---|------|----------------|--------|
| 8 | `open-sse/services/antigravityHeaderScrub.js` | `scrubProxyAndFingerprintHeaders()` | **Anti-Ban L1**: Cabut 24 header bocor (proxy, Chromium, Stainless). Tunda `Authorization` agar jadi header paling akhir, emulasi native Node client Antigravity. |
| 9 | `open-sse/services/antigravity429Guard.js` | `fingerprintAntigravityRequest()`, `rememberAntigravity429Refusal()` | **Anti-Ban L2**: Stop request-hammering ke Google saat prompt ditolak (`429 Resource has been exhausted`). Balas lokal dari memori 2–30m, 0 upstream calls. |
| 10 | `open-sse/services/antigravity429Engine.js` | `classify429()`, `decide429()` | **Anti-Ban L3**: Klasifikasi 429 ke 4 tipe (burst, RPM, 24h quota, generic). Quota habis → 24h cooldown, cegah spam ke akun mati. |
| 11 | `open-sse/services/antigravityFamilyCooldown.js` | `getFamilyLockCandidates()` | **Anti-Ban L4**: Lockout per rumpun (`gemini`, `claude`, `argon`). Kuota Gemini habis tidak lagi mengunci Claude/Argon pada akun yang sama. |
| 12 | `open-sse/services/antigravityPacing.js` | `isAccountPaced()`, `markAccountRequest()` | **Anti-Ban L5**: Pacing 1200ms ±30% jitter per-akun. Hapus pola burst paralel ke satu identitas Google. |
| 13 | `open-sse/executors/antigravity.js` | `transformRequest()` | **Anti-Ban L6**: Tolak projectId placeholder (`aicode-consumers`), pakai ID asli per-akun, lepas keterkaitan antar akun. |
| 14 | `src/sse/services/antigravityQuota.js` | `MIN_REFRESH_INTERVAL_MS` | **Anti-Ban L7**: Polling kuota diturunkan dari 30 detik ke 5 menit per akun (kurangi 10x traffic otomasi ke Google). |
| 15 | `src/app/(dashboard)/dashboard/overview/` + `/api/overview/specs/` | Full-stack server monitor | **Feature**: Menu Server Overview di sidebar — spek CPU/RAM/Disk, load 1/5/15m, thermals, listening ports (local/public), Tailscale/Cloudflare status, uptime, OS/kernel info, auto-refresh 5s. Responsif terhadap tema (Aurora Violet dark/light). |
| 17 | `open-sse/services/antigravity*` + `src/sse/services/keyAccess.js` | Access Keys & quota | **Feature**: halaman Access Keys (`/dashboard/api-keys`) — kelola API key dengan token quota (lifetime/daily), expiry (1d/2d/7d/30d/unlimited), dan pembatasan model per key. Enforcement 429 saat kuota habis, 403 saat model tidak diizinkan, 401 saat key kedaluwarsa. Usage per key (total/hari/requests) dihitung live dari `usageHistory`. |

> **Patch gabungan siap pakai**:
> - `/root/9router-mods-doc/vps-custom-modifications-0.6.4-latest.patch` — **kumulatif** dari tag hulu `v0.6.4` (265 file, termasuk rebrand source + Access Keys). Pakai ini untuk rebuild dari nol.
> - `/root/9router-mods-doc/accesskeys-and-source-rebrand-0.6.4.patch` — delta khusus fitur Access Keys + rebrand source.
> - `/root/9router-mods-doc/vps-custom-modifications-0.6.4-antiban.patch` — versi lama (sebelum Access Keys), dipertahankan sebagai arsip.
>
> **Repo sumber permanen**: `/root/9router-kiyoshi` (git, sudah ter-commit). Semua modifikasi ada di sini — rebuild kapan saja tanpa patch.

---

## 1. Alur Build & Deploy (TL;DR)

### A. Rebuild Cepat dari Repo Lokal (Direkomendasikan)

Repo permanen sudah ada di `/root/9router-kiyoshi` lengkap dengan semua modifikasi:

```bash
cd /root/9router-kiyoshi

# 1. Pastikan dependency terpasang (gunakan Node 20)
/usr/bin/npm install --no-audit --no-fund
/usr/bin/npm install --no-audit --no-fund next@16.3.2 @aws-sdk/credential-providers @aws-sdk/client-bedrock-runtime

# 2. Build Next.js CLI
/usr/bin/npm --prefix cli run build

# 3. Swap ke instalasi aktif (Node A)
DST=/usr/local/lib/node_modules/9router-plinian
SRC=/root/9router-kiyoshi/cli

# Hentikan proses per-PID
for p in $(pgrep -f "9router" 2>/dev/null); do kill -9 "$p" 2>/dev/null || true; done
for p in $(pgrep -f "next-server" 2>/dev/null); do kill -9 "$p" 2>/dev/null || true; done
sleep 2; fuser -k -9 20128/tcp 2>/dev/null || true; sleep 2

rm -rf "$DST/app"
cp -a "$SRC/app" "$DST/app"
cp "$SRC/cli.js" "$DST/cli.js"
cp "$SRC/package.json" "$DST/package.json"
ln -sfn /root/9router-kiyoshi/node_modules "$DST/app/node_modules"
chmod +x "$DST/cli.js"

# Start dengan Node 24
setsid bash -c 'exec /usr/local/bin/node /usr/local/bin/9router-kiyoshi -p 20128 --host 0.0.0.0 --skip-update --no-browser \
  > /tmp/opencode/9router-runtime.log 2>&1' < /dev/null > /dev/null 2>&1 &
```

### B. Rebuild dari Nol (Fresh Clone + Patch)

```bash
mkdir -p /tmp/opencode && cd /tmp/opencode
rm -rf 9router-src
git clone https://github.com/Azhar457/9router.git 9router-src
cd 9router-src
git checkout tags/v0.6.4 -b build-kiyoshi

# Terapkan patch kumulatif terbaru
git apply /root/9router-mods-doc/vps-custom-modifications-0.6.4-latest.patch

# 3. Install dependency (WAJIB urut dan gunakan Node 20)
/usr/bin/npm install --no-audit --no-fund
/usr/bin/npm install --no-audit --no-fund next@16.3.2   # PIN WAJIB
/usr/bin/npm install --no-audit --no-fund @aws-sdk/credential-providers @aws-sdk/client-bedrock-runtime
cd cli && /usr/bin/npm install --no-audit --no-fund && cd ..

# 4. Verifikasi sintaks
node --check src/app/api/overview/specs/route.js
node --check open-sse/executors/antigravity.js
node --check open-sse/services/antigravityHeaderScrub.js
node --check open-sse/services/antigravity429Guard.js
node --check open-sse/services/antigravity429Engine.js
node --check open-sse/services/antigravityFamilyCooldown.js
node --check open-sse/services/antigravityPacing.js
node --input-type=module --check < src/dashboardGuard.js
node --input-type=module --check < src/sse/handlers/chat.js
node --input-type=module --check < src/sse/services/auth.js

# 5. Build (via setsid, 2–4 menit)
rm -f /tmp/opencode/build.log
setsid bash -c 'cd /tmp/opencode/9router-src && /usr/bin/npm --prefix cli run build > /tmp/opencode/build.log 2>&1; echo "EXIT=$?" >> /tmp/opencode/build.log' < /dev/null > /dev/null 2>&1 &

# Pantau build sampai EXIT=0
while pgrep -f "next build" >/dev/null; do sleep 5; done
grep "EXIT=0" /tmp/opencode/build.log && echo "BUILD SUKSES"
```

### Backup SEBELUM Swap

```bash
TS=$(date +%Y%m%dT%H%M%S)
BK=/root/.9router/backups/pre-upgrade-$TS
mkdir -p "$BK"
python3 - "$BK" <<'PY'
import sqlite3, sys, os
bk = sys.argv[1]
src = sqlite3.connect('/root/.9router/db/data.sqlite')
dst = sqlite3.connect(os.path.join(bk, 'data.sqlite'))
src.backup(dst); src.close(); dst.close()
print("sqlite snapshot ok")
PY
cp -a /usr/local/lib/node_modules/9router-plinian "$BK/9router-install"
[ -f /root/.9router/jwt-secret ] && cp -a /root/.9router/jwt-secret "$BK/"
[ -f /root/.9router/machine-id ] && cp -a /root/.9router/machine-id "$BK/"
echo "Backup di $BK"
```

### Swap & Restart (Node A - Lokal)

```bash
DST=/usr/local/lib/node_modules/9router-plinian
SRC=/tmp/opencode/9router-src/cli

# Hentikan proses lama per-PID (JANGAN pkill -f pattern yang cocok dengan shell sendiri)
for p in $(pgrep -f "^node /usr/bin/9router" 2>/dev/null); do kill -9 "$p" 2>/dev/null || true; done
for p in $(pgrep -f "^node /usr/local/bin/9router" 2>/dev/null); do kill -9 "$p" 2>/dev/null || true; done
for p in $(pgrep -f "next-server" 2>/dev/null); do kill -9 "$p" 2>/dev/null || true; done
sleep 2
fuser -k -9 20128/tcp 2>/dev/null || true
sleep 2

rm -rf "$DST/app"
cp -a "$SRC/app" "$DST/app"
cp "$SRC/cli.js" "$DST/cli.js"
cp "$SRC/package.json" "$DST/package.json"
cp "$SRC/README.md" "$DST/README.md"
cp "$SRC/DISCLOSURE" "$DST/DISCLOSURE"
rm -rf "$DST/hooks" "$DST/src"
cp -a "$SRC/hooks" "$DST/"
cp -a "$SRC/src" "$DST/"
chmod +x "$DST/cli.js"

# Symlinks untuk 9router-kiyoshi + fallback 9router-plinian
ln -sf "$DST/cli.js" /usr/local/bin/9router-kiyoshi
ln -sf "$DST/cli.js" /usr/local/bin/9router-plinian
ln -sf /usr/local/bin/9router-kiyoshi /usr/bin/9router-kiyoshi
ln -sf /usr/local/bin/9router-plinian /usr/bin/9router-plinian

# Jalankan di bawah Node 24 (driver node:sqlite aktif)
rm -f /tmp/opencode/9router-runtime.log
setsid bash -c 'exec /usr/local/bin/node /usr/local/bin/9router-kiyoshi -p 20128 --host 0.0.0.0 --skip-update --no-browser \
  > /tmp/opencode/9router-runtime.log 2>&1' < /dev/null > /dev/null 2>&1 &
sleep 8
ss -ltnp | grep 20128 && echo "NODE A RUNNING"
```

### Sinkronisasi Node A → Node B (Remote)

Tidak perlu build ulang di remote. Kirim tree hasil build via rsync:

```bash
# 1. Backup Node B
sshpass -p '89895535' ssh root@43.217.113.207 '
  TS=$(date +%Y%m%dT%H%M%S)
  BK=/root/.9router/backups/pre-upgrade-$TS
  mkdir -p "$BK"
  python3 - "$BK" << "PY"
import sqlite3, sys, os
bk = sys.argv[1]
src = sqlite3.connect("/root/.9router/db/data.sqlite")
dst = sqlite3.connect(os.path.join(bk, "data.sqlite"))
src.backup(dst); src.close(); dst.close()
PY
  cp -a /usr/lib/node_modules/9router-plinian "$BK/9router-install"
'

# 2. Rsync tree program (DB tidak ikut)
rsync -az --delete --exclude="app/cli/.build-home" \
  -e "sshpass -p 89895535 ssh -o StrictHostKeyChecking=no" \
  /tmp/opencode/9router-src/cli/ \
  root@43.217.113.207:/usr/lib/node_modules/9router-plinian/

# 3. Restart Node B via script file di remote
cat << 'EOF' > /tmp/opencode/restart_b.sh
#!/bin/bash
for p in $(pgrep -f "9router" 2>/dev/null); do kill -9 "$p" 2>/dev/null || true; done
for p in $(pgrep -f "next-server" 2>/dev/null); do kill -9 "$p" 2>/dev/null || true; done
sleep 2
fuser -k -9 20128/tcp 2>/dev/null || true
sleep 2
DST=/usr/lib/node_modules/9router-plinian
chmod +x "$DST/cli.js"
ln -sf "$DST/cli.js" /usr/local/bin/9router-kiyoshi
ln -sf "$DST/cli.js" /usr/local/bin/9router-plinian
ln -sf /usr/local/bin/9router-kiyoshi /usr/bin/9router-kiyoshi
ln -sf /usr/local/bin/9router-plinian /usr/bin/9router-plinian
setsid bash -c 'exec /usr/local/bin/node /usr/local/bin/9router-kiyoshi -p 20128 --host 0.0.0.0 --skip-update --no-browser > /tmp/9router-runtime.log 2>&1' < /dev/null > /dev/null 2>&1 &
sleep 8
ss -ltnp | grep 20128 && echo "NODE B RUNNING"
EOF
sshpass -p '89895535' scp /tmp/opencode/restart_b.sh root@43.217.113.207:/tmp/restart_b.sh
sshpass -p '89895535' ssh root@43.217.113.207 'bash /tmp/restart_b.sh && rm -f /tmp/restart_b.sh'
```

---

## 2. Verifikasi Build & Runtime

Jalankan test suite resmi:

```bash
bash /tmp/opencode/verify_local.sh
```

Hasil yang diharapkan:
1. `Process check` → 2 proses (supervisor + child `next-server`)
2. `Port 20128` → listening
3. `Version` → `{"currentVersion":"0.6.4"}`
4. `Models endpoint` → HTTP 200
5. `Overview specs API` → HTTP 200 JSON (CPU, RAM, Disk, Ports, Network)
6. `Overview Dashboard Page` → HTTP 200
7. `Branding` → `9Router-Kiyoshi=true`, `Based on 9Router-Plinian=true`, `Server Overview=true`
8. `Cloudflare Tunnel` → HTTP 200 (`https://9router.hirohitokiyoshi.web.id`)
9. `Chat completion` → deepseek merespons dengan format ANON

---

## 3. Menghasilkan Token JWT Dashboard untuk Testing

Dashboard dilindungi JWT token HS256 (`/root/.9router/jwt-secret`). Untuk memanggil route internal seperti `/api/overview/specs` lewat `curl`:

```bash
JWT=$(python3 - <<'PY'
import hmac, hashlib, base64, json, time
secret = open("/root/.9router/jwt-secret", "rb").read().strip()
def b64(d): return base64.urlsafe_b64encode(d).rstrip(b'=').decode('utf8')
h = b64(json.dumps({"alg":"HS256","typ":"JWT"}).encode())
p = b64(json.dumps({"sub":"admin","iat":int(time.time()),"exp":int(time.time())+3600}).encode())
sig = hmac.new(secret, f"{h}.{p}".encode(), hashlib.sha256).digest()
print(f"{h}.{p}.{b64(sig)}")
PY
)
curl -s http://127.0.0.1:20128/api/overview/specs -H "Cookie: auth_token=$JWT" | jq
```

---

## 4. Perlindungan Database

Database `/root/.9router/db/data.sqlite` adalah jantung sistem (157 akun, prompt injection, custom models, API keys).
- **Tidak pernah diubah oleh proses build atau swap**: skrip swap hanya menyalin direktori program `/usr/local/lib/node_modules/9router-plinian/`, direktori `/root/.9router/` tidak disentuh.
- **Backup sebelum operasi apa pun**: gunakan selalu API `sqlite3.backup()` Python (jangan `cp` langsung karena mode WAL aktif).
- Perubahan baris di `providerConnections` saat server hidup hanyalah pembaruan `accessToken`/`expiresAt` normal dari token refresh background Google/CodeBuddy.

---

## 5. Lokasi File Penting

- Patch gabungan resmi v0.6.4 + Anti-Ban: `/root/9router-mods-doc/vps-custom-modifications-0.6.4-antiban.patch`
- Patch warisan 7 mod: `/root/9router-mods-doc/vps-custom-modifications-0.6.4.patch`
- Snapshot backup stabil: `/root/.9router/backups/pre-antiban-20261105T033921/data.sqlite`
- Guard snapshot: `/root/.9router/backups/db-guard-20261105T035554/data.sqlite`
- Script verifikasi lokal: `/tmp/opencode/verify_local.sh`
- Skrip swap otomatis: `/tmp/opencode/swap_node_a.sh`
- Database utama: `/root/.9router/db/data.sqlite`
- Runtime Node 24 resmi: `/usr/local/lib/nodejs/node-v24.22.1-linux-x64/`
