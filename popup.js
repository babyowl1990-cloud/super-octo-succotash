const $ = id => document.getElementById(id);
const TOGGLES = ['enabled', 'autoFix', 'grammarFix', 'capSentence', 'capI', 'underline', 'underlineAll', 'suggest', 'style', 'doubleSpace', 'smartPunct', 'rewriteEnabled'];
let host = null, settings = AFX_DEFAULTS;

chrome.storage.sync.get(AFX_DEFAULTS, async s => {
  settings = s;
  TOGGLES.forEach(k => {
    $(k).checked = !!s[k];
    $(k).addEventListener('change', () => chrome.storage.sync.set({ [k]: $(k).checked }));
  });
  $('custom').value = (s.custom || []).join('\n');
  $('snippets').value = Object.entries(s.snippets || {}).map(([k, v]) => `${k} => ${String(v).replace(/\n/g, '\\n')}`).join('\n');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    host = new URL(tab.url).hostname || null;
  } catch (e) { host = null; }
  renderSite();
});

const isOff = () => (settings.disabledSites || []).includes(host);
function renderSite() {
  const b = $('site');
  if (!host) { b.textContent = 'Site controls unavailable here'; b.disabled = true; return; }
  b.textContent = isOff() ? `Enable on ${host}` : `Disable on ${host}`;
}
$('site').addEventListener('click', () => {
  const list = new Set(settings.disabledSites || []);
  isOff() ? list.delete(host) : list.add(host);
  settings.disabledSites = [...list];
  chrome.storage.sync.set({ disabledSites: settings.disabledSites }, renderSite);
});
function saved(id) { $(id).textContent = 'Saved'; setTimeout(() => ($(id).textContent = ''), 1500); }
$('save').addEventListener('click', () => {
  const custom = [...new Set($('custom').value.split('\n').map(w => w.trim().toLowerCase()).filter(Boolean))];
  settings.custom = custom;
  chrome.storage.sync.set({ custom }, () => saved('ok'));
});
$('saveSn').addEventListener('click', () => {
  const snippets = {};
  for (const line of $('snippets').value.split('\n')) {
    const i = line.indexOf('=>');
    if (i < 1) continue;
    const k = line.slice(0, i).trim(), v = line.slice(i + 2).trim().replace(/\\n/g, '\n');
    if (k && !/\s/.test(k)) snippets[k] = v;
  }
  settings.snippets = snippets;
  chrome.storage.sync.set({ snippets }, () => saved('okSn'));
});
$('fixnow').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'fixAll' });
    $('fixmsg').textContent = !r || r.fixed < 0 ? 'Click into a text field first, then try again.' : r.fixed === 0 ? 'Nothing to fix.' : `Fixed ${r.fixed} issue${r.fixed === 1 ? '' : 's'}.`;
  } catch (e) { $('fixmsg').textContent = 'Reload the page once, then try again.'; }
});

function renderStats(stats) {
  const day = new Date().toISOString().slice(0, 10);
  $('sToday').textContent = ((stats.days || {})[day] || 0).toLocaleString();
  $('sTotal').textContent = (stats.total || 0).toLocaleString();
  const top = Object.entries(stats.top || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const ul = $('top');
  ul.textContent = '';
  if (!top.length) { const li = document.createElement('li'); li.textContent = 'Nothing yet — start typing!'; ul.appendChild(li); return; }
  for (const [k, v] of top) {
    const li = document.createElement('li');
    const a = document.createElement('span'), b = document.createElement('span');
    a.textContent = k; b.textContent = '×' + v;
    li.append(a, b); ul.appendChild(li);
  }
}
chrome.storage.local.get({ stats: { total: 0, days: {}, top: {} } }, ({ stats }) => renderStats(stats));
$('reset').addEventListener('click', () => { const s = { total: 0, days: {}, top: {} }; chrome.storage.local.set({ stats: s }, () => renderStats(s)); });


/* ---------- AI rewrite: bring any API key ---------- */
const NOTES = {
  anthropic: 'Get a key at console.anthropic.com.',
  openai: 'Get a key at platform.openai.com/api-keys.',
  gemini: 'Get a key at aistudio.google.com/apikey.',
  openrouter: 'One key, hundreds of models — openrouter.ai/keys. Model names look like openai/gpt-4o-mini.',
  groq: 'Get a key at console.groq.com.',
  mistral: 'Get a key at console.mistral.ai.',
  ollama: 'No key needed. Start Ollama with OLLAMA_ORIGINS="chrome-extension://*" so it accepts requests from this extension.',
  custom: 'Any server that speaks the OpenAI chat-completions format (LM Studio, vLLM, LiteLLM, Together, DeepSeek, Azure…). https only, except localhost.'
};
let cfg = { provider: 'anthropic', keys: {}, models: {}, urls: {} };
const keyMsg = (t, cls) => { $('keyState').textContent = t; $('keyState').className = 'msg' + (cls ? ' ' + cls : ''); };
const prov = () => AFX_PROVIDERS[$('provider').value];

for (const [id, p] of Object.entries(AFX_PROVIDERS)) { const o = document.createElement('option'); o.value = id; o.textContent = p.label; $('provider').appendChild(o); }

function showProvider() {
  const id = $('provider').value, p = AFX_PROVIDERS[id];
  $('url').style.display = p.editableUrl ? '' : 'none';
  $('url').value = (cfg.urls || {})[id] || (id === 'ollama' ? p.url : '');
  $('apiKey').style.display = p.keyless ? 'none' : '';
  $('apiKey').placeholder = p.keyHint ? 'Paste your key (' + p.keyHint + ')' : 'Paste your API key';
  $('apiKey').value = '';
  $('model').value = (cfg.models || {})[id] || '';
  $('model').placeholder = p.model ? 'Model (default: ' + p.model + ')' : 'Model name, e.g. my-model';
  $('provNote').textContent = NOTES[id] || '';
  refreshKeyState();
}

async function refreshKeyState() {
  cfg = await afxLoadConfig();
  const id = $('provider').value, p = AFX_PROVIDERS[id];
  const key = (cfg.keys || {})[id] || '';
  let granted = true;
  try {
    const url = afxEndpoint(id, (cfg.urls || {})[id] || (id === 'ollama' ? p.url : ''), (cfg.models || {})[id] || p.model || 'x');
    if (!afxIsLoopback(url)) granted = await chrome.permissions.contains({ origins: [afxOriginPattern(url)] });
  } catch (e) { granted = false; }
  const haveKey = !!key || p.keyless || p.keyOptional;
  const ready = haveKey && granted && cfg.provider === id;
  chrome.storage.sync.set({ rewriteReady: ready });
  if (!haveKey) keyMsg('No key saved for this provider.');
  else if (!granted) keyMsg('Saved, but access to the server isn’t allowed yet — click Save again and choose Allow.', 'bad');
  else if (cfg.provider !== id) keyMsg((key ? 'Key saved (…' + key.slice(-4) + '). ' : '') + 'Click Save to use ' + p.label + '.');
  else keyMsg((key ? 'Key saved (…' + key.slice(-4) + '). ' : '') + 'Active — ' + p.label + ' will be used for rewrites.', 'good');
}

chrome.storage.sync.get({ rewriteTone: 'clearer' }, s => { $('tone').value = s.rewriteTone; });
$('tone').addEventListener('change', () => chrome.storage.sync.set({ rewriteTone: $('tone').value }));
$('provider').addEventListener('change', showProvider);

$('saveKey').addEventListener('click', async () => {
  const id = $('provider').value, p = AFX_PROVIDERS[id];
  const key = $('apiKey').value.trim() || (cfg.keys || {})[id] || '';
  const model = $('model').value.trim();
  const urlIn = $('url').value.trim();
  if (!key && !p.keyless && !p.keyOptional) { keyMsg('Paste your API key first.', 'bad'); return; }
  if (key && /\s/.test(key)) { keyMsg('A key can’t contain spaces — check what you pasted.', 'bad'); return; }
  if (key && key.length < 8) { keyMsg('That key looks too short.', 'bad'); return; }
  let endpoint;
  try { endpoint = afxEndpoint(id, urlIn || (id === 'ollama' ? p.url : ''), model || p.model || 'x'); } catch (e) { keyMsg(e.message, 'bad'); return; }
  if (!model && !p.model) { keyMsg('Enter a model name for your server.', 'bad'); return; }
  const keys = { ...(cfg.keys || {}) }, models = { ...(cfg.models || {}) }, urls = { ...(cfg.urls || {}) };
  if (key) keys[id] = key;
  if (model) models[id] = model; else delete models[id];
  if (p.editableUrl) urls[id] = urlIn;
  await chrome.storage.local.set({ provider: id, keys, models, urls });
  $('apiKey').value = '';
  let granted = true;
  if (!afxIsLoopback(endpoint)) {
    try { granted = await chrome.permissions.request({ origins: [afxOriginPattern(endpoint)] }); } catch (e) { granted = false; }
  } else { try { await chrome.permissions.request({ origins: [afxOriginPattern(endpoint)] }); } catch (e) { /* optional for localhost */ } }
  if (granted) chrome.storage.sync.set({ rewriteEnabled: true }, () => { $('rewriteEnabled').checked = true; });
  await refreshKeyState();
});

$('testKey').addEventListener('click', async () => {
  keyMsg('Testing…');
  const r = await chrome.runtime.sendMessage({ type: 'testKey' });
  if (r && r.ok) keyMsg('Works ✓ (' + r.via + ')', 'good'); else keyMsg((r && r.error) || 'No response.', 'bad');
});

$('removeKey').addEventListener('click', async () => {
  const id = $('provider').value, p = AFX_PROVIDERS[id];
  const keys = { ...(cfg.keys || {}) }; delete keys[id];
  await chrome.storage.local.set({ keys });
  try {
    const url = afxEndpoint(id, (cfg.urls || {})[id] || (id === 'ollama' ? p.url : ''), (cfg.models || {})[id] || p.model || 'x');
    if (!afxIsLoopback(url)) await chrome.permissions.remove({ origins: [afxOriginPattern(url)] });
  } catch (e) { /* ignore */ }
  chrome.storage.sync.set({ rewriteReady: false, rewriteEnabled: false }, () => { $('rewriteEnabled').checked = false; });
  await refreshKeyState();
  keyMsg('Key removed.');
});

afxLoadConfig().then(c => { cfg = c; $('provider').value = AFX_PROVIDERS[c.provider] ? c.provider : 'anthropic'; showProvider(); });
