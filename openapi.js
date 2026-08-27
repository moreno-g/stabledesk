// Machine-readable description of the public /v1 API — OpenAPI 3.1, plus the /llms.txt index.
//
// Generated from the live configuration rather than written out by hand, for the same reason
// sitemap.xml is: a hand-maintained document is a hand-maintained omission. Three things here
// are network-derived and would go stale the day they were typed as literals — the tracked
// token symbols (USYC exists on testnet, not on mainnet), the chain id, and the per-tier rate
// limits. Everything this reads is fixed at boot, so the document is built once and cached.
//
// Beyond documentation, an OpenAPI spec is the prerequisite for listing on an agent
// marketplace: agents discover inputs and outputs from it instead of parsing /docs.

import { CHAIN } from './chains.js';
import { RANGES, TIERS, TOKEN_SYMBOLS, SITE_ORIGIN, SIZE_BRACKETS } from './constants.js';
import { CATEGORIES } from './protocols.js';

const TOKENS = [...TOKEN_SYMBOLS];
const RANGE_KEYS = Object.keys(RANGES);

const schema = (name) => ({ $ref: `#/components/schemas/${name}` });
const response = (name) => ({ $ref: `#/components/responses/${name}` });

// Every authenticated route can fail these three ways, and repeating them inline twenty times
// would bury the one or two failures that are actually specific to a given endpoint.
const COMMON = {
  401: response('Unauthorized'),
  429: response('RateLimited'),
  503: response('Indexing'),
};

// Every authenticated response carries the caller's remaining budget, so an agent can pace itself
// instead of discovering the limit by hitting it. Declared on the success responses too, not only
// on the 429 — by the time you get a 429 the header has stopped being useful as a warning.
const RATE_HEADERS = {
  'X-RateLimit-Limit': { $ref: '#/components/headers/X-RateLimit-Limit' },
  'X-RateLimit-Remaining': { $ref: '#/components/headers/X-RateLimit-Remaining' },
};

const ok = (description, contentSchema) => ({
  description,
  headers: RATE_HEADERS,
  content: { 'application/json': { schema: contentSchema } },
});

// The two keyless endpoints: no key means no per-key budget, so no rate-limit headers to report.
const okPublic = (description, contentSchema) => ({
  description,
  content: { 'application/json': { schema: contentSchema } },
});

// `?format=csv` is offered on the list endpoints so a spreadsheet can pull them directly; the
// response is then a file, not JSON, and the spec has to say so or an agent will try to parse it.
const csvParam = {
  name: 'format', in: 'query', required: false,
  description: 'Set to `csv` to receive a CSV file instead of JSON.',
  schema: { type: 'string', enum: ['csv'] },
};
const withCsv = (description, contentSchema) => ({
  description,
  headers: RATE_HEADERS,
  content: {
    'application/json': { schema: contentSchema },
    'text/csv': { schema: { type: 'string' } },
  },
});

const limitParam = (max, dflt) => ({
  name: 'limit', in: 'query', required: false,
  schema: { type: 'integer', minimum: 1, maximum: max, default: dflt },
});

const num = (description) => ({ type: ['number', 'null'], description });

function build() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Stabledesk API',
      version: '1.0.0',
      summary: `Stablecoin measurement for ${CHAIN.label} — supply, real volume, TVL and fee economics.`,
      description: [
        `Stabledesk measures every stablecoin on ${CHAIN.label} (chain id ${CHAIN.chainId}): supply,`,
        'volume, TVL, flows and network fee economics, read straight from the chain.',
        '',
        'Three volume measures are published side by side rather than one blended number:',
        '`volume` (every Transfer event), `rvolume` (**real** — one largest transfer per transaction',
        'per token, so routing hops and contract internals are not counted twice) and `avolume`',
        '(**adjusted** — real, minus infrastructure addresses talking to infrastructure). Publishing',
        'all three is what makes each filtering step auditable instead of asserted.',
        '',
        `Gas on ${CHAIN.label} is paid in USDC, so fee figures are dollars read from transaction`,
        'receipts — no price feed and no oracle is involved.',
        '',
        '**Two conventions worth knowing before consuming any figure.** A value that could not be',
        'measured is `null`, never a carried-over previous value — an old number presented as',
        'current is a wrong number, not an old one. And when the chain is frozen the rolling 24h',
        'windows end at the last indexed minute rather than at now, reported as `windowEnd`;',
        'without that they would report "24h volume: 0" and state the chain sat idle when what',
        'actually happened is that it stopped. Check `GET /v1/status` for `degraded` and `chain.state`.',
        '',
        'The measurement method, including every threshold, is published at /methodology.',
      ].join('\n'),
      contact: { name: 'Stabledesk', url: `${SITE_ORIGIN}/docs`, email: 'studiomoreno@icloud.com' },
      license: { name: 'Free tier — attribution appreciated', url: `${SITE_ORIGIN}/docs` },
    },
    servers: [{ url: SITE_ORIGIN, description: `${CHAIN.label} (chain id ${CHAIN.chainId})` }],
    externalDocs: { description: 'Developer docs and measurement method', url: `${SITE_ORIGIN}/docs` },

    tags: [
      { name: 'Status', description: 'Liveness of the chain and of the index. No API key required.' },
      { name: 'Keys', description: 'Mint a free API key. No API key required.' },
      { name: 'Network', description: 'Chain throughput and fee economics.' },
      { name: 'Stablecoins', description: 'Supply, volume, velocity and issuance per token.' },
      { name: 'Ecosystem', description: 'Protocol registry joined to measured TVL and flow.' },
      { name: 'Addresses', description: 'Top addresses, per-address activity, and the noise filter.' },
      { name: 'Alerts', description: 'Webhook alerts on matching transfers.' },
      { name: 'Billing', description: 'Upgrade a key to Pro by paying in USDC.' },
    ],

    security: [{ ApiKeyHeader: [] }, { ApiKeyQuery: [] }],

    paths: {
      // ---- public: no key ----
      '/v1/status': {
        get: {
          tags: ['Status'], operationId: 'getStatus', security: [],
          summary: 'Index and chain liveness',
          description: [
            'Whether the figures are advancing, and if not, whose fault that is. A halted chain and',
            'a broken indexer produce the same symptom, so they are reported separately: `chain.state`',
            'describes the chain, `degraded` describes whether this API is serving live or indexed-only',
            'data. Poll this before trusting a timestamp elsewhere.',
          ].join(' '),
          responses: { 200: okPublic('Current status.', schema('Status')) },
        },
      },
      '/v1/keys': {
        post: {
          tags: ['Keys'], operationId: 'createKey', security: [],
          summary: 'Mint a free API key',
          description: 'Returns a `sbd_…` key. Send it as the `X-API-Key` header on every other /v1 request. Capped at 5 keys per hour per IP.',
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { label: { type: 'string', maxLength: 60, description: 'Optional label to identify the key later.' } },
                },
              },
            },
          },
          responses: {
            201: okPublic('Key created.', schema('NewKey')),
            429: response('KeyLimit'),
          },
        },
      },

      // ---- network ----
      '/v1/chain/uptime': {
        get: {
          tags: ['Status'], operationId: 'getChainUptime',
          summary: 'Chain availability record',
          description: [
            'What the chain has done over time, folded from the log of state transitions.',
            '',
            '**Read `coveragePct` before `uptimePct`.** Uptime is a share of *observed* time, not of',
            'the window: hours when Stabledesk was not running, or was being refused by the RPC,',
            'are not counted as chain uptime, because they are not evidence about the chain at all.',
            'A 99.9% uptime over 4% coverage is a statement about four percent of the period.',
            '`uptimePct` is `null` when nothing at all was observed, never 100.',
            '',
            'For the same reason `unauthorized` time — our credentials being rejected — is booked as',
            'unobserved rather than as downtime. The chain may well have been producing blocks',
            'throughout. `unreachable` is counted as down, but our own host losing connectivity is',
            'indistinguishable from the chain going dark, so the full `byState` breakdown is returned',
            'and a consumer who reads that boundary differently can recompute from it.',
            '',
            'Check `recordBegan` before trusting a long window: a 30-day figure from a log that',
            'started a week ago is a seven-day figure.',
          ].join('\n'),
          parameters: [
            { name: 'days', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 } },
          ],
          responses: { 200: ok('Availability totals and recent episodes.', schema('ChainUptime')), ...COMMON },
        },
      },
      '/v1/network': {
        get: {
          tags: ['Network'], operationId: 'getNetwork',
          summary: 'Chain throughput',
          description: 'Head block, block time, TPS and gas price. Live-only figures are `null` rather than stale whenever the chain cannot be read.',
          responses: { 200: ok('Network state.', schema('Network')), ...COMMON },
        },
      },
      '/v1/network/fees': {
        get: {
          tags: ['Network'], operationId: 'getFees',
          summary: 'Fee economics, in dollars',
          description: [
            `Gas on ${CHAIN.label} is paid in USDC, so every figure here is a dollar amount taken from`,
            'transaction receipts. The headline metric is `perMillionMoved` — what it costs the network',
            'to move $1M of value. Exact fees only exist in receipts and fetching every block would bury',
            'the rate-limited public RPC, so blocks are sampled: `sample` reports how many blocks and',
            'transactions the extrapolation rests on, and an estimate is never presented as a measured total.',
          ].join(' '),
          responses: {
            200: ok('Fee economics.', schema('Fees')),
            ...COMMON,
            503: response('FeesUnavailable'),
          },
        },
      },

      // ---- stablecoins ----
      '/v1/stablecoins': {
        get: {
          tags: ['Stablecoins'], operationId: 'getStablecoins',
          summary: 'Supply and 24h summary, all tokens',
          description: '`summary24h` sums everything since 24h ago, which on a young or freshly-restarted '
            + 'index is however much history exists rather than a full day. `coverage` states how much that '
            + 'actually is (`minutes`, and the first and last minute measured) and `windowEnd` states which '
            + 'instant the window ends at, so the figures can be labelled instead of assumed.',
          responses: { 200: ok('Supply and rolling 24h totals per token, with the coverage behind them.', schema('Stablecoins')), ...COMMON },
        },
      },
      '/v1/stablecoins/history': {
        get: {
          tags: ['Stablecoins'], operationId: 'getStablecoinHistory',
          summary: 'Volume / mint / burn time series',
          description: 'Bucketed series. `windowEnd` states which instant the range ends at — on a frozen chain that is the last indexed minute, not now.',
          parameters: [
            {
              name: 'token', in: 'query', required: false,
              schema: { type: 'string', enum: ['ALL', ...TOKENS], default: 'ALL' },
            },
            {
              name: 'range', in: 'query', required: false,
              description: 'Bucket sizes: ' + RANGE_KEYS.map((k) => `\`${k}\` → ${RANGES[k].group}s`).join(', ') + '.',
              schema: { type: 'string', enum: RANGE_KEYS, default: '24h' },
            },
          ],
          responses: { 200: ok('Time series.', schema('History')), ...COMMON },
        },
      },
      '/v1/stablecoins/{token}': {
        get: {
          tags: ['Stablecoins'], operationId: 'getStablecoin',
          summary: 'Per-token detail',
          description: 'Supply, dominance, velocity, 24h summary, net issuance and the transfer-size distribution.',
          parameters: [{
            name: 'token', in: 'path', required: true,
            schema: { type: 'string', enum: TOKENS },
          }],
          responses: {
            200: ok('Token detail.', schema('TokenDetail')),
            400: response('BadRequest'),
            ...COMMON,
          },
        },
      },

      // ---- ecosystem ----
      '/v1/protocols': {
        get: {
          tags: ['Ecosystem'], operationId: 'listProtocols',
          summary: 'Protocol registry with measured TVL',
          description: 'Every known protocol with its TVL, flow, status and official links. TVL is measured as stablecoin balances held by contracts, which needs no per-protocol adapter on a chain where value is denominated in USDC.',
          parameters: [csvParam],
          responses: { 200: withCsv('Registry joined to measured TVL.', schema('Protocols')), ...COMMON },
        },
      },
      '/v1/protocols/unnamed': {
        get: {
          tags: ['Ecosystem'], operationId: 'listUnnamedContracts',
          summary: 'Contracts holding balances nobody has claimed',
          description: 'Counted in the chain total and listed separately as unattributed. Hiding them would understate the chain; assigning them to a plausible protocol would invent data.',
          parameters: [csvParam],
          responses: { 200: withCsv('Unattributed contracts.', schema('UnnamedContracts')), ...COMMON },
        },
      },
      '/v1/protocols/{id}': {
        get: {
          tags: ['Ecosystem'], operationId: 'getProtocol',
          summary: 'Protocol detail',
          parameters: [{
            name: 'id', in: 'path', required: true,
            description: 'Registry id, as listed by `GET /v1/protocols`.',
            schema: { type: 'string' },
          }],
          responses: {
            200: ok('Protocol detail, with per-contract balances and recent flow.', schema('ProtocolDetail')),
            404: response('NotFound'),
            ...COMMON,
          },
        },
      },
      '/v1/tvl': {
        get: {
          tags: ['Ecosystem'], operationId: 'getTvl',
          summary: 'Total value locked, chain-wide',
          responses: { 200: ok('TVL totals, per token and per protocol.', schema('Tvl')), ...COMMON },
        },
      },
      '/v1/tvl/history': {
        get: {
          tags: ['Ecosystem'], operationId: 'getTvlHistory',
          summary: 'Daily TVL series',
          parameters: [
            { name: 'days', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 180, default: 30 } },
            {
              name: 'protocol', in: 'query', required: false,
              description: 'Registry id, or `*` for the chain total.',
              schema: { type: 'string', default: '*' },
            },
            csvParam,
          ],
          responses: { 200: withCsv('Daily TVL series.', schema('TvlHistory')), ...COMMON },
        },
      },
      '/v1/rankings': {
        get: {
          tags: ['Ecosystem'], operationId: 'getRankings',
          summary: 'Daily standings and digest',
          description: 'Daily protocol standings plus a ready-to-post text digest. Movements below the reporting threshold are omitted — a protocol drifting a fraction of a percent is not news.',
          responses: { 200: ok('Daily rankings.', schema('Rankings')), ...COMMON },
        },
      },
      '/v1/search': {
        get: {
          tags: ['Ecosystem'], operationId: 'search',
          summary: 'Search protocols, tokens and addresses',
          parameters: [
            { name: 'q', in: 'query', required: true, description: 'Query, minimum 2 characters.', schema: { type: 'string', minLength: 2 } },
            limitParam(25, 10),
          ],
          responses: { 200: ok('Matches, grouped by kind.', schema('SearchResults')), ...COMMON },
        },
      },

      // ---- addresses & transfers ----
      '/v1/addresses/top': {
        get: {
          tags: ['Addresses'], operationId: 'getTopAddresses',
          summary: 'Top addresses by volume',
          parameters: [limitParam(100, 20)],
          responses: { 200: ok('Ranked addresses.', schema('TopAddresses')), ...COMMON },
        },
      },
      '/v1/addresses/filtered': {
        get: {
          tags: ['Addresses'], operationId: 'getFilteredAddresses',
          summary: 'Addresses excluded from adjusted volume',
          description: [
            'The address-level noise filter, published so it can be disagreed with rather than trusted.',
            'Addresses whose activity rate exceeds the thresholds are treated as infrastructure. A transfer',
            'is dropped from adjusted volume only when **both** of its ends are flagged — Visa/Allium drop on',
            'either end; the departure is deliberate and the reason is measured and stated on /methodology.',
          ].join(' '),
          responses: { 200: ok('Flagged addresses and the thresholds that flagged them.', schema('FilteredAddresses')), ...COMMON },
        },
      },
      '/v1/address/{address}': {
        get: {
          tags: ['Addresses'], operationId: 'getAddress',
          summary: 'Per-address activity',
          parameters: [{
            name: 'address', in: 'path', required: true,
            schema: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
          }],
          responses: {
            200: ok('Address totals over the retained window, plus recent transfers.', schema('AddressDetail')),
            400: response('BadRequest'),
            ...COMMON,
          },
        },
      },
      '/v1/transfers/largest': {
        get: {
          tags: ['Addresses'], operationId: 'getLargestTransfers',
          summary: 'Largest transfers over a stated window',
          description: [
            'The largest transfers of the last `days` days, from the retained per-day set (top 100 per day per',
            'token, kept 180 days). Previously read from the rolling raw-transfer table, which is row-capped —',
            'so at real throughput "largest transfers" meant "largest of the last couple of minutes", with',
            'nothing in the response saying so. The window is now an argument and it is echoed back.',
          ].join(' '),
          parameters: [
            limitParam(100, 20),
            {
              name: 'days', in: 'query', required: false,
              description: 'Window in days, 1–180. Defaults to 7.',
              schema: { type: 'integer', minimum: 1, maximum: 180, default: 7 },
            },
          ],
          responses: { 200: ok('Largest transfers.', schema('LargestTransfers')), ...COMMON },
        },
      },

      // ---- alerts ----
      '/v1/alerts': {
        get: {
          tags: ['Alerts'], operationId: 'listAlerts',
          summary: 'List your alerts',
          responses: { 200: ok('Alerts owned by this key.', schema('AlertList')), ...COMMON },
        },
        post: {
          tags: ['Alerts'], operationId: 'createAlert',
          summary: 'Create a webhook alert',
          description: `Fires at most once per minute when a matching transfer is indexed. Free keys may hold ${TIERS.free.maxAlerts}, Pro keys ${TIERS.pro.maxAlerts}.`,
          requestBody: { required: true, content: { 'application/json': { schema: schema('AlertInput') } } },
          responses: {
            201: ok('Alert created.', schema('AlertCreated')),
            400: response('BadRequest'),
            402: response('AlertLimit'),
            ...COMMON,
          },
        },
      },
      '/v1/alerts/{id}': {
        delete: {
          tags: ['Alerts'], operationId: 'deleteAlert',
          summary: 'Delete an alert',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
          responses: {
            200: ok('Deleted.', { type: 'object', properties: { deleted: { type: 'integer' } } }),
            400: response('BadRequest'),
            404: response('NotFound'),
            ...COMMON,
          },
        },
      },

      // ---- billing ----
      '/v1/billing/order': {
        get: {
          tags: ['Billing'], operationId: 'getOrder',
          summary: 'Latest order and current tier',
          responses: { 200: ok('Latest order, tier and expiry.', schema('OrderStatus')), ...COMMON },
        },
        post: {
          tags: ['Billing'], operationId: 'createOrder',
          summary: 'Open a Pro order',
          description: 'Returns an address and an exact USDC amount. Send that amount and the key upgrades automatically once the payment is detected — no account, no card, no confirmation step. The amount is uniquified per order, so it must be sent exactly.',
          responses: {
            201: ok('Order opened.', schema('Order')),
            403: response('BillingDisabled'),
            409: response('AlreadyPro'),
            ...COMMON,
          },
        },
      },
    },

    components: {
      securitySchemes: {
        ApiKeyHeader: {
          type: 'apiKey', in: 'header', name: 'X-API-Key',
          description: 'The preferred form. Get a key from `POST /v1/keys`.',
        },
        ApiKeyQuery: {
          type: 'apiKey', in: 'query', name: 'key',
          description: 'Accepted for contexts that cannot set headers. Prefer the header: query strings end up in logs.',
        },
      },

      headers: {
        'X-RateLimit-Limit': { description: 'Requests allowed per minute for this key\'s tier.', schema: { type: 'integer' } },
        'X-RateLimit-Remaining': { description: 'Requests left in the current minute.', schema: { type: 'integer' } },
      },

      responses: {
        // No rate-limit headers here: the key is rejected before a tier is even looked up, so there
        // is no budget to report.
        Unauthorized: {
          description: 'Missing or invalid API key (`missing_api_key`, `invalid_api_key`).',
          content: { 'application/json': { schema: schema('Error') } },
        },
        RateLimited: {
          description: `Rate limit exceeded (\`rate_limited\`). Free: ${TIERS.free.rpm} req/min, Pro: ${TIERS.pro.rpm} req/min.`,
          headers: { ...RATE_HEADERS, 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds to wait.' } },
          content: { 'application/json': { schema: schema('Error') } },
        },
        KeyLimit: {
          description: 'Too many keys minted from this IP this hour (`key_limit_reached`). Reuse an existing key.',
          headers: { 'Retry-After': { schema: { type: 'integer' } } },
          content: { 'application/json': { schema: schema('Error') } },
        },
        Indexing: {
          description: 'The index is still warming up and has nothing honest to serve yet (`indexing`). Retry shortly.',
          headers: RATE_HEADERS,
          content: { 'application/json': { schema: schema('Error') } },
        },
        FeesUnavailable: {
          description: 'Fee sampling has not collected a sample yet (`no_fee_samples`). Reported as absent rather than as zero.',
          headers: RATE_HEADERS,
          content: { 'application/json': { schema: schema('Error') } },
        },
        BadRequest: {
          description: 'Invalid parameter (`bad_token`, `bad_address`, `bad_id`, `bad_min_amount`, `webhook_required`, `webhook_blocked`).',
          headers: RATE_HEADERS,
          content: { 'application/json': { schema: schema('Error') } },
        },
        NotFound: {
          description: 'No such resource (`not_found`).',
          headers: RATE_HEADERS,
          content: { 'application/json': { schema: schema('Error') } },
        },
        AlertLimit: {
          description: `This key already holds its tier's maximum alerts (\`alert_limit_reached\`).`,
          headers: RATE_HEADERS,
          content: { 'application/json': { schema: schema('Error') } },
        },
        BillingDisabled: {
          description: 'Pro billing is not open yet (`billing_disabled`).',
          headers: RATE_HEADERS,
          content: { 'application/json': { schema: schema('Error') } },
        },
        AlreadyPro: {
          description: 'This key is already Pro (`already_pro`).',
          headers: RATE_HEADERS,
          content: { 'application/json': { schema: schema('Error') } },
        },
      },

      schemas: {
        Error: {
          type: 'object', required: ['error'],
          properties: {
            error: { type: 'string', description: 'Stable machine-readable code. Branch on this, not on `hint`.' },
            hint: { type: 'string', description: 'Human-readable remedy. Wording may change.' },
          },
        },

        ChainState: {
          type: 'object',
          description: 'What the chain itself is doing, reported separately from whether this API is healthy.',
          properties: {
            state: {
              type: 'string',
              enum: ['live', 'halted', 'unauthorized', 'unreachable', 'unknown'],
              description: [
                '`live` — the head is advancing.',
                '`halted` — the RPC answers but the head has not moved.',
                '`unauthorized` — every endpoint answered and refused our credentials: our configuration to fix, not an outage.',
                '`unreachable` — nobody answered.',
                '`unknown` — not yet polled.',
              ].join(' '),
            },
            head: { type: ['integer', 'null'], description: 'Last block seen.' },
            stalledMs: num('How long the head has been frozen. Null while live, so nothing renders "stalled for 0s".'),
            lastContactMs: num('Time since an endpoint last answered.'),
            lastError: { type: ['string', 'null'] },
          },
        },

        Status: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', description: 'The index has data to serve.' },
            degraded: { type: 'boolean', description: 'True when the snapshot was rebuilt from stored history alone because the chain could not be read. Indexed figures are still served, labelled with when they were measured.' },
            chain: schema('ChainState'),
            index: schema('IndexProgress'),
            chainId: { type: 'integer', examples: [CHAIN.chainId] },
            network: { type: 'string', examples: [CHAIN.id] },
            windowEnd: { type: ['integer', 'null'], description: 'The instant every rolling window ends at (ms) — the newest measured minute.' },
            clockSkewSec: {
              type: ['integer', 'null'],
              description: [
                'How far the newest measured minute sits behind the wall clock. Near zero in normal operation.',
                'Bucket minutes are keyed by chain time, and every rolling window is anchored to it, so a large',
                'value here is what explains a 24h figure that looks impossibly quiet.',
              ].join(' '),
            },
            block: { type: ['integer', 'null'], description: 'Last indexed block *as of the newest snapshot*. Frozen while a long catch-up runs — prefer `index.checkpoint`, which is read live.' },
            indexLag: { type: ['integer', 'null'], description: 'Blocks between the chain head and the last indexed block, from the snapshot. Frozen during a catch-up; `index.behind` is the live equivalent.' },
            updatedAt: num('When this snapshot was assembled (ms).'),
            dataAt: num('When the newest indexed data was actually recorded (ms). On a frozen chain this and `updatedAt` are hours apart, and this is the one that says how stale the figures are.'),
            billingEnabled: { type: 'boolean' },
          },
        },

        IndexProgress: {
          type: 'object',
          description: [
            'How far the indexer is from the head, read live rather than from the snapshot.',
            '',
            'Every other figure in this response is assembled when a tick *completes*, so while the',
            'indexer replays a long stretch of history — after a restart against an old database, or',
            'a chain returning from a multi-day outage — they all freeze, and the reported lag grows',
            'more wrong the more progress is made. These four fields keep moving. Poll twice and the',
            'change in `behind` gives you a rate, which is why no ETA is invented here.',
          ].join('\n'),
          properties: {
            checkpoint: { type: ['integer', 'null'], description: 'Last block written to storage.' },
            head: { type: ['integer', 'null'], description: 'Chain head as last observed.' },
            behind: { type: ['integer', 'null'], description: 'Blocks between the two. Shrinking means progress; unchanged across several polls means stuck.' },
            catchingUp: { type: 'boolean', description: 'Further behind than a single indexing pass can close, i.e. replaying history rather than merely trailing the head.' },
          },
        },

        NewKey: {
          type: 'object',
          properties: {
            key: { type: 'string', examples: ['sbd_0123456789abcdef0123456789abcdef'] },
            tier: { type: 'string', enum: Object.keys(TIERS) },
            rpm: { type: 'integer', examples: [TIERS.free.rpm] },
            docs: { type: 'string' },
            note: { type: 'string' },
          },
        },

        Network: {
          type: 'object',
          properties: {
            block: { type: ['integer', 'null'] },
            blockTimeMs: num('Mean block time over the sampled headers.'),
            tps: num('Transactions per second.'),
            gasGwei: num('Gas price. Absent rather than stale when the chain cannot be read.'),
            costPerTransferUsdc: num('Cost of a 21k-gas transfer, in USDC.'),
            txPerDay: num('Extrapolated from the sampled rate.'),
            indexLag: { type: ['integer', 'null'] },
            updatedAt: num('ms'),
          },
        },

        Fees: {
          type: 'object',
          properties: {
            currency: { type: 'string', const: 'USDC' },
            perTransaction: num('Mean fee per transaction, in USDC.'),
            perBlock: num('Mean fee per block.'),
            perDay: num('Extrapolated daily total.'),
            perMillionMoved: num('The headline metric: what it costs the network to move $1M of real volume.'),
            inWindow: num('Total fees over the effective window.'),
            windowSec: num('Length of that window — the shorter of 24h and however much history is held, so a young index cannot pair a full day of fees with an hour of volume.'),
            avgGasPerTx: num('Mean gas used per transaction.'),
            gasGwei: num('Gas price at the last poll.'),
            sample: {
              type: 'object',
              description: 'What the extrapolation rests on. Exact for the blocks sampled; every derived rate carries this so an estimate is never read as a measured total.',
              properties: {
                blocks: { type: 'integer' },
                transactions: { type: 'integer' },
                coverage: num('Sampled blocks ÷ blocks in the window, capped at 1.'),
              },
            },
            note: { type: 'string' },
            updatedAt: num('ms'),
          },
        },

        TokenSummary: {
          type: 'object',
          description: 'The three volume measures, side by side. `volume` counts every Transfer event; `rvolume` is real (one largest transfer per transaction per token); `avolume` is adjusted (real, minus infrastructure-to-infrastructure).',
          properties: {
            volume: { type: 'number' }, transfers: { type: 'integer' },
            rvolume: { type: 'number' }, rtransfers: { type: 'integer' },
            avolume: { type: 'number' }, atransfers: { type: 'integer' },
            mint: { type: 'number' }, burn: { type: 'number' },
          },
        },

        Summary24h: {
          type: 'object',
          properties: {
            byToken: { type: 'object', additionalProperties: schema('TokenSummary') },
            volume: { type: 'number' }, transfers: { type: 'integer' },
            rvolume: { type: 'number' }, rtransfers: { type: 'integer' },
            avolume: { type: 'number' }, atransfers: { type: 'integer' },
          },
        },

        TokenSupply: {
          type: 'object',
          properties: {
            supply: num('Read with `totalSupply()`. Null — not zero — when the chain has never been reachable: zero is a measurement, null is the absence of one.'),
            denomination: { type: ['string', 'null'], description: 'The currency this token is denominated in (ISO code), declared rather than inferred. Null when undeclared.' },
            dominance: num('Share of the supply denominated in the same currency, 0–1 — not of a cross-currency sum.'),
            volShare: num('Share of real volume, 0–1.'),
            velocity: num('Real transfers per day ÷ supply.'),
            rvolume24h: { type: 'number' },
            avolume24h: { type: 'number' },
          },
        },

        Stablecoins: {
          type: 'object',
          properties: {
            supply: { type: 'object', additionalProperties: schema('TokenSupply'), description: `Keyed by symbol: ${TOKENS.join(', ')}.` },
            totalSupply: num('Face values added across every tracked token, with NO currency conversion — dollars and euros summed as if they were one unit. Kept for consumers already reading it; it is not a quantity of anything. Use byDenomination.'),
            byDenomination: {
              type: 'object',
              description: 'Supply grouped by the currency it is denominated in, and never summed across groups. Converting would need an exchange rate, and this API has no price feed and no oracle anywhere in it — the same rule that makes the fee figures directly measured.',
              additionalProperties: {
                type: 'object',
                properties: {
                  supply: { type: 'number', description: 'Total supply in this denomination, in its own currency units.' },
                  tokens: { type: 'array', items: { type: 'string' }, description: 'The symbols that make it up.' },
                },
              },
            },
            undeclaredSupply: {
              type: ['object', 'null'],
              description: 'Tracked symbols whose denomination has not been declared, with their supply. Null in the ordinary case. Their supply is in no currency total — a denomination we have not declared is not evidence of zero dollars, so it is stated rather than dropped.',
            },
            summary24h: schema('Summary24h'),
            coverage: {
              type: 'object',
              description: 'How much history actually backs `summary24h`. It sums everything since 24h ago, '
                + 'so on a young or freshly-restarted index the window is shorter than the name — read `minutes` '
                + 'before labelling these figures as a day.',
              properties: {
                fromMinute: { type: 'integer', nullable: true, description: 'First measured minute, unix seconds.' },
                toMinute: { type: 'integer', nullable: true, description: 'Last measured minute, unix seconds.' },
                minutes: { type: 'integer', description: 'Minutes of history held. 1440 is a full day.' },
              },
            },
            windowEnd: num('ms — the instant the 24h window ends at, in chain time.'),
            updatedAt: num('ms'),
          },
        },

        History: {
          type: 'object',
          properties: {
            token: { type: 'string' },
            group: { type: 'integer', description: 'Bucket size in seconds.' },
            windowEnd: { type: 'integer', description: 'The instant the range ends at (ms) — the newest measured minute, which is chain time. Label the series with this rather than assuming it runs to the moment of the call.' },
            source: {
              type: 'string', enum: ['minute', 'daily'],
              description: 'Which table answered. Per-minute aggregates are a rolling 7 days; anything longer is served from the per-day rollup, which is kept indefinitely.',
            },
            since: { type: 'integer', description: 'The instant the range asked for, unix seconds. 0 on `range=all`.' },
            recordBegan: {
              type: ['integer', 'null'],
              description: 'Where the answering table\'s history starts, unix seconds. When this is later than `since`, the series is bounded by how long the record has existed rather than by the range — a 90-day range drawn from a rollup that began last week is a one-week series wearing a 90-day label, and this is how you can tell.',
            },
            series: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  t: { type: 'integer', description: 'Bucket start, unix seconds — a minute boundary or a day boundary depending on `source`.' },
                  volume: { type: 'number' }, cnt: { type: 'integer' },
                  rvolume: { type: 'number' }, avolume: { type: 'number' },
                  mint: { type: 'number' }, burn: { type: 'number' },
                },
              },
            },
          },
        },

        TokenDetail: {
          type: 'object',
          properties: {
            token: { type: 'string' },
            supply: schema('TokenSupply'),
            summary24h: { anyOf: [schema('TokenSummary'), { type: 'null' }] },
            netIssuance24h: num('mint − burn over the rolling 24h.'),
            distribution: {
              type: 'object',
              description: 'Transfer-size histogram over the retained transfer window, published with the window it covers.',
              properties: {
                window: schema('TransferWindow'),
                total: { type: 'integer' },
                brackets: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', examples: SIZE_BRACKETS.map((b) => b.label) },
                      min: { type: 'number' },
                      max: { type: ['number', 'null'], description: 'Null on the open-ended top bracket.' },
                      count: { type: 'integer' },
                    },
                  },
                },
              },
            },
            updatedAt: num('ms'),
          },
        },

        Protocol: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            category: { type: 'string', enum: Object.keys(CATEGORIES) },
            tvl: { type: 'number', description: 'Stablecoin balances held by this protocol\'s contracts.' },
            tvlByToken: { type: 'object', additionalProperties: { type: 'number' } },
            contracts: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: true,
        },

        Protocols: {
          type: 'object',
          properties: {
            protocols: { type: 'array', items: schema('Protocol') },
            registry: {
              type: 'object',
              description: 'Registry counts. `verified` separates entries confirmed against the chain from ones merely listed.',
              properties: {
                total: { type: 'integer' },
                verified: { type: 'integer' },
                unverified: { type: 'integer' },
                contracts: { type: 'integer' },
                byCategory: { type: 'object', additionalProperties: { type: 'integer' } },
              },
              additionalProperties: true,
            },
            categories: {
              type: 'object',
              description: 'Category vocabulary, keyed by the id used in `Protocol.category`.',
              additionalProperties: {
                type: 'object',
                properties: { label: { type: 'string' }, desc: { type: 'string' } },
              },
            },
            totals: schema('TvlTotals'),
            method: { type: 'string' },
            updatedAt: num('When the balance scan last completed (ms).'),
          },
        },

        TvlTotals: {
          type: 'object',
          properties: {
            tvl: { type: 'number', description: 'Chain-wide total, attributed and unattributed together.' },
            byToken: { type: 'object', additionalProperties: { type: 'number' } },
            attributed: { type: 'number', description: 'Held by contracts a registry entry claims.' },
            unattributed: { type: 'number', description: 'Held by contracts nobody has named. Counted in `tvl` and reported separately — hiding it would understate the chain, and assigning it to a plausible protocol would invent data.' },
            attributedShare: { type: 'number', description: 'How much of the locked value the registry can actually name, 0–1. Reported next to the total, never instead of it.' },
            holders: { type: 'integer', description: 'Distinct contracts holding a balance.' },
            coverage: {
              type: 'object',
              description: [
                'How much of the chain the total covers. One pass reads balanceOf for every tracked asset against',
                'every target, so the target count is capped; targets are ordered by last-read balance, then by',
                'volume moved. Past the cap the total is a lower bound, and `atCap` is how you know.',
              ].join(' '),
              properties: {
                scanned: { type: 'integer', description: 'Contracts read in the most recent pass.' },
                knownContracts: { type: ['integer', 'null'], description: 'How many contracts exist to scan.' },
                cap: { type: 'integer', description: 'Ceiling on a single pass, not on what is ever measured.' },
                atCap: {
                  type: 'boolean',
                  description: 'True when one pass cannot cover every known contract. Since the scan rotates, this no longer means the remainder is never read — it means the total mixes readings from more than one pass. See cycleLength and oldestReadingMs.',
                },
                alwaysTop: { type: 'integer', description: 'Highest-value contracts re-read on every pass.' },
                rotatingSlice: { type: 'integer', description: 'Contracts taken from the rotation each pass.' },
                cycleLength: { type: 'integer', description: 'Passes needed to visit every known contract once.' },
                oldestReadingMs: { type: ['integer', 'null'], description: 'When the oldest balance still counted in the total was read (ms). The honest cost of rotating: a figure mixing fresh and older readings has to say so.' },
                order: { type: 'string', description: 'How the per-pass budget is spent.' },
              },
            },
            warning: { type: 'string', description: 'Present only while coverage is truncated.' },
          },
        },

        UnnamedContracts: {
          type: 'object',
          properties: {
            candidates: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  address: { type: 'string' },
                  tvl: { type: 'number' },
                  byToken: { type: 'object', additionalProperties: { type: 'number' } },
                  selfName: {
                    type: ['string', 'null'],
                    description: 'What the contract answers to name(). Read from the contract, so it is a fact about the contract — not an attribution to an operator. These rows stay unattributed until a registry entry claims them.',
                  },
                  selfSymbol: { type: ['string', 'null'], description: 'What the contract answers to symbol().' },
                  kind: { type: ['string', 'null'], description: 'Classification derived by the entity deriver, when it has looked at this address.' },
                  codeSize: { type: ['integer', 'null'], description: 'Bytecode length. Identical sizes across addresses usually mean one contract deployed several times.' },
                },
                additionalProperties: true,
              },
            },
            unattributed: { type: 'number' },
            note: { type: 'string' },
            updatedAt: num('ms'),
          },
        },

        ProtocolDetail: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            tvl: { type: 'number' },
            contracts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  address: { type: 'string' },
                  label: { type: ['string', 'null'] },
                  tvl: { type: 'number' },
                  byToken: { type: 'object', additionalProperties: { type: 'number' } },
                  windowVolume: { type: 'number' },
                  windowTransfers: { type: 'integer' },
                  lastBlock: { type: ['integer', 'null'] },
                },
              },
            },
            recent: { type: 'array', items: schema('Transfer') },
          },
          additionalProperties: true,
        },

        Tvl: {
          allOf: [
            schema('TvlTotals'),
            {
              type: 'object',
              properties: {
                method: { type: 'string' },
                series: schema('TvlSeries'),
                protocols: {
                  type: 'array',
                  description: 'Protocols holding a non-zero balance.',
                  items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, tvl: { type: 'number' } } },
                },
                updatedAt: num('ms'),
              },
            },
          ],
        },

        TvlSeries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              day: { type: 'integer', description: 'Start of the day, unix seconds (a multiple of 86400).' },
              tvl: { type: 'number' },
            },
          },
        },

        TvlHistory: {
          type: 'object',
          properties: {
            protocol: { type: 'string' },
            days: { type: 'integer' },
            series: schema('TvlSeries'),
          },
        },

        ChainUptime: {
          type: 'object',
          description: 'Availability over a window, with the observed share it was computed from.',
          properties: {
            window: {
              type: 'object',
              properties: { from: { type: 'integer' }, to: { type: 'integer' }, days: { type: 'integer' } },
            },
            recordBegan: {
              type: ['integer', 'null'],
              description: 'When the transition log starts (unix ms). A window reaching before this is only partly covered.',
            },
            windowMs: { type: 'integer' },
            upMs: { type: 'integer', description: 'Observed time the head was advancing.' },
            downMs: { type: 'integer', description: 'Observed time the chain was halted or unreachable.' },
            observedMs: { type: 'integer', description: 'upMs + downMs — the only time any percentage here is computed over.' },
            unobservedMs: { type: 'integer', description: 'Time we were not watching, including while our own credentials were refused.' },
            byState: {
              type: 'object',
              description: 'Milliseconds per state, so the up/down boundary can be redrawn by the consumer.',
              properties: Object.fromEntries(
                ['live', 'halted', 'unreachable', 'unauthorized', 'unobserved', 'unknown']
                  .map((s) => [s, { type: 'integer' }]),
              ),
            },
            uptimePct: num('upMs as a share of observedMs. Null when nothing was observed — never 100.'),
            coveragePct: num('observedMs as a share of windowMs. Read this first.'),
            seenThrough: num('How far the record extends (unix ms). Past this, nothing is claimed.'),
            incidents: { type: 'array', items: schema('ChainIncident') },
          },
        },

        ChainIncident: {
          type: 'object',
          description: 'One non-live episode, most recent first.',
          properties: {
            state: { type: 'string', enum: ['halted', 'unreachable', 'unauthorized', 'unobserved', 'unknown'] },
            verdict: { type: 'string', enum: ['down', 'unobserved'], description: 'Whether this episode counts against the chain.' },
            blame: {
              type: 'string', enum: ['chain', 'stabledesk', 'unknown'],
              description: 'Whose failure it was. `stabledesk` covers our own outages and rejected credentials, published rather than hidden.',
            },
            from: { type: 'integer' }, to: { type: 'integer' }, ms: { type: 'integer' },
            ongoing: { type: 'boolean', description: 'The episode had not ended by the edge of what we observed.' },
            head: { type: ['integer', 'null'] },
            error: { type: ['string', 'null'] },
          },
        },

        Rankings: {
          type: 'object',
          properties: { digest: { type: 'string', description: 'Ready-to-post text summary of the day\'s movements.' } },
          additionalProperties: true,
        },

        SearchResults: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            protocols: { type: 'array', items: { type: 'object', additionalProperties: true } },
            tokens: { type: 'array', items: { type: 'object', additionalProperties: true } },
            addresses: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },

        TopAddresses: {
          type: 'object',
          properties: {
            top: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  address: { type: 'string' },
                  transfers: { type: 'integer' },
                  volume: { type: 'number' },
                  label: { type: ['string', 'null'], description: 'Known-entity name, or null when unidentified.' },
                },
              },
            },
          },
        },

        FilteredAddresses: {
          type: 'object',
          properties: {
            flagged: { type: 'integer', description: 'Addresses actually in the flag set.' },
            // These four are the mechanism that says adjusted volume is a lower bound, and they were
            // served without ever being declared — so a generated, typed client dropped them silently
            // and its user could never learn the set was truncated. An honesty signal that exists only
            // in the JSON and not in the contract is an honesty signal for people reading curl output.
            qualifying: {
              type: ['integer', 'null'],
              description: 'How many addresses the published thresholds select, before the cap is applied. Equal to flagged in the ordinary case; larger when the cap is binding.',
            },
            cap: { type: ['integer', 'null'], description: 'Ceiling on the size of the flag set.' },
            atCap: {
              type: 'boolean',
              description: 'True when qualifying exceeds cap. Which addresses are flagged is then decided by the cap and a volume ordering rather than by the published thresholds, so adjusted volume is a lower bound on what the rule would exclude. Raw and real volume are unaffected.',
            },
            warning: { type: 'string', description: 'Present only while atCap is true, spelling out the consequence in prose.' },
            thresholds: {
              type: 'object',
              description: 'Per-day rates. Visa/Allium exclude an address exceeding 1,000 transactions or $10M of volume in a month; these are the same limits expressed daily, because the retained window is rolling rather than a calendar month.',
              properties: { transfersPerDay: { type: 'number' }, volumePerDay: { type: 'number' } },
            },
            window: {
              type: 'object',
              description: [
                'How the per-day rates above become an absolute limit. Each address is measured over its *own*',
                'observed span — the first block it was seen in to the last — so there is no single window here:',
                '`windowDays`, `maxTransfers` and `maxVolume` ride on each address below, and those are the limits',
                'it was actually judged against. `blockMs` is the only input that converts a block span to days.',
              ].join(' '),
              properties: {
                perAddress: { type: 'boolean', description: 'Always true. Present so a client written against the old chain-wide window fails loudly rather than reading undefined.' },
                minDays: { type: 'number', description: 'Floor on an address\'s window. Without it, an address first seen inside one block has a near-zero span and any activity is an infinite rate.' },
                blockMs: { type: ['number', 'null'], description: 'Measured average block time, used to convert a block span into days.' },
              },
            },
            excludedVolume24h: num('Real volume dropped from adjusted, over 24h.'),
            excludedShare: num('That volume as a share of real volume, 0–1.'),
            addresses: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  address: { type: 'string' },
                  transfers: { type: 'integer' },
                  volume: { type: 'number' },
                  label: { type: ['string', 'null'] },
                  windowDays: { type: 'number', description: 'This address\'s own observed span, in days, floored at one.' },
                  maxTransfers: { type: 'number', description: 'The transfer limit derived from that span — what it was actually compared against.' },
                  maxVolume: { type: 'number', description: 'The volume limit derived from that span.' },
                  firstBlock: { type: ['integer', 'null'], description: 'First block this address was seen in. Null on rows written before the span was recorded; those fall back to the one-day floor.' },
                  lastBlock: { type: 'integer' },
                  reason: { type: 'string', enum: ['volume', 'frequency'], description: 'An address can breach both limits; this names the one it breaches hardest, relatively.' },
                },
                additionalProperties: true,
              },
            },
            note: { type: 'string' },
            updatedAt: num('ms'),
          },
        },

        Transfer: {
          type: 'object',
          properties: {
            token: { type: 'string' },
            frm: { type: 'string', description: 'Sender. The zero address means a mint.' },
            too: { type: 'string', description: 'Recipient. The zero address means a burn.' },
            amount: { type: 'number' },
            block: { type: 'integer' },
            ts: { type: 'integer', description: 'Unix seconds, interpolated between the measured timestamps of its indexed range\'s first and last block.' },
          },
        },

        TransferWindow: {
          type: 'object',
          description: [
            'The span of the retained raw-transfer table — what the size distribution and the `recent` lists',
            'are describing. It is bounded by both a 24h clock and a row cap, so its actual length depends on',
            'how busy the chain is, which is why it is measured and published rather than stated once.',
          ].join(' '),
          properties: {
            rows: { type: 'integer' },
            fromTs: { type: ['integer', 'null'], description: 'Oldest retained transfer, unix seconds.' },
            toTs: { type: ['integer', 'null'] },
            spanSec: { type: 'integer' },
            cap: { type: 'integer', description: 'Row ceiling.' },
            atCap: { type: 'boolean', description: 'True when the row cap rather than the 24h clock is deciding how far back the table reaches.' },
          },
        },

        LargestTransfers: {
          type: 'object',
          description: 'Largest transfers over an explicit window, from the retained per-day set rather than from the rolling raw table.',
          properties: {
            days: { type: 'integer', description: 'The window this answered over.' },
            window: {
              type: 'object',
              properties: { from: { type: 'integer' }, to: { type: 'integer' } },
            },
            note: { type: 'string' },
            transfers: { type: 'array', items: schema('Transfer') },
          },
        },

        AddressDetail: {
          type: 'object',
          properties: {
            address: { type: 'string' },
            transfers: { type: 'integer' },
            volume: { type: 'number' },
            last_block: { type: 'integer' },
            first_block: { type: ['integer', 'null'], description: 'First block this address was seen in — the start of the span its activity rate is measured over.' },
            label: { type: ['string', 'null'] },
            transferWindow: { anyOf: [schema('TransferWindow'), { type: 'null' }] },
            recent: { type: 'array', items: schema('Transfer'), description: 'Up to 25 most recent transfers touching this address, within `transferWindow`.' },
            largest: {
              type: 'array', items: schema('Transfer'),
              description: 'Largest transfers touching this address, from the retained per-day set — so they do not expire with the window above.',
            },
          },
        },

        AlertInput: {
          type: 'object', required: ['webhook'],
          properties: {
            webhook: { type: 'string', format: 'uri', description: 'Public https URL (Discord, Slack or Telegram). localhost and private IPs are rejected.' },
            token: { type: 'string', enum: TOKENS, description: 'Restrict to one token. Omit for all.' },
            address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', description: 'Restrict to transfers touching this address. Omit for all.' },
            minAmount: { type: 'number', minimum: 0, default: 0 },
          },
        },

        AlertCreated: {
          type: 'object',
          properties: { id: { type: 'integer' }, message: { type: 'string' } },
        },

        AlertList: {
          type: 'object',
          properties: {
            tier: { type: 'string', enum: Object.keys(TIERS) },
            max: { type: 'integer' },
            alerts: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },

        Order: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            amount: { type: 'string', description: 'Exact amount to send, uniquified per order so the payment can be matched. Send it exactly.' },
            currency: { type: 'string', const: 'USDC' },
            chain: { type: 'string' },
            chainId: { type: 'integer' },
            tokenAddress: { type: 'string' },
            payTo: { type: 'string' },
            expiresInMinutes: { type: 'integer' },
            note: { type: 'string' },
          },
        },

        OrderStatus: {
          type: 'object',
          properties: {
            order: {
              anyOf: [{
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  amount: { type: 'number' },
                  status: { type: 'string' },
                  created: { type: 'integer' },
                  paidAt: { type: ['integer', 'null'] },
                },
              }, { type: 'null' }],
            },
            tier: { type: 'string', enum: Object.keys(TIERS) },
            expiresAt: { type: ['integer', 'null'] },
          },
        },
      },
    },
  };
}

// Everything the document reads is fixed at boot, so build and serialise it once.
let cachedSpec = null;
export const spec = () => (cachedSpec ??= build());

let cachedJson = null;
export const specJson = () => (cachedJson ??= JSON.stringify(spec(), null, 2));

// ---- /llms.txt ----
// The llms.txt convention: a short markdown index that tells a model what this site is and where
// the machine-readable surfaces are, without making it parse the HTML pages to find out. Generated
// alongside the spec so the two can't disagree about which tokens exist or what a tier allows.
let cachedLlms = null;
export const llmsTxt = () => (cachedLlms ??= buildLlmsTxt());

function buildLlmsTxt() {
  const tokens = TOKENS.join(', ');
  return `# Stabledesk

> Stablecoin measurement for ${CHAIN.label} (chain id ${CHAIN.chainId}) — supply, real volume, TVL,
> flows and network fee economics, read straight from the chain. Free JSON API, published method.

Stabledesk is not a block explorer; it is the stablecoin-finance analytics layer for ${CHAIN.label}.
Tracked assets: ${tokens}.

Three things worth knowing before quoting any figure from this API:

- **Three volume measures are published side by side**, never blended into one: raw (every Transfer
  event), real (one largest transfer per transaction per token, so routing hops and contract
  internals are not double-counted) and adjusted (real, minus infrastructure talking to
  infrastructure). Quoting "volume" without saying which one is quoting an ambiguous number.
- **Absent beats stale.** A figure that could not be measured is \`null\`, never a carried-over
  previous value. Supply reads \`null\`, not \`0\`, when the chain has never been reachable.
- **Windows re-anchor when the chain freezes.** The rolling 24h windows end at \`windowEnd\`, which
  equals now while live and the last indexed minute once frozen. Check \`GET /v1/status\` for
  \`degraded\` and \`chain.state\` before treating a timestamp as current.

Gas on ${CHAIN.label} is paid in USDC, so all fee figures are dollars taken from transaction
receipts — no price feed or oracle is involved. Fees rest on sampled blocks and every derived rate
reports its sample size.

## API

- [OpenAPI 3.1 specification](${SITE_ORIGIN}/openapi.json): complete machine-readable description of every /v1 endpoint
- [Developer docs](${SITE_ORIGIN}/docs): endpoints, authentication, tiers and examples
- [Get a free API key](${SITE_ORIGIN}/docs): \`POST /v1/keys\`, then send \`X-API-Key\` — ${TIERS.free.rpm} req/min free, ${TIERS.pro.rpm} req/min Pro
- [Status](${SITE_ORIGIN}/v1/status): chain liveness and index health, no key required

## Method

- [Measurement method](${SITE_ORIGIN}/methodology): every filter and every threshold, as published numbers
- [Excluded addresses](${SITE_ORIGIN}/docs): the noise filter, and where it departs from the Visa/Allium standard and why

## Pages

- [Terminal](${SITE_ORIGIN}/): live supply, volume, fee economics and largest transfers
- [Ecosystem](${SITE_ORIGIN}/ecosystem): every protocol with measured TVL, flow and status
- [Entities](${SITE_ORIGIN}/entities): derived attributes for the addresses carrying most flow
- [Status](${SITE_ORIGIN}/status): chain and indexer health

## Optional

- [Source](https://github.com/moreno-g/stabledesk): read-only indexer, zero dependencies
- [Protocol registry contributions](${SITE_ORIGIN}/ecosystem): identify a contract holding unattributed balances
`;
}
