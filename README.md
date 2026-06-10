# Kattenberg 118 — Status

Publieke statuspagina + externe prober voor de Kattenberg 118-diensten.
Live op **https://status.kattenberg118.be** (Cloudflare Pages).

Off-NAS by design: de prober draait op GitHub Actions en de pagina leest een
`status.json` van GitHub raw — zo blijft de statuspagina werken én blijft de
meting doorlopen, óók als de NAS plat ligt.

## Hoe het werkt

```
GitHub Action (elke ~5 min, off-NAS)
   └─ probe.mjs  → HTTP-check per dienst (status + http_code + latency)
        ├─ schrijft status.json  → force-push naar branch `status-data` (1 commit, low-noise)
        └─ bij up↔down-overgang → Resend-mail (na 3 mislukte checks op rij)

Cloudflare Pages (index.html + assets/, off-NAS)
   └─ fetcht raw status.json van branch `status-data` → rendert de pagina
```

### Gemeten diensten
- De Kleine Wereldburger — https://dekleinewereldburger.be
- Kattenberg 118 — https://www.kattenberg118.be
- Studio — https://studio.kattenberg118.be
- Analytics (Umami) — https://umami.kattenberg118.be

### Debounce
Een dienst wordt pas **down** gemeld na **3 mislukte checks op rij** (~15 min).
Eén blip flipt de pagina niet en stuurt geen mail. Herstel → herstelmail.

## Configuratie (GitHub → Settings → Secrets and variables → Actions)

**Secret (vereist voor alerts):**
- `RESEND_API_KEY` — Resend API-key. Zonder deze key draait de prober gewoon
  door, maar worden er geen mails verstuurd.

**Variables (optioneel — defaults staan tussen haakjes):**
- `ALERT_EMAIL_TO` (`contact@jonassmets.net`) — ontvanger van de alerts.
- `ALERT_EMAIL_FROM` (`Kattenberg 118 status <status@kattenberg118.be>`) —
  afzender; het domein moet **geverifieerd** zijn in Resend.

## Lokaal testen

```bash
node probe.mjs          # checkt de diensten, schrijft ./status.json (geen mail zonder key)
```

## Deploy

Statisch (`index.html` + `assets/`) → Cloudflare Pages (direct upload via
`wrangler pages deploy`). De prober heeft geen deploy nodig; die draait in Actions.
