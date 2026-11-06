# Stabledesk

Couche de mesure des stablecoins sur **Arc** (L1 Circle) : supply, volume réel, TVL, économie des
frais en USDC. Lecture seule. API publique `/v1` documentée et méthode publiée sur `/methodology`.

Public, MIT, `moreno-g/stabledesk` → [stabledesk.xyz](https://stabledesk.xyz)

## Commandes

```
npm test     # node --test → test/smoke.test.js + test/weekly-report.test.js + test/retention.test.js + test/noise-clock.test.js (129 tests, aucun réseau)
npm start    # node server.js, port 4317
node scripts/weekly-report.mjs   # brouillon du rapport hebdo, le jour de publication ; ne publie rien
```

Node **≥ 22.5.0** (obligatoire : `node:sqlite`). Zéro dépendance npm, ESM, `fetch` natif.

## Architecture

| Fichier | Rôle |
|---|---|
| `chains.js` | **Profil réseau — le seul commutateur testnet/mainnet.** Point d'entrée de toute valeur chain-specific. |
| `rpc.js` | Couche RPC partagée ; le réseau vient de `chains.js` (`ARC_NETWORK`). |
| `indexer.js` | Parcourt les blocs, stocke les `Transfer` stablecoins. |
| `db.js` | Persistance `node:sqlite`. |
| `server.js` | Serveur HTTP (dashboard). |
| `api.js` | API publique `/v1` : clés, tiers, rate limiting. |
| `mcp.js` | Endpoint MCP `/mcp` pour les assistants IA : outils en lecture seule, sans clé. **Lit `/v1` en interne** (`handleV1(..., { internal: true })`) : aucun chiffre n'y est recalculé. Sert MCP 2026-07-28 et les révisions antérieures (`initialize`). Pas d'outil par adresse, volontairement. |
| `rankings.js` `tvl.js` `entities.js` `protocols.js` | Métriques et registres. `entities.js` est **expérimental**. |
| `reports.js` + `reports/` | Rapports hebdo `/reports` : registre, fenêtre de 7 jours UTC, corps HTML figés (copiés dans l'image par le Dockerfile). |
| `scripts/weekly-report.mjs` | Brouillon du rapport hebdo. Lit la série USDC (connecteur MCP sans clé, ou `/v1` si `STABLEDESK_API_KEY`) et `totalSupply()` à la clôture de chaque jour sur le RPC Arc, vérifie Δ supply = mint − burn. Écrit `reports/<slug>.html` (avec `{{LEAD}}`) et `reports/<slug>.draft.md` (ignoré par git) : candidats, records, entrée du registre, fil X. Calculs dans `scripts/weekly.mjs` (purs) et `scripts/weekly-chain.mjs` (RPC). Exemple rejouable hors réseau : `test/fixtures/weekly-2026-11-06/`. Lancé le vendredi à 05:17 UTC par `.github/workflows/weekly-report.yml`, qui pousse le brouillon sur `weekly-report/<slug>` et ouvre une PR en brouillon avec les notes en description (il faut « Allow GitHub Actions to create and approve pull requests ») ; sur une PR qui touche le générateur, le même workflow fait un essai à blanc en direct. |
| `whalewatch.js` `chainalert.js` `chainuptime.js` `telegram.js` | Alertes et disponibilité. `whalewatch` est en réserve jusqu'au mainnet. |
| `payments.js` | Facturation crypto : surveille l'USDC sur **Base mainnet**, pas sur Arc. |
| `csv.js` `openapi.js` `validate.js` `constants.js` `search.js` `labels.js` `template.js` | Surface API et helpers. `template.js` remplit les pages (`{{KEY}}`) : remplacements par fonctions, à cause des `$`. |

## Règles propres à ce repo

- **`chains.js` throw si une variable mainnet manque. Ne jamais ajouter de fallback.** Servir des
  chiffres testnet sous une bannière mainnet est pire que ne pas démarrer : les nombres auraient
  l'air plausibles et seraient faux.
- **Les trois mesures de volume — raw / real / adjusted — sont publiées.** Changer une définition
  oblige à mettre à jour `/methodology` dans le même commit. Le fil rouge du projet est que chaque
  étape de filtrage soit auditable, pas asserted.
- Les frais se lisent dans les receipts (le gas sur Arc est en USDC) : **pas de price feed, pas
  d'oracle**. Ne pas en introduire.
- **Rapport hebdo : le générateur rédige, une personne choisit.** Le titre, le chapeau et le résumé ne sont pas
  générés ; le brouillon liste les candidats avec leurs chiffres. Un chiffre du titre ou du résumé s'écrit comme
  dans le corps, même décimale (test dans `test/weekly-report.test.js`). Rien n'est publié ni posté automatiquement.
- Circle Gateway repositionne de la liquidité — ce n'est **pas** de l'émission. Voir le commentaire
  dans `chains.js`.
- Sur testnet, toute page affichant un nombre répète l'avertissement testnet (dérivé de `chain.isTestnet`).
  Ne pas le retirer d'une page. Le site tourne sur mainnet depuis le 16 septembre 2026.
- `arc.db` à la racine est la base locale : ne pas la commiter ni la supprimer. Sur Railway,
  `DB_PATH` doit pointer dans le volume monté (`RAILWAY_VOLUME_MOUNT_PATH`).

## Déploiement

Railway via **Dockerfile** (`railway.json`), healthcheck `/api/health`, timeout 120 s.
Alternative Docker + Caddy : `docker-compose.yml`, `Caddyfile`, `deploy/`. Détails dans `DEPLOY.md`.

Secrets par variables d'environnement uniquement (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).
`.gitleaks.toml` silence les adresses EVM publiques des fixtures.
