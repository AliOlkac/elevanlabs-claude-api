# Ses Atölyesi

Claude'un (Anthropic'in yapay zekâ asistanı) **özel bağlayıcı** (remote MCP server) olarak bağlanıp
ElevenLabs API üzerinden sizin adınıza ses ürettiği küçük bir sunucu. İnsan arayüzü ikincildir:
`/` adresindeki panel yalnızca izleme, dinleme ve bütçe ayarı içindir.

- **`/mcp`** — Streamable HTTP MCP sunucusu (resmi `@modelcontextprotocol/sdk`), 15 araç.
- **`/`** — Türkçe panel: işler, durumlar, satır satır dinleme, kalan kredi, bütçe.
- **Teslim** — Claude'un çalışma ortamı bu siteye erişemez ama GitHub'a erişir. Bu yüzden her iş
  bitince çıktılar özel bir GitHub deposuna commit edilir; araçlar yalnızca depo yolu + commit
  SHA'sı döner, ses verisi araç sonucuna asla gömülmez.

## Mimari

Cloudflare Workers üzerinde çalışır (TypeScript).

| Parça | Ne için |
| --- | --- |
| Worker (`src/index.ts`) | `/mcp` (Bearer token) ve panel (`APP_PASSWORD`) |
| Durable Object `JobRunner` | Her iş için bir nesne; alarm ile arka planda ilerler, kaldığı yerden devam eder |
| KV `STORE` | İş dizini/özetleri, bütçe ayarları, model listesi önbelleği |
| R2 `AUDIO` | Ses dosyaları ve satır önbelleği (`cache/<özet>.mp3` + `.json`) |

```
Claude ──MCP──▶ Worker ──▶ JobRunner (DO, alarm) ──▶ ElevenLabs API
                  │              │  └─▶ R2 (ses + önbellek)
                  │              └────▶ GitHub (jobs/<job>/… tek commit)
                  └─▶ KV (iş dizini, bütçe)
```

## Ortam değişkenleri

Gizli değerler **yalnızca** Worker secret'ı olarak tutulur; araç çıktısına, loglara ve hata
mesajlarına yazılmaz (tüm hata metinleri ayrıca bir redaksiyon süzgecinden geçer).

| Değişken | Zorunlu | Açıklama |
| --- | --- | --- |
| `ELEVENLABS_API_KEY` | evet (gizli) | ElevenLabs API anahtarı |
| `MCP_TOKEN` | evet (gizli) | `/mcp` için Bearer token. Uzun ve rastgele olsun: `openssl rand -hex 32` |
| `GITHUB_TOKEN` | evet (gizli) | Çıktı deposuna yazan fine-grained token (aşağıya bakın) |
| `GITHUB_REPO` | evet (gizli) | Çıktı deposu, ör. `kullanici/ses-ciktilari` (özel depo) |
| `APP_PASSWORD` | evet (gizli) | Panel parolası |
| `DEFAULT_MODEL` | hayır | Varsayılan model. Varsayılan: `eleven_v4_turbo` |
| `GITHUB_BRANCH` | hayır | Commit atılacak dal. Varsayılan: deponun varsayılan dalı |
| `MODEL_ROUTES` | hayır | Model → uç nokta eşlemesini değiştirir (aşağıda "Modeller") |
| `MAX_CHARS_PER_REQUEST` | hayır | Modelin bildirdiği istek başı karakter sınırının üstüne ek tavan |

### GitHub token'ı — en dar izin

1. Çıktılar için **özel** bir depo açın (ör. `ses-ciktilari`). Boş olabilir; ilk commit'te
   sunucu bir README ile başlatır.
2. GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → *Generate new token*.
3. **Repository access:** *Only select repositories* → yalnızca bu depo.
4. **Permissions → Repository permissions → Contents: Read and write.**
   (*Metadata: Read-only* kendiliğinden eklenir.) Başka hiçbir izin vermeyin.

## Deploy (Cloudflare Workers)

```bash
npm install
```

```bash
npx wrangler login
```

KV alanını oluşturun ve dönen `id` değerini `wrangler.jsonc` içindeki `KV_NAMESPACE_ID_BURAYA` yerine yazın:

```bash
npx wrangler kv namespace create STORE
```

R2 kovasını oluşturun:

```bash
npx wrangler r2 bucket create ses-atolyesi-audio
```

Gizli değerleri girin (her komut değeri ayrıca sorar; değerler depoya veya `wrangler.jsonc`'ye yazılmaz):

```bash
npx wrangler secret put ELEVENLABS_API_KEY
```

```bash
npx wrangler secret put MCP_TOKEN
```

```bash
npx wrangler secret put GITHUB_TOKEN
```

```bash
npx wrangler secret put GITHUB_REPO
```

```bash
npx wrangler secret put APP_PASSWORD
```

Yayınlayın:

```bash
npx wrangler deploy
```

Çıktıdaki adres (ör. `https://ses-atolyesi.<hesap>.workers.dev`) sizin `<alan>` değerinizdir.
Durable Object (SQLite) ücretsiz planda da çalışır; R2'nin hesapta etkinleştirilmiş olması gerekir.

## Claude'a bağlama

1. Claude → **Ayarlar → Bağlayıcılar (Connectors) → Özel bağlayıcı ekle**.
2. **Bağlayıcı URL'si:** `https://<alan>/mcp`
3. Kimlik doğrulama, ikisinden biri:
   - **OAuth (Claude uygulamasının varsayılanı):** başka bir şey girmeyin, **Bağlan**'a basın. Açılan
     "Bağlantı izni" sayfasına panel parolanızı (`APP_PASSWORD`) yazın. Sunucu dinamik istemci kaydı
     ve PKCE destekler; OAuth Client ID girmeniz gerekmez.
   - **Sabit istek başlığı (destekleyen istemcilerde):** `Authorization: Bearer <MCP_TOKEN>`
4. Kaydedin; araç listesinde 15 araç görünmelidir.
5. Claude'un çalışma ortamının çıktı deposunu (`GITHUB_REPO`) okuyabildiğinden emin olun —
   Claude dosyaları oradan alır.

OAuth belirteçleri `MCP_TOKEN` + `APP_PASSWORD` ile imzalanır; ikisinden birini değiştirmek tüm
bağlantıları geçersiz kılar (yeniden bağlanmak yeter).

Elle denemek için:

```bash
curl -s https://<alan>/mcp -H "Authorization: Bearer $MCP_TOKEN" -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## MCP araçları

Hepsi JSON döner; hata durumunda `{ "error": "...", "detail": "..." }`.

| # | Araç | Ne yapar |
| --- | --- | --- |
| 1 | `account_status` | Kalan kredi, plan, dönem sonu, bu ayki kullanım, bütçe |
| 2 | `list_models` | Kimlik, ad, diller, istek başı karakter sınırı, kredi çarpanı, uç nokta |
| 3 | `list_voices {search?}` | `voice_id`, ad, etiketler, dil |
| 4 | `estimate_job {job}` | Karakter, tahmini kredi, önbellekten gelecek satır sayısı. Hiçbir şey üretmez |
| 5 | `submit_job {job, force?}` | İşi kuyruğa alır, hemen `job_id` döner |
| 6 | `get_job {job_id}` | Durum, biten/toplam, kredi; bittiyse GitHub yolu + commit SHA + manifest özeti |
| 7 | `list_jobs {limit?}` | Son işler |
| 8 | `cancel_job {job_id}` | İşi durdurur |
| 9 | `design_voice {description, sample_text, language}` | 3 önizleme → `previews/<id>/` |
| 10 | `save_voice {generated_voice_id, name, description}` | Kalıcı ses, `voice_id` döner |
| 11 | `sound_effect {text, duration_seconds?, name}` | `sfx/<name>.mp3` |
| 12 | `music {prompt, duration_seconds, instrumental, name}` | `music/<name>.mp3` |
| 13 | `pronunciation {action, …}` | Telaffuz sözlükleri: `list`, `create`, `add_rules`, `remove_rules` |
| 14 | `transcribe {github_path \| url, language?}` | Kelime zaman damgalı döküm (Scribe) |
| 15 | `align {github_path, text}` | Metni sese hizalar (forced alignment) |

### İş biçimi

```json
{
  "job": "sl-01-tr",
  "model": "eleven_v4_turbo",
  "language": "tr",
  "mode": "lines",
  "items": [
    { "name": "001-balon", "voice_id": "…", "text": "…",
      "settings": { "stability": 0.5, "similarity_boost": 0.75, "speed": 1.0 } }
  ],
  "pronunciation_dictionary_id": "…",
  "force": false
}
```

- `mode: "lines"` — her item ayrı istek, ayrı mp3.
- `mode: "dialogue"` — ardışık item'lar çok konuşmacılı tek istekte üretilir (Text to Dialogue),
  sonra zaman damgalarından item başına ayrı mp3'lere kesilir.
- `job` ve `name`: `A-Z a-z 0-9 . _ -`, en çok 80 karakter. Bir işte en çok 500 item.

### GitHub'daki çıktı

```
jobs/<job>/<name>.mp3
jobs/<job>/manifest.json      # tek commit, mesaj: "job: <job>"
previews/<id>/…               # design_voice
sfx/<name>.mp3
music/<name>.mp3
```

`manifest.json` içindeki her item:

```json
{ "name": "001-balon", "voice_id": "…", "text": "…", "file": "001-balon.mp3",
  "duration_sec": 2.351, "characters": 29, "credits": 14.5, "cached": false,
  "words": [{ "word": "Kırmızı", "start": 0.0, "end": 0.41 }] }
```

90 MB'ı aşan iş birden fazla commit'e bölünür (`job: <job> (1/2)` …). Aynı iş adı yeniden
gönderilirse klasör yeni çalıştırmayı yansıtır (artık işte olmayan dosyalar silinir).

## Modeller ve uç noktalar

Model listesi ve istek başı karakter sınırı (`maximum_text_length_per_request`) canlı olarak
`GET /v1/models`'tan okunur; uzun metin cümle sınırından bölünür.

Hangi modelin hangi uç noktadan sunulduğu ElevenLabs'in model sayfası ve resmi API tanımına
(`@elevenlabs/elevenlabs-js` 2.77, Kasım 2026) göre yazıldı:

| Model | Uç nokta | `lines` | `dialogue` |
| --- | --- | --- | --- |
| `eleven_v4` | Text to Dialogue **REST** `POST /v1/text-to-dialogue/with-timestamps` | ✓ | ✓ (istek başına en çok 10 ses) |
| `eleven_v4_turbo` | Text to Dialogue **WebSocket** `/v1/text-to-dialogue/stream-input` | ✓ | ✗ (bağlantı başına tek ses) |
| `eleven_v3` | Text to Dialogue REST | ✓ | ✓ |
| diğerleri | Text to Speech REST `POST /v1/text-to-speech/{voice_id}/with-timestamps` | ✓ | ✗ |

**Turbo kuralı:** `eleven_v4_turbo` bir işi yapamıyorsa (çok konuşmacılı `dialogue`, ya da
WebSocket modeli/sesi reddediyorsa) sunucu **hata vermez ve işi kendiliğinden `eleven_v4` ile
yapmaz**; hiçbir şey üretmeden `warning: "turbo desteklenmiyor: <neden>"` döner. Karar Claude'dadır.

ElevenLabs eşlemeyi değiştirirse kod değiştirmeden düzeltebilirsiniz:

```bash
npx wrangler deploy --var 'MODEL_ROUTES:{"eleven_v4_turbo":"dialogue_rest"}'
```

Ayar eşlemesi: Text to Dialogue modellerinde `stability` ve `similarity_boost` (API'de
`similarity`) geçerlidir, `speed` desteklenmez ve uyarıyla yok sayılır. WebSocket'te yalnızca
`stability` vardır.

## Üretim kuralları

- Çıktı biçimi `mp3_44100_192`. 3 paralel istek; 429 ve 5xx'te artan beklemeyle 3 tekrar.
- Zaman damgalı uç noktalar kullanılır; kelime zamanları karakter hizalamasından türetilir.
- **Önbellek:** `(model + voice_id + text + settings + sözlük sürümü + dil)` özetine göre. Aynı
  satır yeniden istenirse API'ye gidilmez (`cached: true`, `credits: 0`). `force: true` ile aşılır.
  Sözlük değişince sürümü değiştiği için etkilenen satırlar yeniden üretilir.
- **Süreklilik:** aynı sesin ardışık satırlarında `previous_text` / `next_text` (dialogue'da
  `future_text`), bölünmüş uzun satırın parçalarında ayrıca `previous_request_ids` gönderilir.
  Model bunları reddederse otomatik olarak onlarsız üretilir ve uyarı düşülür.
- **Arka plan:** `submit_job` hemen döner. Her "tık" sınırlı sayıda istek yapar, her biten satırı
  hemen kaydeder; yarıda kalan iş bir sonraki tıkta kaldığı yerden sürer, biten satır yeniden üretilmez.
- **Hata:** bir satır kalıcı olarak başarısız olursa iş `error` olur ve GitHub'a commit atılmaz;
  biten satırlar önbellekte kalır, düzeltip yeniden gönderince yalnızca eksikler ücretlenir.
- **Bütçe:** panelden iş başına ve aylık karakter sınırı (varsayılan 50.000 / 500.000, `0` = sınırsız).
  Aşılırsa iş başlamaz, nedeni döner. Sayılan şey API'ye gidecek (önbellekte olmayan) karakterdir.

## Bilinen sınırlar

- `dialogue` kesimi mp3 çerçeve sınırlarından (≈26 ms) ve iki satır arasındaki sessizliğin
  ortasından yapılır; yeniden kodlama yoktur, ses kaybı olmaz.
- Aylık bütçe yalnızca konuşma işlerinin karakterlerini sayar; `sound_effect`, `music`,
  `design_voice`, `transcribe`, `align` kredileri bu sayaca girmez (`account_status` gerçek
  kalan krediyi gösterir).
- `music` eşzamanlı çalışır; uzun parçalarda yanıt bir dakikayı aşabilir.
- Bu depo canlı ElevenLabs hesabıyla değil, API tanımına göre yazılmış sahte sunucuyla test
  edildi. İlk canlı kullanımda küçük bir `lines` işiyle (1–2 satır) doğrulama yapın; özellikle
  `eleven_v4_turbo` WebSocket yolunda zaman damgalarını `manifest.json`'dan kontrol edin.

## Geliştirme ve test

```bash
npm run typecheck
```

```bash
npm test
```

Uçtan uca test gerçek Worker'ı yerelde (`wrangler dev`) sahte ElevenLabs + GitHub sunucularına
karşı çalıştırır (ağ ve gerçek anahtar gerekmez):

```bash
npm run test:e2e
```

Yerelde gerçek servislerle çalıştırmak için gizli değerleri `.dev.vars` dosyasına yazın
(git'e girmez) ve `npm run dev` çalıştırın.

## Güvenlik notları

- `/mcp` yalnızca `Authorization: Bearer <MCP_TOKEN>` ile, sabit zamanlı karşılaştırmayla açılır.
- Panel oturumu imzalı, `HttpOnly`, `SameSite=Strict` çerezdir; katı bir CSP uygulanır.
- ElevenLabs anahtarı yalnızca istek başlığında taşınır (WebSocket dahil; URL'ye yazılmaz).
- Araç sonuçları depo adını da içermez; yalnızca depo içi yol ve commit SHA'sı döner.
