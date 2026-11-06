// Page templates: {{KEY}} placeholders filled at request time (serveTemplated in server.js). Kept
// apart from the server, which starts listening on import, so the filling itself can be tested.

// For text and attribute values alike: the five characters that can end either.
export const escAttr = (s) => String(s == null ? '' : s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

// `vars` are escaped. `raw` is markup the repo itself ships (a report body), inserted unescaped and
// after `vars`, so nothing inside it can be read as a placeholder. Replacements are functions, not
// strings: a string replacement reads "$&", "$'", "$`" and "$$" as patterns, and a report is full of
// dollar amounts.
export function fillTemplate(html, vars = {}, raw = {}) {
  for (const [k, v] of Object.entries(vars)) html = html.replaceAll('{{' + k + '}}', () => escAttr(v));
  for (const [k, v] of Object.entries(raw)) html = html.replaceAll('{{' + k + '}}', () => v);
  return html;
}
