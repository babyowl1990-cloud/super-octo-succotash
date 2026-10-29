/* AutoFix Spelling v0.2 — content script. Fixes as you type, underlines what's left, click to fix. */
(() => {
  'use strict';
  if (window.__autofixSpelling) return;
  window.__autofixSpelling = true;

  let settings = { ...AFX_DEFAULTS };
  let customSet = new Set();
  const ignore = new Set();            // session-level ignores (spell words, 'g:rule:word', 'y:phrase', 'cap')
  const noCapEls = new WeakSet();      // fields where the user undid a capitalization
  let engine = null;
  let dictState = 'idle';              // idle | loading | ready | failed
  let busy = false;                    // true while WE edit, so we ignore our own events
  let lastFix = null;                  // {el, recs[], caret} for Backspace-to-undo
  let pending = null;                  // suggestion bar state
  let lastEl = null;                   // last editable the user touched (for "Fix now" from the popup)
  let lastTyped = 0, lastTypedEl = null;
  const decor = new Map();             // el -> {el, issues, field, ov}  (every field we're underlining)
  const scanTimers = new Map();
  let rw = null, rwSeq = 0;            // "rewrite with Claude" state

  const MAX_TEXT = 30000;
  const WS_RE = /[ \u00A0]/;

  /* ================= settings & stats ================= */
  function applySettings(s) {
    settings = { ...AFX_DEFAULTS, ...s };
    customSet = new Set((settings.custom || []).map(w => String(w).trim().toLowerCase()).filter(Boolean));
    if (active()) { discoverSoon(100); for (const el of decor.keys()) scanSoon(el, 50); } else clearDecor();
  }
  try {
    chrome.storage.sync.get(AFX_DEFAULTS, applySettings);
    chrome.storage.onChanged.addListener((_c, area) => { if (area === 'sync') chrome.storage.sync.get(AFX_DEFAULTS, applySettings); });
  } catch (e) { /* extension reloaded; page needs a refresh */ }

  function active() {
    if (!settings.enabled) return false;
    const h = location.hostname;
    return !(settings.disabledSites || []).some(d => h === d || h.endsWith('.' + d));
  }

  let statBuf = { total: 0, top: {} }, statTimer = null;
  function recordStats(items) {
    for (const it of items) {
      if (it.kind === 'snippet') continue;
      statBuf.total++;
      const k = (it.word.trim() + ' → ' + (it.replacement || '∅').trim()).slice(0, 60);
      statBuf.top[k] = (statBuf.top[k] || 0) + 1;
    }
    clearTimeout(statTimer);
    statTimer = setTimeout(flushStats, 4000);
  }
  function flushStats() {
    const buf = statBuf; statBuf = { total: 0, top: {} };
    if (!buf.total) return;
    try {
      chrome.storage.local.get({ stats: { total: 0, days: {}, top: {} } }, ({ stats }) => {
        const day = new Date().toISOString().slice(0, 10);
        stats.total += buf.total;
        stats.days[day] = (stats.days[day] || 0) + buf.total;
        for (const [k, v] of Object.entries(buf.top)) stats.top[k] = (stats.top[k] || 0) + v;
        const days = Object.keys(stats.days).sort();
        while (days.length > 30) delete stats.days[days.shift()];
        const top = Object.entries(stats.top).sort((a, b) => b[1] - a[1]);
        if (top.length > 60) stats.top = Object.fromEntries(top.slice(0, 40));
        chrome.storage.local.set({ stats });
      });
    } catch (e) { /* ignore */ }
  }
  addEventListener('pagehide', flushStats);

  /* ================= dictionary (lazy) ================= */
  async function loadDict() {
    if (dictState !== 'idle') return;
    dictState = 'loading';
    try {
      const [w, f] = await Promise.all([
        fetch(chrome.runtime.getURL('dict/words.txt')).then(r => r.text()),
        fetch(chrome.runtime.getURL('dict/freq.txt')).then(r => r.text())
      ]);
      const words = new Set(w.split('\n'));
      const freq = new Map();
      for (const line of f.split('\n')) { const i = line.indexOf('\t'); if (i > 0) freq.set(line.slice(0, i), +line.slice(i + 1)); }
      engine = AutofixEngine.create(AutofixSpeller.create(words, freq));
      dictState = 'ready';
      discoverSoon(50);
      if (lastEl) scanSoon(lastEl, 50);
    } catch (err) {
      dictState = 'failed';
      console.warn('[AutoFix Spelling] could not load dictionary', err);
    }
  }

  /* ================= which fields do we touch? ================= */
  const SKIP_AUTOCOMPLETE = /username|email|password|cc-|address|postal|tel|name|one-time/;
  const CODE_EDITORS = 'pre, code, .monaco-editor, .CodeMirror, .cm-editor, .ace_editor, .xterm, .jp-Cell';
  const isTextControl = el => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;

  function editableFromNode(t) {
    if (!(t instanceof Element)) return null;
    let el = null;
    if (t instanceof HTMLTextAreaElement) el = t;
    else if (t instanceof HTMLInputElement) { if (!['text', 'search'].includes(t.type)) return null; el = t; }
    else if (t.isContentEditable) {
      el = t;
      while (el.parentElement && el.parentElement.isContentEditable) el = el.parentElement; // editing host
    }
    if (!el || el.readOnly || el.disabled) return null;
    if (el.getAttribute('spellcheck') === 'false') return null;
    if (SKIP_AUTOCOMPLETE.test(el.getAttribute('autocomplete') || '')) return null;
    if (el.closest(CODE_EDITORS)) return null;
    return el;
  }
  const resolveEditable = e => editableFromNode(e.composedPath ? e.composedPath()[0] : e.target);

  /* ================= Field: text + caret + offset mapping ================= */
  function buildCE(el) {
    const entries = [];
    let text = '';
    const disp = new Map();
    const blockOf = n => {
      for (let p = n.parentElement; p && p !== el; p = p.parentElement) {
        let d = disp.get(p);
        if (d === undefined) { d = getComputedStyle(p).display; disp.set(p, d); }
        if (!/^inline/.test(d) && d !== 'contents' && d !== 'ruby') return p;
      }
      return el;
    };
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
        if (n.nodeName === 'BR') return NodeFilter.FILTER_ACCEPT;
        if (n.nodeName === 'SCRIPT' || n.nodeName === 'STYLE') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
    });
    let lastBlock = null, n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 1) { text += '\n'; lastBlock = null; continue; }
      const b = blockOf(n);
      if (lastBlock && b !== lastBlock && text && !text.endsWith('\n')) text += '\n';
      lastBlock = b;
      entries.push({ node: n, off: text.length, len: n.data.length });
      text += n.data;
      if (text.length > MAX_TEXT * 2) break;
    }
    return {
      text, entries,
      offsetOf(node, offset) {
        if (node.nodeType !== 3) return -1;
        const en = entries.find(x => x.node === node);
        return en ? en.off + offset : -1;
      },
      nodeRange(s, e) {
        const en = entries.find(x => s >= x.off && e <= x.off + x.len);
        return en ? { node: en.node, start: s - en.off, end: e - en.off } : null;
      },
      rangeFor(s, e) {                       // may span several text nodes
        const a = entries.find(x => s < x.off + x.len);
        let b = null;
        for (const x of entries) if (e > x.off && e <= x.off + x.len) b = x;
        if (!a || !b) return null;
        const rg = document.createRange();
        rg.setStart(a.node, Math.max(0, s - a.off));
        rg.setEnd(b.node, e - b.off);
        return rg;
      }
    };
  }

  function getField(el) {
    if (!el || !el.isConnected) return null;
    if (isTextControl(el)) {
      const caret = el.selectionStart == null || el.selectionStart !== el.selectionEnd ? -1 : el.selectionStart;
      return { el, ce: false, text: el.value, caret };
    }
    const m = buildCE(el);
    const sel = getSelection();
    let caret = -1;
    if (sel && sel.rangeCount && sel.isCollapsed && sel.anchorNode && el.contains(sel.anchorNode)) caret = m.offsetOf(sel.anchorNode, sel.anchorOffset);
    return { el, ce: true, text: m.text, caret, m };
  }

  /* Replace text[s,e) with newText through execCommand, so Ctrl+Z and frameworks (React, Slate…) keep working. */
  function replaceText(f, s, e, newText) {
    const oldCaret = f.caret;
    busy = true;
    try {
      const del = newText === '';
      if (!f.ce) {
        const el = f.el;
        el.setSelectionRange(s, e);
        const ok = del ? document.execCommand('delete') : document.execCommand('insertText', false, newText);
        if (!ok) {
          el.setRangeText(newText, s, e, 'end');
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: newText }));
        }
        const c = oldCaret < 0 || oldCaret < e ? s + newText.length : oldCaret + newText.length - (e - s);
        el.setSelectionRange(c, c);
        return true;
      }
      const r = f.m.nodeRange(s, e);
      if (!r) return false;
      const sel = getSelection();
      const rg = document.createRange();
      rg.setStart(r.node, r.start);
      rg.setEnd(r.node, r.end);
      sel.removeAllRanges();
      sel.addRange(rg);
      const ok = del ? document.execCommand('delete') : document.execCommand('insertText', false, newText);
      if (!ok) return false;
      if (oldCaret >= e) {
        const fwd = oldCaret - e;
        if (fwd > 0 && fwd <= 12 && !/\n/.test(f.text.slice(e, oldCaret))) for (let i = 0; i < fwd; i++) sel.modify('move', 'forward', 'character');
      }
      return true;
    } catch (err) {
      return false;
    } finally {
      busy = false;
    }
  }

  /* Apply a batch of issues (later text first so earlier offsets stay valid). */
  function applyItems(el, f, items, isEnter) {
    const origCaret = f.caret;
    const sorted = items.slice().sort((a, b) => b.s - a.s);
    const done = [];
    let cur = f;
    for (const it of sorted) {
      if (!cur) cur = getField(el);
      if (!cur || cur.text.slice(it.s, it.e) !== it.word) break;
      if (!replaceText(cur, it.s, it.e, it.replacement)) break;
      done.push(it);
      cur = null;
    }
    if (!done.length) return false;
    let total = 0;
    for (const it of done) total += it.replacement.length - (it.e - it.s);
    const recs = done.map(it => {
      let shift = 0;
      for (const o of done) if (o.s < it.s) shift += o.replacement.length - (o.e - o.s);
      return { orig: it.word, fixed: it.replacement, start: it.s + shift, kind: it.kind, key: it.key };
    });
    lastFix = isEnter || origCaret < 0 ? null : { el, recs, caret: origCaret + total };
    recordStats(done);
    flashFix(el, done, !isEnter);
    scanSoon(el, 300);
    return true;
  }

  function revertLast(el) {
    const lf = lastFix;
    lastFix = null;
    if (!lf || lf.el !== el) return false;
    let f = getField(el);
    if (!f || f.caret !== lf.caret) return false;
    const recs = lf.recs.slice().sort((a, b) => b.start - a.start);
    for (const r of recs) {
      if (!f) f = getField(el);
      if (!f || f.text.slice(r.start, r.start + r.fixed.length) !== r.fixed) return false;
      if (!replaceText(f, r.start, r.start + r.fixed.length, r.orig)) return false;
      f = null;
      if (r.kind === 'cap') noCapEls.add(el); else if (r.kind !== 'snippet') ignore.add(r.key);
    }
    flashText(el, 'Reverted — won’t fix that again');
    scanSoon(el, 300);
    return true;
  }

  /* ================= on-type pipeline ================= */
  function expandSnippet(s) {
    const d = new Date();
    return s.replace(/\{date\}/g, d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }))
      .replace(/\{time\}/g, d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
      .replace(/\{iso\}/g, d.toISOString().slice(0, 10))
      .replace(/\\n/g, '\n');
  }

  function onType(el, isEnter) {
    const f = getField(el);
    if (!f || f.caret < 0) return;
    const t = f.text, pos = f.caret;
    let endIdx;
    if (isEnter) endIdx = pos;
    else {
      if (!/\s/.test(t[pos - 1] || '')) return;            // only fire right after a space
      if (/[\p{L}']/u.test(t[pos] || '')) return;            // you split a word in the middle
      endIdx = pos - 1;
    }

    if (!isEnter && settings.doubleSpace && pos >= 3 && WS_RE.test(t[pos - 2]) && /\S/.test(t[pos - 3])) {
      replaceText(f, pos - 1, pos, '');
      return;
    }

    // snippets & smart punctuation work on the last whitespace-delimited chunk
    const m = /(\S+)$/.exec(t.slice(0, endIdx));
    if (m) {
      const tok = m[1], s0 = endIdx - tok.length;
      const sn = settings.snippets && Object.prototype.hasOwnProperty.call(settings.snippets, tok) ? settings.snippets[tok] : null;
      if (sn != null) {
        applyItems(el, f, [{ s: s0, e: endIdx, word: tok, replacement: expandSnippet(sn), kind: 'snippet', key: 'snip:' + tok }], isEnter);
        return;
      }
      if (settings.smartPunct) {
        if (tok === '--' || tok === '---') { applyItems(el, f, [{ s: s0, e: endIdx, word: tok, replacement: '—', kind: 'snippet', key: 'punct' }], isEnter); return; }
        if (/[^.]\.\.\.$|^\.\.\.$/.test(tok)) { applyItems(el, f, [{ s: endIdx - 3, e: endIdx, word: '...', replacement: '…', kind: 'snippet', key: 'punct' }], isEnter); return; }
      }
    }

    if (!engine) return;
    let ws0 = Math.max(0, endIdx - 500);
    if (ws0 > 0) { const sp = t.indexOf(' ', ws0); if (sp >= 0 && sp < endIdx) ws0 = sp + 1; }
    const win = t.slice(ws0, endIdx);
    let lastEnd = win.length;
    if (/[.,!?;:)\]"”]/.test(win[lastEnd - 1] || '') && /[A-Za-z]/.test(win[lastEnd - 2] || '')) lastEnd--;
    const iss = engine.findIssues(win, { settings, ignore, custom: customSet, startIsSentence: ws0 === 0, noCap: noCapEls.has(el), noStyle: true })
      .filter(i => i.trigEnd === lastEnd)
      .map(i => ({ ...i, s: i.s + ws0, e: i.e + ws0, trigEnd: i.trigEnd + ws0 }));

    const autos = iss.filter(i => i.auto && i.replacement !== null);
    if (autos.length) { applyItems(el, f, autos, isEnter); return; }
    if (isEnter || !settings.suggest) return;
    const sug = iss.find(i => i.kind !== 'style' && i.suggestions.length && (i.replacement === null || !i.auto));
    if (sug) openBar(el, sug, 'type');
  }

  /* ================= fix everything in the field ================= */
  function fixAll(el) {
    if (!el || !engine || !active()) return -1;
    let f = getField(el);
    if (!f) return -1;
    const iss = engine.findIssues(f.text.slice(0, MAX_TEXT * 2), { settings: { ...settings, style: false }, ignore, custom: customSet, startIsSentence: true, noCap: noCapEls.has(el), noStyle: true })
      .filter(i => i.replacement !== null && i.kind !== 'style' && (i.auto || i.kind === 'spell' || i.kind === 'cap'));
    if (!iss.length) return 0;
    busy = true;
    let count = 0;
    try {
      if (!f.ce) {
        let out = f.text, caret = f.caret;
        for (const i of iss.slice().sort((a, b) => b.s - a.s)) {
          out = out.slice(0, i.s) + i.replacement + out.slice(i.e);
          if (caret >= i.e) caret += i.replacement.length - (i.e - i.s);
          count++;
        }
        el.select();
        el.setSelectionRange(0, el.value.length);
        if (!document.execCommand('insertText', false, out)) { el.value = out; el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: out })); }
        const c = caret < 0 ? out.length : Math.min(caret, out.length);
        el.setSelectionRange(c, c);
      } else {
        const sel = getSelection();
        const saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
        for (const i of iss.slice().sort((a, b) => b.s - a.s)) {
          const r = f.m.nodeRange(i.s, i.e);
          if (!r || r.node.data.slice(r.start, r.end) !== i.word) continue;
          const rg = document.createRange();
          rg.setStart(r.node, r.start); rg.setEnd(r.node, r.end);
          sel.removeAllRanges(); sel.addRange(rg);
          const ok = i.replacement === '' ? document.execCommand('delete') : document.execCommand('insertText', false, i.replacement);
          if (ok) count++;
        }
        if (saved) { sel.removeAllRanges(); sel.addRange(saved); }
      }
    } finally { busy = false; }
    if (count) { recordStats(iss.slice(0, count)); flashText(el, `Fixed ${count} issue${count === 1 ? '' : 's'}`); scanSoon(el, 200); }
    return count;
  }

  /* ================= underline layer: every visible text field gets scanned → squiggles ================= */
  const KIND_COLOR = { spell: '#ef4444', cap: '#f59e0b', grammar: '#3b82f6', style: '#a78bfa' };
  const FIELD_SEL = 'textarea, input[type=text], input[type=search], input:not([type]), [contenteditable]:not([contenteditable=false])';
  const MAX_FIELDS = 8;

  function scanSoon(el, delay = 350) {
    clearTimeout(scanTimers.get(el));
    scanTimers.set(el, setTimeout(() => doScan(el), delay));
  }

  function visibleEnough(el) {
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 14 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }
  const fieldHasText = el => (isTextControl(el) ? el.value : el.textContent || '').trim().length >= 3;

  let discoverTimer = null;
  function discoverSoon(delay = 700) { clearTimeout(discoverTimer); discoverTimer = setTimeout(discover, delay); }
  function discover() {
    if (!active() || !settings.underline) { clearDecor(); return; }
    const found = new Set();
    for (const n of document.querySelectorAll(FIELD_SEL)) {
      if (found.size >= MAX_FIELDS) break;
      const el = editableFromNode(n);
      if (!el || el !== n || !visibleEnough(el)) continue;
      if (!fieldHasText(el) && el !== document.activeElement) continue;
      found.add(el);
    }
    if (found.size && dictState === 'idle') loadDict();
    for (const el of [...decor.keys()]) if (!found.has(el) && el !== document.activeElement) clearDecor(el);
    if (settings.underlineAll === false) { for (const el of [...decor.keys()]) if (el !== document.activeElement) clearDecor(el); return; }
    for (const el of found) if (!decor.has(el)) scanSoon(el, 50);
  }
  new MutationObserver(() => { if (active() && settings.underline) discoverSoon(1200); }).observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => discoverSoon(100), 1200);

  function clearDecor(el) {
    for (const k of el ? [el] : [...decor.keys()]) {
      const d = decor.get(k);
      if (d && d.ov) d.ov.host.remove();
      decor.delete(k);
    }
    renderHighlights();
  }

  function doScan(el) {
    scanTimers.delete(el);
    if (!el || !el.isConnected) { clearDecor(el); return; }
    if (!engine || dictState !== 'ready') return;
    if (!settings.underline || !active()) { clearDecor(el); return; }
    const focused = el === document.activeElement || (document.activeElement && el.contains(document.activeElement));
    if (!focused && (!visibleEnough(el) || (settings.underlineAll === false))) { clearDecor(el); return; }
    const f = getField(el);
    if (!f) { clearDecor(el); return; }
    const text = f.text.slice(0, MAX_TEXT);
    const issues = text.trim().length < 3 ? [] : engine.findIssues(text, {
      settings, ignore, custom: customSet, startIsSentence: true, noCap: noCapEls.has(el),
      typing: { caret: focused ? f.caret : -1, recent: el === lastTypedEl && Date.now() - lastTyped < 1500 }
    });
    const d = decor.get(el) || { el, issues: [], ov: null };
    d.issues = issues;
    d.field = f;
    decor.set(el, d);
    if (f.ce) renderHighlights(); else renderMirror(d, text);
  }

  /* --- contenteditable: CSS Custom Highlight API (one Highlight per colour, shared by all fields) --- */
  let sheetAdded = false;
  function ensureHighlightCSS() {
    if (sheetAdded || !(window.CSS && CSS.highlights) || typeof CSSStyleSheet === 'undefined') return;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`::highlight(afx-spell){text-decoration:underline wavy ${KIND_COLOR.spell};text-decoration-thickness:1.5px;text-decoration-skip-ink:none;}
::highlight(afx-grammar){text-decoration:underline wavy ${KIND_COLOR.grammar};text-decoration-thickness:1.5px;text-decoration-skip-ink:none;}
::highlight(afx-style){text-decoration:underline dotted ${KIND_COLOR.style};text-decoration-thickness:2px;text-decoration-skip-ink:none;}`);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      sheetAdded = true;
    } catch (e) { /* page forbids adoptedStyleSheets */ }
  }
  function renderHighlights() {
    if (!(window.CSS && CSS.highlights)) return;
    ensureHighlightCSS();
    const groups = { 'afx-spell': [], 'afx-grammar': [], 'afx-style': [] };
    for (const d of decor.values()) {
      if (!d.field || !d.field.ce) continue;
      for (const i of d.issues) {
        const r = d.field.m.nodeRange(i.s, i.e);
        if (!r) continue;
        const rg = new Range();
        try { rg.setStart(r.node, r.start); rg.setEnd(r.node, r.end); } catch (e) { continue; }
        i.range = rg;
        groups[i.kind === 'spell' || i.kind === 'cap' ? 'afx-spell' : i.kind === 'grammar' ? 'afx-grammar' : 'afx-style'].push(rg);
      }
    }
    for (const [name, ranges] of Object.entries(groups)) {
      if (ranges.length) CSS.highlights.set(name, new Highlight(...ranges)); else CSS.highlights.delete(name);
    }
  }

  /* --- <textarea>/<input>: transparent mirror positioned over each field --- */
  const MIRROR_COPY = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch', 'letterSpacing', 'wordSpacing',
    'textTransform', 'textIndent', 'textAlign', 'tabSize', 'direction', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'lineHeight'];

  function ensureMirror(d) {
    if (d.ov) return d.ov;
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    const mirror = document.createElement('div');
    const inner = document.createElement('div');
    inner.style.flex = 'none';
    mirror.appendChild(inner);
    root.appendChild(mirror);
    document.documentElement.appendChild(host);
    d.ov = { host, mirror, inner };
    return d.ov;
  }

  function syncMirror(d) {
    const ov = d.ov, el = d.el;
    if (!ov) return;
    if (!el.isConnected) { clearDecor(el); return; }
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    const st = ov.mirror.style;
    st.cssText = '';
    for (const p of MIRROR_COPY) st[p] = cs[p];
    Object.assign(st, {
      position: 'fixed', left: (r.left + el.clientLeft) + 'px', top: (r.top + el.clientTop) + 'px',
      width: el.clientWidth + 'px', height: el.clientHeight + 'px', overflow: 'hidden', pointerEvents: 'none',
      boxSizing: 'border-box', margin: '0', border: '0', color: 'transparent', overflowWrap: cs.overflowWrap, wordBreak: cs.wordBreak,
      whiteSpace: el instanceof HTMLTextAreaElement ? 'pre-wrap' : 'pre'
    });
    const hidden = r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || r.bottom < 0 || r.top > innerHeight;
    st.display = hidden ? 'none' : (el instanceof HTMLInputElement ? 'flex' : 'block');
    if (el instanceof HTMLInputElement) { st.alignItems = 'center'; ov.inner.style.transform = `translateX(${-el.scrollLeft}px)`; }
    else ov.mirror.scrollTop = el.scrollTop;
  }

  function renderMirror(d, text) {
    const o = ensureMirror(d);
    o.inner.textContent = '';
    let pos = 0;
    for (const i of d.issues) {
      if (i.s < pos) continue;
      if (i.s > pos) o.inner.appendChild(document.createTextNode(text.slice(pos, i.s)));
      const sp = document.createElement('span');
      sp.textContent = text.slice(i.s, i.e);
      const col = KIND_COLOR[i.kind];
      sp.style.cssText = `text-decoration:${i.kind === 'style' ? 'underline dotted' : 'underline wavy'} ${col};text-decoration-thickness:${i.kind === 'style' ? 2 : 1.5}px;text-underline-offset:2px;text-decoration-skip-ink:none;`;
      o.inner.appendChild(sp);
      i.span = sp;
      pos = i.e;
    }
    o.inner.appendChild(document.createTextNode(text.slice(pos) + '\u200b'));
    syncMirror(d);
  }

  setInterval(() => { for (const d of decor.values()) if (d.ov) syncMirror(d); }, 250);
  addEventListener('scroll', () => { if (decor.size) requestAnimationFrame(() => { for (const d of decor.values()) if (d.ov) syncMirror(d); }); discoverSoon(500); }, true);
  addEventListener('resize', () => { for (const d of decor.values()) if (d.ov) syncMirror(d); discoverSoon(500); });

  /* ================= bar UI (closed shadow DOM so page CSS can't touch it) ================= */
  let ui = null, uiTimer = null;
  function ensureUI() {
    if (ui) return ui;
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .box{position:fixed;display:none;align-items:center;gap:6px;padding:6px 8px;border-radius:10px;flex-wrap:wrap;
        background:#14161c;color:#e8eaf0;font:13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;
        box-shadow:0 6px 24px rgba(0,0,0,.35);border:1px solid #2b2f3a;max-width:440px}
      .box.on{display:flex}
      .old{color:#ff7b7b;text-decoration:line-through}
      .new{color:#6ee7a0;font-weight:600}
      .hint{color:#8b92a5;font-size:11px;margin-left:2px}
      .lbl{font-size:11px;margin-right:2px;font-weight:600}
      .spell{color:#ff7b7b}.cap{color:#fbbf24}.grammar{color:#60a5fa}.style{color:#c4b5fd}
      button{all:unset;cursor:pointer;padding:3px 8px;border-radius:6px;background:#232733;color:#e8eaf0;font-size:12px}
      button:hover{background:#343a4d}
      button b{color:#8b92a5;font-weight:500;margin-right:4px}
      button.main{background:#1f6f4a}button.main:hover{background:#27895b}
      button.x{padding:3px 6px;color:#8b92a5}
      .box.col{flex-direction:column;align-items:stretch;gap:8px;width:420px}
      .rwhead,.rwfoot{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
      .rwlbl{color:#c4b5fd;font-size:12px;margin-right:4px}
      .rwtext{background:#0e1015;border:1px solid #2b2f3a;border-radius:8px;padding:8px 10px;white-space:pre-wrap;line-height:1.45;max-height:170px;overflow:auto;font-size:13px}
      .err{color:#ff9b9b;white-space:normal;line-height:1.4}`;
    const box = document.createElement('div');
    box.className = 'box';
    box.addEventListener('mousedown', e => e.preventDefault()); // keep focus + caret in the field
    root.append(style, box);
    ui = { host, box, hot: false };
    box.addEventListener('mouseenter', () => (ui.hot = true));
    box.addEventListener('mouseleave', () => (ui.hot = false));
    document.documentElement.appendChild(host);
    return ui;
  }

  function anchorRect(el, issue) {
    if (issue) {
      if (issue.span) return issue.span.getBoundingClientRect();
      if (issue.range) { const r = issue.range.getBoundingClientRect(); if (r.width || r.height) return r; }
    }
    if (!isTextControl(el)) {
      const sel = getSelection();
      if (sel && sel.rangeCount) { const r = sel.getRangeAt(0).getBoundingClientRect(); if (r.width || r.height) return r; }
    }
    return el.getBoundingClientRect();
  }

  function place(rect) {
    const u = ensureUI();
    u.box.style.left = '0px'; u.box.style.top = '0px';
    u.box.classList.add('on');
    const bw = u.box.offsetWidth, bh = u.box.offsetHeight;
    let top = rect.bottom + 8;
    if (top + bh > innerHeight - 8) top = Math.max(8, rect.top - bh - 8);
    u.box.style.left = Math.max(8, Math.min(rect.left, innerWidth - bw - 8)) + 'px';
    u.box.style.top = Math.min(top, innerHeight - bh - 8) + 'px';
  }

  const span = (cls, txt) => { const s = document.createElement('span'); s.className = cls; s.textContent = txt; return s; };
  function btn(label, key, fn, cls) {
    const b = document.createElement('button');
    if (cls) b.className = cls;
    if (key) { const k = document.createElement('b'); k.textContent = key; b.appendChild(k); }
    b.appendChild(document.createTextNode(label));
    b.addEventListener('click', fn);
    return b;
  }

  function flashFix(el, done, canUndo) {
    const u = ensureUI();
    u.box.classList.remove('col');
    if (done.length === 1) {
      const it = done[0];
      if (it.kind === 'snippet') u.box.replaceChildren(span('old', it.word), span('', '→'), span('new', it.replacement.length > 24 ? it.replacement.slice(0, 24) + '…' : it.replacement));
      else if (it.replacement === '') u.box.replaceChildren(span('old', it.word.trim()), span('hint', 'removed'));
      else u.box.replaceChildren(span('old', it.word), span('', '→'), span('new', it.replacement));
      if (it.kind === 'grammar') u.box.appendChild(span('hint', it.label));
    } else {
      u.box.replaceChildren(span('new', `${done.length} fixes`), span('hint', done.map(d => d.replacement.trim() || '∅').slice(0, 3).join(', ')));
    }
    if (canUndo) u.box.appendChild(span('hint', '· ⌫ undo'));
    place(anchorRect(el));
    clearTimeout(uiTimer);
    uiTimer = setTimeout(hideBar, 2400);
  }
  function flashText(el, msg) {
    const u = ensureUI();
    u.box.classList.remove('col');
    u.box.replaceChildren(span('new', msg));
    place(anchorRect(el));
    clearTimeout(uiTimer);
    uiTimer = setTimeout(hideBar, 2000);
  }

  function openBar(el, issue, source) {
    pending = { el, issue, source };
    rw = null;
    const u = ensureUI();
    u.box.classList.remove('col');
    u.box.replaceChildren(span('lbl ' + issue.kind, issue.kind === 'spell' ? `“${issue.word}”` : issue.label));
    const sugg = issue.suggestions.slice(0, 3);
    sugg.forEach((s, i) => u.box.appendChild(btn(s === '' ? `Remove “${issue.word.trim()}”` : s, source === 'type' ? 'Alt+' + (i + 1) : '', () => applySuggestion(s), i === 0 && issue.replacement !== null ? 'main' : '')));
    if (issue.kind === 'spell') u.box.appendChild(btn('+ Add', '', addToDictionary));
    if (rewriteReady()) u.box.appendChild(btn('✨ Rewrite', '', () => { const p = pending; hideBar(); startRewrite(p.el, settings.rewriteTone || 'clearer', null, p.issue.s); }));
    u.box.appendChild(btn('Ignore', '', ignoreIssue));
    u.box.appendChild(btn('✕', '', hideBar, 'x'));
    place(anchorRect(el, issue));
    clearTimeout(uiTimer);
    uiTimer = setTimeout(hideBar, source === 'type' ? 7000 : 15000);
  }

  function hideBar() {
    pending = null;
    rw = null;
    clearTimeout(uiTimer);
    if (ui) { ui.box.classList.remove('on'); ui.hot = false; }
  }

  function applySuggestion(choice) {
    if (!pending) return;
    const { el, issue } = pending;
    hideBar();
    const f = getField(el);
    if (!f || f.text.slice(issue.s, issue.e) !== issue.word) return;
    if (replaceText(f, issue.s, issue.e, choice)) {
      recordStats([{ ...issue, replacement: choice }]);
      scanSoon(el, 200);
    }
  }
  function addToDictionary() {
    if (!pending) return;
    const w = pending.issue.word.toLowerCase(), el = pending.el;
    hideBar();
    customSet.add(w);
    try { chrome.storage.sync.get(AFX_DEFAULTS, s => chrome.storage.sync.set({ custom: Array.from(new Set([...(s.custom || []), w])) })); } catch (e) { /* ignore */ }
    scanSoon(el, 50);
  }
  function ignoreIssue() {
    if (!pending) return;
    const { el, issue } = pending;
    hideBar();
    if (issue.kind === 'cap') noCapEls.add(el); else ignore.add(issue.key);
    scanSoon(el, 50);
  }

  /* click or arrow into an underlined word → open the bar */
  function showIssueAtCaret(el) {
    const d = decor.get(el);
    if (!settings.underline || !d || !d.issues.length) return;
    const f = getField(el);
    if (!f || f.caret < 0) return;
    const i = d.issues.find(x => x.s <= f.caret && f.caret <= x.e);
    if (i) openBar(el, i, 'click'); else if (pending && pending.source === 'click') hideBar();
  }

  /* ================= AI rewrite (optional, bring any API key) ================= */
  const TONE_KEYS = ['clearer', 'shorter', 'friendlier', 'formal', 'fix'];
  const TONE_LABELS = { clearer: 'Clearer', shorter: 'Shorter', friendlier: 'Friendlier', formal: 'More formal', fix: 'Fix only' };
  const rewriteReady = () => active() && !!settings.rewriteEnabled && !!settings.rewriteReady;

  function sentenceBounds(text, caret) {
    let c = Math.min(caret, text.length);
    while (c > 0 && /\s/.test(text[c - 1])) c--;                 // caret after "sentence. " → that sentence
    if (c > 0 && /[.!?]/.test(text[c - 1])) c--;
    let s = c; while (s > 0 && !/[.!?\n]/.test(text[s - 1])) s--;
    let e = c; while (e < text.length && !/[.!?\n]/.test(text[e])) e++;
    if (e < text.length && text[e] !== '\n') e++;               // include the closing punctuation
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    return [s, e];
  }

  /* what gets rewritten: the selection, or the sentence around the caret (or around atIndex) */
  function getRewriteTarget(el, atIndex) {
    if (isTextControl(el)) {
      const a = el.selectionStart, b = el.selectionEnd;
      if (a == null) return null;
      if (atIndex == null && a !== b) return { kind: 'ta', s: a, e: b, original: el.value.slice(a, b) };
      const [s, e] = sentenceBounds(el.value, atIndex == null ? a : atIndex);
      return e > s ? { kind: 'ta', s, e, original: el.value.slice(s, e) } : null;
    }
    const sel = getSelection();
    if (atIndex == null && sel && sel.rangeCount && !sel.isCollapsed && el.contains(sel.anchorNode)) {
      const r = sel.getRangeAt(0).cloneRange();
      return { kind: 'ce', range: r, original: r.toString() };
    }
    const f = getField(el);
    if (!f) return null;
    const at = atIndex == null ? f.caret : atIndex;
    if (at < 0) return null;
    const [s, e] = sentenceBounds(f.text, at);
    if (e <= s) return null;
    const rg = f.m.rangeFor(s, e);
    return rg ? { kind: 'ce', range: rg, original: rg.toString() } : null;
  }

  function startRewrite(el, tone, prev, atIndex) {
    if (!rewriteReady()) { flashText(el, 'Turn on “AI rewrite” in the popup and add an API key'); return; }
    const target = prev ? prev.target : getRewriteTarget(el, atIndex);
    if (!target || target.original.trim().length < 3) { flashText(el, 'Put the caret in a sentence, or select some text first'); return; }
    if (target.original.length > 2000) { flashText(el, 'Too long — select up to 2,000 characters'); return; }
    const id = ++rwSeq;
    pending = null;
    rw = { el, target, original: target.original, tone, id, state: 'loading' };
    renderRewrite();
    const fail = msg => { if (rw && rw.id === id) { rw.state = 'error'; rw.error = msg; renderRewrite(); } };
    try {
      chrome.runtime.sendMessage({ type: 'rewrite', text: rw.original, tone }, resp => {
        if (!rw || rw.id !== id) return;
        if (chrome.runtime.lastError) return fail('The extension was reloaded — refresh this page.');
        if (!resp || resp.error) return fail((resp && resp.error) || 'No response from the extension.');
        rw.state = 'done'; rw.result = resp.text; rw.via = resp.via || ''; renderRewrite();
      });
    } catch (e) { fail('The extension was reloaded — refresh this page.'); }
  }

  function renderRewrite() {
    const u = ensureUI();
    u.box.classList.add('col');
    const head = document.createElement('div');
    head.className = 'rwhead';
    head.appendChild(span('lbl rwlbl', '✨ Rewrite'));
    TONE_KEYS.forEach((k, i) => {
      const b = btn(TONE_LABELS[k], '', () => startRewrite(rw.el, k, rw), k === rw.tone ? 'main' : '');
      b.title = 'Alt+' + (i + 1);
      head.appendChild(b);
    });
    const body = document.createElement('div');
    if (rw.state === 'loading') body.appendChild(span('hint', 'Rewriting…'));
    else if (rw.state === 'error') body.appendChild(span('err', rw.error));
    else { body.className = 'rwtext'; body.textContent = rw.result; }
    const foot = document.createElement('div');
    foot.className = 'rwfoot';
    if (rw.state === 'done') {
      foot.appendChild(btn('Replace', 'Alt+Enter', applyRewrite, 'main'));
      foot.appendChild(btn('Copy', '', () => { try { navigator.clipboard.writeText(rw.result); } catch (e) { /* ignore */ } hideBar(); }));
    }
    if (rw.state === 'done' && rw.via) foot.appendChild(span('hint', 'via ' + rw.via));
    foot.appendChild(btn('✕', '', hideBar, 'x'));
    u.box.replaceChildren(head, body, foot);
    let rect = null;
    if (rw.target.kind === 'ce') { const r = rw.target.range.getBoundingClientRect(); if (r.width || r.height) rect = r; }
    place(rect || anchorRect(rw.el));
    clearTimeout(uiTimer);
  }

  function applyRewrite() {
    if (!rw || rw.state !== 'done') return;
    const { el, target, result } = rw;
    hideBar();
    if (target.kind === 'ta') {
      const f = getField(el);
      if (!f || f.text.slice(target.s, target.e) !== target.original) { flashText(el, 'The text changed — run the rewrite again'); return; }
      replaceText(f, target.s, target.e, result);
    } else {
      const r = target.range;
      if (r.toString().replace(/\n/g, '') !== target.original.replace(/\n/g, '')) { flashText(el, 'The text changed — run the rewrite again'); return; }
      busy = true;
      try { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); document.execCommand('insertText', false, result); } finally { busy = false; }
    }
    scanSoon(el, 300);
  }

  /* ================= events ================= */
  document.addEventListener('focusin', e => {
    const el = resolveEditable(e);
    if (!el || !active()) return;
    loadDict();
    lastEl = el;
    scanSoon(el, 200);
    discoverSoon(600);
  }, true);

  document.addEventListener('input', e => {
    if (busy || e.isComposing) return;
    const el = resolveEditable(e);
    if (!el) return;
    lastEl = el;
    lastTyped = Date.now();
    lastTypedEl = el;
    if (pending || rw) hideBar();
    if (!active()) return;
    if (dictState !== 'ready') { loadDict(); return; }
    if (e.inputType === 'insertText' && typeof e.data === 'string' && /^\s$/.test(e.data)) onType(el, false);
    scanSoon(el, 400);
  }, true);

  document.addEventListener('keydown', e => {
    if (e.isComposing || busy) return;
    const el = resolveEditable(e);

    if (e.altKey && e.shiftKey && e.code === 'KeyF' && el) { e.preventDefault(); const n = fixAll(el); if (n === 0) flashText(el, 'Nothing to fix'); return; }

    if (e.altKey && e.shiftKey && e.code === 'KeyR' && el) { e.preventDefault(); startRewrite(el, settings.rewriteTone || 'clearer', null); return; }
    if (rw) {
      if (e.altKey && e.key === 'Enter') { e.preventDefault(); applyRewrite(); return; }
      if (e.altKey && /^Digit[1-5]$/.test(e.code)) { e.preventDefault(); startRewrite(rw.el, TONE_KEYS[+e.code.slice(5) - 1], rw); return; }
      if (e.key === 'Escape') { hideBar(); return; }
    }

    if (pending) {
      if (e.altKey && /^Digit[123]$/.test(e.code)) {
        const choice = pending.issue.suggestions[+e.code.slice(5) - 1];
        if (choice !== undefined) { e.preventDefault(); applySuggestion(choice); return; }
      }
      if (e.key === 'Escape') { hideBar(); return; }
    }
    if (!el) return;

    if (lastFix) {
      if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && el === lastFix.el) {
        if (revertLast(el)) { e.preventDefault(); return; }
      }
      if (!['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) lastFix = null;
    }
    if (e.key === 'Enter' && active() && dictState === 'ready') onType(el, true);
  }, true);

  document.addEventListener('keyup', e => {
    if (/^(Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/.test(e.key)) { const el = resolveEditable(e); if (el) setTimeout(() => showIssueAtCaret(el), 0); }
  }, true);
  document.addEventListener('click', e => {
    if (ui && e.composedPath().includes(ui.host)) return;
    const el = resolveEditable(e);
    if (el) setTimeout(() => showIssueAtCaret(el), 0);
  }, true);
  document.addEventListener('pointerdown', e => {
    lastFix = null;
    if (ui && e.composedPath().includes(ui.host)) return;
    hideBar();
  }, true);
  document.addEventListener('focusout', e => {
    setTimeout(() => {
      if (ui && ui.hot) return;
      const ae = document.activeElement;
      if (ae && editableFromNode(ae)) return;
      hideBar();
    }, 160);
  }, true);

  try {
    chrome.runtime.onMessage.addListener((msg, _s, reply) => {
      if (msg && msg.type === 'fixAll') {
        const el = lastEl && lastEl.isConnected ? lastEl : null;
        if (!el) { reply({ fixed: -1 }); return; }
        el.focus();
        reply({ fixed: fixAll(el) });
      }
    });
  } catch (e) { /* ignore */ }
})();
