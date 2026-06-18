# The Mudda Radio — radio.themudda.com

A 24×7 Hindi civic-commentary radio. One measured anchor voice gives a short,
bebaak take on each issue in the day's news — looping forever, a single
continuous stream of **हर मुद्दे पर एक साफ़ राय**, Hindi first.

It reuses The Mudda's civic engine: the published **takes** (each an authored
Hindi opinion tagged with a verdict — concern / outrage / hope / pride / reform
/ idea / question), turned into on-air radio.

## How it works

1. **Feed** — pulls the live takes from `https://themudda.com/api/takes`, keeps
   the ones with an authored Hindi take + a real story, and round-robins across
   verdicts so a program always mixes worry with hope, pride and reform.
2. **Script** — no LLM needed: each take is already written. The station adds a
   short spoken civic lead-in per verdict, then reads the take.
3. **Voice** — Azure Speech Neural TTS (`hi-IN-KavyaNeural`) renders each segment
   to a CBR MP3, hash-cached in blob so unchanged takes never re-synthesise.
4. **Program** — `ident → [segue] take → … → sign-off`, persisted as a manifest.
5. **Player** — a continuous looping web player (ON AIR indicator, now-playing
   console with the verdict, up-next queue, read-the-story links), Hindi-first UI.
6. **Refresh** — a GitHub Action cron (~every 3h) rebuilds the program from the
   latest takes; cached audio keeps each run comfortably inside the free tier.

## Endpoints

- `GET /api/playlist` → program manifest (built on first miss)
- `GET /api/audio/{id}` → stream a segment MP3
- `GET|POST /api/refresh?key=REFRESH_KEY` → rebuild the program

## Deploy

Azure Static Web App **`radio-themudda`** (Free, `lms-rg`), custom domain
`radio.themudda.com` (Cloudflare CNAME → SWA host).

| Secret | Purpose |
| --- | --- |
| `AZURE_SWA_DEPLOY_TOKEN` | Deployment token for the `radio-themudda` SWA |
| `REFRESH_KEY` | Guards `/api/refresh` |

| App setting | Notes |
| --- | --- |
| `BLOB_CONN` | Azure Storage connection string (shared `feed` container) |
| `BLOB_PREFIX` | Blob namespace for this station; `radio-mu/` |
| `SPEECH_KEY` / `SPEECH_REGION` | Azure Speech (F0); region `eastus2` supports `hi-IN` |
| `REFRESH_KEY` | Guards `/api/refresh` |
| `RADIO_VOICE` | Optional; default `hi-IN-KavyaNeural` |
| `TAKES_API` | Optional; default `https://themudda.com/api/takes` |
| `RADIO_STORIES` | Optional; takes per program (default 12) |

Built on the same engine as TechWave Radio and Pulse Bharat Radio.
