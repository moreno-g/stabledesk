# Stabledesk

Couche de mesure des stablecoins sur **Arc** (L1 Circle) : supply, volume réel, TVL, économie des
frais en USDC. Lecture seule. API publique `/v1` documentée et méthode publiée sur `/methodology`.

Public, MIT, `moreno-g/stabledesk` → [stabledesk.xyz](https://stabledesk.xyz)

## Commandes

```
npm test     # node --test → test/smoke.test.js (40 tests, aucun réseau)
npm start    # node server.js, port 4317
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
| `rankings.js` `tvl.js` `entities.js` `protocols.js` | Métriques et registres. `entities.js` est **expérimental**. |
| `whalewatch.js` `chainalert.js` `chainuptime.js` `telegram.js` | Alertes et disponibilité. `whalewatch` est en réserve jusqu'au mainnet. |
| `payments.js` | Facturation crypto : surveille l'USDC sur **Base mainnet**, pas sur Arc. |
| `csv.js` `openapi.js` `validate.js` `constants.js` `search.js` `labels.js` | Surface API et helpers. |

## Règles propres à ce repo

- **`chains.js` throw si une variable mainnet manque. Ne jamais ajouter de fallback.** Servir des
  chiffres testnet sous une bannière mainnet est pire que ne pas démarrer : les nombres auraient
  l'air plausibles et seraient faux.
- **Les trois mesures de volume — raw / real / adjusted — sont publiées.** Changer une définition
  oblige à mettre à jour `/methodology` dans le même commit. Le fil rouge du projet est que chaque
  étape de filtrage soit auditable, pas asserted.
- Les frais se lisent dans les receipts (le gas sur Arc est en USDC) : **pas de price feed, pas
  d'oracle**. Ne pas en introduire.
- Circle Gateway repositionne de la liquidité — ce n'est **pas** de l'émission. Voir le commentaire
  dans `chains.js`.
- Toute page affichant un nombre répète l'avertissement testnet. Ne pas le retirer d'une page.
- `arc.db` à la racine est la base locale : ne pas la commiter ni la supprimer. Sur Railway,
  `DB_PATH` doit pointer dans le volume monté (`RAILWAY_VOLUME_MOUNT_PATH`).

## Déploiement

Railway via **Dockerfile** (`railway.json`), healthcheck `/api/health`, timeout 120 s.
Alternative Docker + Caddy : `docker-compose.yml`, `Caddyfile`, `deploy/`. Détails dans `DEPLOY.md`.

Secrets par variables d'environnement uniquement (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).
`.gitleaks.toml` silence les adresses EVM publiques des fixtures.
