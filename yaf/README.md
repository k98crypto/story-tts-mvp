# YAF 听书

Responsive PWA for importing TXT, Markdown, or EPUB novels, splitting chapters, saving local reading progress, and generating speech through the existing SpiritWave TTS proxy.

## Behavior

- TXT, Markdown, EPUB books, and reading progress stay in the browser's IndexedDB. EPUB archives are read locally in the browser and the reading position is stored separately from book text.
- Speech requests go through the same-origin `/synthesize` route and require an existing SpiritWave login.
- The TTS proxy accepts up to 1,200 characters per request. The app keeps chunks below that limit.
- Generated WAV data is played from memory and is not saved. Offline playback of generated audio is not supported.
- The app registers a service worker for its interface shell; imported book text remains available in IndexedDB.
- EPUB parsing uses the bundled zip.js 2.24.0 library with lazy BlobReader access for large archives. See `vendor/ZIPJS-LICENSE`.
- The book opened most recently is marked in the shelf. Reading position is saved automatically on this device.
- Player controls use Lucide Static 1.63.0 icons under ISC. See `vendor/LUCIDE-LICENSE`.

## Local preview

Run the existing SpiritWave web proxy on port 8765, then start this app with:

```powershell
docker compose up --build
```

Open `http://127.0.0.1:8767`. The Docker service forwards `/config`, `/health`, and authenticated `/synthesize` requests to the existing proxy at `http://host.docker.internal:8765`.

## Deployment notes

Port `8767` is for local preview only. Production serves the YAF static allowlist from the existing `8765` proxy when the request Host is `yaf.spiritwave.dpdns.org`. The Cloudflare Tunnel and DNS route for that public hostname both target `8765`; port `8766` is not in Tunnel ingress.

The consumer hostname is public and does not use Cloudflare Access. The YAF Host route returns 404 for `/admin` and unlisted files. `/config`, `/session`, and `/synthesize` remain on the existing proxy, which enforces account authentication and the configured quota. The model service validates speaker and emotion values.

Deployment checks passed for the public page, static assets, missing-login responses, and the hidden admin path. The Supabase redirect allowlist still needs confirmation for sign-up and password-recovery callbacks to this hostname. The model service currently listens on `0.0.0.0:8766`; it is absent from Tunnel ingress, but host firewall/router exposure has not been confirmed.

Keep the current daily quota unchanged until GPU throughput, queueing, and per-account usage behavior have been confirmed. A 3,000-character quota is a short listening sample, not a full novel.
