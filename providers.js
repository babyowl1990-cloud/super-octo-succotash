/* AutoFix Spelling — AI providers for the optional ✨ rewrite. Shared by the background worker and the popup.
 * Pure helpers (no chrome.* calls except afxLoadConfig), so they can be unit-tested in Node. */
const AFX_PROVIDERS = {
  anthropic:  { label: 'Anthropic (Claude)', kind: 'anthropic', url: 'https://api.anthropic.com/v1/messages', model: 'claude-haiku-5-5', keyHint: 'sk-ant-…' },
  openai:     { label: 'OpenAI', kind: 'openai', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', keyHint: 'sk-…' },
  gemini:     { label: 'Google Gemini', kind: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent', model: 'gemini-3.5-flash', keyHint: 'AIza…' },
  openrouter: { label: 'OpenRouter', kind: 'openai', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'openai/gpt-4o-mini', keyHint: 'sk-or-…' },
  groq:       { label: 'Groq', kind: 'openai', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.1-8b-instant', keyHint: 'gsk_…' },
  mistral:    { label: 'Mistral', kind: 'openai', url: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-small-latest', keyHint: 'API key' },
  ollama:     { label: 'Ollama (local, no key)', kind: 'openai', url: 'http://localhost:11434/v1', model: 'llama3.2', keyless: true, editableUrl: true, keyHint: '' },
  custom:     { label: 'Custom (OpenAI-compatible)', kind: 'openai', url: '', model: '', keyOptional: true, editableUrl: true, keyHint: 'API key (optional)' }
};

function afxIsLoopback(url) {
  try { const h = new URL(url).hostname; return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'; } catch (e) { return false; }
}

/* https only — except loopback, so local servers (Ollama, LM Studio…) work over http */
function afxValidateUrl(url) {
  let u;
  try { u = new URL(url); } catch (e) { throw new Error('That isn’t a valid URL.'); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && afxIsLoopback(url))) throw new Error('Use an https:// URL (plain http is only allowed for localhost).');
  return u;
}

/* The exact URL a request goes to for this provider/config. */
function afxEndpoint(provider, baseUrl, model) {
  const p = AFX_PROVIDERS[provider];
  if (!p) throw new Error('Unknown provider.');
  let url = p.url;
  if (p.editableUrl) {
    url = (baseUrl || p.url || '').trim();
    if (!url) throw new Error('Enter the server URL, e.g. https://my-server/v1');
    url = url.replace(/\/+$/, '');
    if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';
  }
  if (p.kind === 'gemini') url = url.replace('{model}', encodeURIComponent(String(model).replace(/^models\//, '')));
  afxValidateUrl(url);
  return url;
}

const afxOriginPattern = url => new URL(url).origin + '/*';

/* {url, init} ready for fetch(). cfg: {key, model} */
function afxBuildRequest(provider, cfg, system, userText, maxTokens) {
  const p = AFX_PROVIDERS[provider];
  const url = afxEndpoint(provider, cfg.url, cfg.model);
  const headers = { 'content-type': 'application/json' };
  let body;
  if (p.kind === 'anthropic') {
    headers['x-api-key'] = cfg.key;
    headers['anthropic-version'] = '2023-06-01';
    body = { model: cfg.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userText }] };
  } else if (p.kind === 'gemini') {
    headers['x-goog-api-key'] = cfg.key;
    body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: userText }] }] };
  } else {
    if (cfg.key) headers['authorization'] = 'Bearer ' + cfg.key;
    body = { model: cfg.model, messages: [{ role: 'system', content: system }, { role: 'user', content: userText }] };
  }
  return { url, init: { method: 'POST', headers, body: JSON.stringify(body) } };
}

/* Pull the reply text out of each provider's response shape. */
function afxParse(kind, data) {
  if (!data) return '';
  if (kind === 'anthropic') return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  if (kind === 'gemini') {
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    return parts.filter(x => typeof x.text === 'string' && !x.thought).map(x => x.text).join('').trim();
  }
  const c = ((data.choices || [])[0] || {}).message || {};
  if (typeof c.content === 'string') return c.content.trim();
  if (Array.isArray(c.content)) return c.content.map(x => x.text || '').join('').trim();
  return '';
}

function afxHttpError(status, data) {
  const m = data && data.error && (data.error.message || (typeof data.error === 'string' ? data.error : ''));
  const detail = m ? String(m).slice(0, 160) : '';
  if (status === 401) return 'The API key was rejected (401). Check it in the popup.';
  if (status === 403) return 'Not allowed (403) — the key can’t use this model/endpoint' + (detail ? ': ' + detail : '.');
  if (status === 404) return 'Model or endpoint not found (404) — check the model name in the popup.';
  if (status === 429) return 'Rate limited or out of quota (429)' + (detail ? ': ' + detail : ' — wait a moment and try again.');
  if (status >= 500) return 'The provider is busy right now (' + status + '). Try again shortly.';
  return 'Request failed (' + status + ')' + (detail ? ': ' + detail : '');
}

/* Settings live in chrome.storage.local: {provider, keys:{id:key}, models:{id:model}, urls:{id:url}} */
async function afxLoadConfig() {
  const s = await chrome.storage.local.get({ provider: 'anthropic', keys: {}, models: {}, urls: {}, apiKey: '', rewriteModel: '' });
  if (s.apiKey) {                                   // migrate the v0.3 single-key layout
    s.keys.anthropic = s.keys.anthropic || s.apiKey;
    if (s.rewriteModel) s.models.anthropic = s.models.anthropic || s.rewriteModel;
    await chrome.storage.local.set({ keys: s.keys, models: s.models });
    await chrome.storage.local.remove(['apiKey', 'rewriteModel']);
  }
  return s;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { AFX_PROVIDERS, afxEndpoint, afxBuildRequest, afxParse, afxHttpError, afxValidateUrl, afxIsLoopback, afxOriginPattern };
