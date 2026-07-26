// CSV rendering for the API's `?format=csv`.
//
// Analysts live in spreadsheets, and "paste this URL into a sheet" is a lower barrier than any
// SDK. Costs a few lines; removes a reason to leave.

// RFC 4180: quote a field if it contains a delimiter, quote or newline, and double any inner quote.
// A leading =, +, - or @ is prefixed with a tab as well — spreadsheets treat those as formulas, and
// an address or label starting with one would otherwise be executed rather than displayed.
function cell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = '\t' + s;
  return /[",\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}

// `columns` is an array of [header, accessor] pairs — an explicit projection, so adding a field to
// an API response can never silently change the shape of somebody's saved CSV import.
export function toCsv(rows, columns) {
  const head = columns.map(([h]) => cell(h)).join(',');
  const body = (rows || []).map((r) => columns.map(([, get]) => cell(typeof get === 'function' ? get(r) : r[get])).join(','));
  return [head, ...body].join('\r\n') + '\r\n';
}

export function csvResponse(res, filename, rows, columns, headers = {}) {
  const body = toCsv(rows, columns);
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '')}"`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex',
    ...headers,
  });
  res.end(body);
}

// Column sets, defined once so /api and /v1 export identical files.
export const PROTOCOL_COLUMNS = [
  ['id', 'id'],
  ['name', 'name'],
  ['vendor', 'vendor'],
  ['category', 'category'],
  ['tvl', 'tvl'],
  ['window_volume', 'windowVolume'],
  ['window_transfers', 'windowTransfers'],
  ['contracts', (r) => (r.contracts || []).join(' ')],
  ['contracts_with_balance', 'contractsWithBalance'],
  ['observed', (r) => (r.observed ? 'true' : 'false')],
  ['verified', (r) => (r.verified ? 'true' : 'false')],
  ['source', 'source'],
  ['networks', (r) => (r.networks || []).join(' ')],
  ['site', (r) => r.links?.site || ''],
];

export const CANDIDATE_COLUMNS = [
  ['address', 'address'],
  ['label', 'label'],
  ['tvl', 'tvl'],
  ['volume', 'volume'],
  ['transfers', 'transfers'],
];

export const TVL_HISTORY_COLUMNS = [
  ['day', (r) => new Date(r.day * 1000).toISOString().slice(0, 10)],
  ['tvl', 'tvl'],
];
