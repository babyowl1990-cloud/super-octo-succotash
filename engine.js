/* AutoFix Spelling — text engine: spelling + grammar + capitalization + style, one pass over a string. Pure logic. */
(function (root) {
  'use strict';

  const ABBR = new Set('mr mrs ms dr prof sr jr st vs eg ie inc ltd fig approx dept est'.split(' '));
  const DOUBLE_OK = new Set('had that bye no so very ha haha yes yeah really oh ah hey go now much many blah la na boo choo tut ho wow'.split(' '));
  const ITS_NEXT = new Set('a an been not going very just so too also really still always never only gonna getting'.split(' '));
  const ITS_POSS = new Set('own purpose name size shape color colour value features owner behavior behaviour'.split(' '));
  const YOUR_NEXT = new Set('welcome going not gonna right wrong sure doing getting so too very really always never just still also a an the supposed able here there only probably ready late early'.split(' '));
  const YOURE_POSS = new Set('own name house car mom dad friend friends family phone email account order team work job life money parents kids children wife husband boss school website address number password opinion'.split(' '));
  const THERE_NEXT = new Set('going gonna always never really probably doing coming'.split(' '));
  const THEIR_NEXT = new Set('is are was were isnt arent wasnt werent'.split(' '));
  const THEYRE_POSS = new Set('house car own home dog cat friends family parents kids children team work job names name phone'.split(' '));
  const MODAL = new Set('could would should must might'.split(' '));
  const COMP = new Set('more less better worse bigger smaller larger fewer greater higher lower faster slower older younger easier harder longer shorter taller cheaper smarter stronger weaker'.split(' '));
  const TOO_NEXT = new Set('much late'.split(' '));

  const WORDY = [
    ['in order to', 'to'], ['due to the fact that', 'because'], ['at this point in time', 'now'],
    ['in the event that', 'if'], ['for the purpose of', 'for'], ['is able to', 'can'], ['has the ability to', 'can'],
    ['in spite of the fact that', 'although'], ['with regard to', 'about'], ['with regards to', 'about'],
    ['on a daily basis', 'daily'], ['each and every', 'every'], ['end result', 'result'], ['past history', 'history'],
    ['at the present time', 'now'], ['in close proximity to', 'near'], ['a large number of', 'many'],
    ['a majority of', 'most'], ['make use of', 'use'], ['in the near future', 'soon'], ['prior to', 'before'],
    ['subsequent to', 'after'], ['whether or not', 'whether'], ['as a matter of fact', 'in fact'],
    ['at all times', 'always'], ['basic fundamentals', 'fundamentals'], ['completely finished', 'finished'],
    ['absolutely essential', 'essential'], ['advance planning', 'planning'], ['free gift', 'gift'],
    ['the reason why', 'the reason'], ['in my opinion, i think', 'I think'], ['it is important to note that', 'note that']
  ].map(([p, r]) => ({ p, r, re: new RegExp('\\b' + p.replace(/ /g, '\\s+') + '\\b', 'gi') }));

  const PRI = { spell: 0, grammar: 1, cap: 2, style: 3 };

  function upFirst(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
  function matchCase(orig, repl) {
    return orig && orig[0] !== orig[0].toLowerCase() && repl ? upFirst(repl) : repl;
  }

  function vowelSound(l) {
    if (/^(hour|honest|honou?r|heir)/.test(l)) return true;
    if (/^(uni(?![mnr])|us[eu]|uti|ute|uto|eu|one|once|ubiq|ewe)/.test(l)) return false;
    return /^[aeiou]/.test(l);
  }

  function tokenize(text) {
    const re = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
    const toks = [];
    let m;
    while ((m = re.exec(text))) toks.push({ s: m.index, e: m.index + m[0].length, w: m[0], l: m[0].toLowerCase().replace(/’/g, "'") });
    return toks;
  }

  function protectedRanges(text) {
    const out = [];
    const res = [/\b(?:https?:\/\/|www\.)\S+/gi, /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, /`[^`\n]*`/g];
    for (const re of res) { let m; while ((m = re.exec(text))) out.push([m.index, m.index + m[0].length]); }
    return out;
  }
  const inRanges = (rs, i) => rs.some(([a, b]) => i >= a && i < b);

  function neighborSkip(text, t) {
    const prev = text[t.s - 1] || '', next = text[t.e] || '', next2 = text[t.e + 1] || '';
    if (prev && (/[\/@.:\-_#\\$%&=+~0-9]/.test(prev) || /\p{L}/u.test(prev))) return true;
    if (next && (/[\/@_#\\=\d]/.test(next) || /\p{L}/u.test(next) ||
        (next === '.' && /[A-Za-z]/.test(next2)) || (next === '-' && /[A-Za-z]/.test(next2)))) return true;
    return false;
  }

  function sentenceStart(text, s, startIsSentence) {
    let i = s - 1;
    while (i >= 0 && /[ \t\u00A0"“'‘(\[]/.test(text[i])) i--;
    if (i < 0) return startIsSentence;
    const c = text[i];
    if (c === '\n' || c === '!' || c === '?') return true;
    if (c === '.') {
      let j = i - 1;
      while (j >= 0 && /[A-Za-z]/.test(text[j])) j--;
      const w = text.slice(j + 1, i).toLowerCase();
      if (!w || w.length === 1 || ABBR.has(w)) return false;
      return true;
    }
    return false;
  }

  function create(speller) {
    const cache = new Map();
    const EMPTY = new Set();

    function spellAnalyze(t, capI) {
      const key = t.w + '|' + (t.ss ? 1 : 0) + '|' + (capI ? 1 : 0);
      if (cache.has(key)) return cache.get(key);
      const res = speller.analyze(t.w, { sentenceStart: t.ss, settings: { autoFix: true, suggest: true, capI }, ignore: EMPTY, custom: EMPTY });
      if (cache.size > 6000) cache.clear();
      cache.set(key, res);
      return res;
    }

    /**
     * Returns issues: {s,e,word,replacement|null,suggestions[],kind,rule,label,auto,trigEnd,key}
     * o: {settings, ignore:Set, custom:Set, startIsSentence, noCap, noStyle, typing:{caret,recent}}
     */
    function findIssues(text, o) {
      o = o || {};
      const st = o.settings || {};
      const ignore = o.ignore || EMPTY, custom = o.custom || EMPTY;
      const capOn = st.capSentence !== false && !o.noCap && !ignore.has('cap');
      const gramAuto = st.grammarFix !== false;
      const toks = tokenize(text);
      const prot = protectedRanges(text);
      for (const t of toks) {
        t.skip = inRanges(prot, t.s) || neighborSkip(text, t);
        t.ss = !t.skip && sentenceStart(text, t.s, o.startIsSentence !== false);
      }
      const byStart = new Map(toks.map(t => [t.s, t]));
      const issues = [];
      const push = (i) => issues.push(i);

      // ---- spelling + sentence capitalization ----
      for (const t of toks) {
        if (t.skip) continue;
        if (o.typing && o.typing.recent && t.e === o.typing.caret) continue;
        if (ignore.has(t.l) || custom.has(t.l)) continue;
        const res = spellAnalyze(t, st.capI !== false);
        if (res && res.action === 'fix') {
          let r = res.fixed;
          if (t.ss && capOn) r = upFirst(r);
          push({ s: t.s, e: t.e, word: t.w, replacement: r, suggestions: [r], kind: 'spell', rule: 'spell',
            label: t.w === 'i' ? 'Capitalize “I”' : 'Spelling', auto: st.autoFix !== false, trigEnd: t.e, key: t.l });
        } else if (res && res.action === 'suggest') {
          push({ s: t.s, e: t.e, word: t.w, replacement: null, suggestions: res.suggestions, kind: 'spell', rule: 'spell',
            label: 'Possible misspelling', auto: false, trigEnd: t.e, key: t.l });
        } else if (capOn && t.ss && /^[a-z]/.test(t.w) && !/[A-Z]/.test(t.w.slice(1)) && !(text[t.e] === '.' && t.w.length <= 2)) {
          push({ s: t.s, e: t.e, word: t.w, replacement: upFirst(t.w), suggestions: [upFirst(t.w)], kind: 'cap', rule: 'cap',
            label: 'Capitalize the first word of a sentence', auto: true, trigEnd: t.e, key: 'cap' });
        }
      }

      // ---- grammar (token-pair rules) ----
      const adj = (i) => i > 0 && !toks[i - 1].skip && /^[ \u00A0]+$/.test(text.slice(toks[i - 1].e, toks[i].s));
      const gram = (rule, s, e, replacement, label, trigEnd, auto) => {
        const word = text.slice(s, e);
        const key = 'g:' + rule + ':' + word.toLowerCase();
        if (ignore.has(key)) return;
        push({ s, e, word, replacement, suggestions: [replacement], kind: 'grammar', rule, label, auto: auto && gramAuto, trigEnd, key });
      };
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t.skip) continue;
        const p = adj(i) ? toks[i - 1] : null;
        const n = i + 1 < toks.length && adj(i + 1) ? toks[i + 1] : null;

        // repeated word
        if (p && p.l === t.l && t.w.length > 1 && !DOUBLE_OK.has(t.l)) gram('dup', p.e, t.e, '', `Repeated word “${t.w}”`, t.e, true);

        // a / an
        if (p && (p.l === 'a' || p.l === 'an') && t.w.length >= 2 && t.w !== t.w.toUpperCase()) {
          const wantAn = vowelSound(t.l);
          if (p.l === 'a' && wantAn) gram('aan', p.s, p.e, matchCase(p.w, 'an'), `Use “an” before “${t.w}”`, t.e, true);
          else if (p.l === 'an' && !wantAn && !t.l.startsWith('h')) gram('aan', p.s, p.e, matchCase(p.w, 'a'), `Use “a” before “${t.w}”`, t.e, true);
        }
        // its / it's
        if (t.l === 'its' && n && ITS_NEXT.has(n.l)) gram('its', t.s, t.e, matchCase(t.w, "it's"), 'It’s = “it is”', n.e, true);
        if (t.l === "it's" && n && ITS_POSS.has(n.l)) gram('its', t.s, t.e, matchCase(t.w, 'its'), 'Possessive “its” has no apostrophe', n.e, true);
        // your / you're
        if (t.l === 'your' && n && YOUR_NEXT.has(n.l)) gram('your', t.s, t.e, matchCase(t.w, "you're"), 'You’re = “you are”', n.e, true);
        if (t.l === "you're" && n && YOURE_POSS.has(n.l)) gram('your', t.s, t.e, matchCase(t.w, 'your'), 'Possessive “your”', n.e, true);
        // there / their / they're
        if (t.l === 'there' && n && THERE_NEXT.has(n.l)) gram('there', t.s, t.e, matchCase(t.w, "they're"), 'They’re = “they are”', n.e, true);
        if (t.l === 'their' && n && THEIR_NEXT.has(n.l)) gram('there', t.s, t.e, matchCase(t.w, 'there'), 'Use “there”', n.e, true);
        if (t.l === "they're" && n && THEYRE_POSS.has(n.l)) gram('there', t.s, t.e, matchCase(t.w, 'their'), 'Possessive “their”', n.e, true);
        // could of -> could have
        if (t.l === 'of' && p && MODAL.has(p.l) && !(n && n.l === 'course')) gram('of', t.s, t.e, 'have', `“${p.w} have”, not “${p.w} of”`, t.e, true);
        // more then -> more than
        if (t.l === 'then' && p && COMP.has(p.l)) gram('than', t.s, t.e, matchCase(t.w, 'than'), 'Use “than” for comparisons', t.e, true);
        // to much -> too much
        if (t.l === 'to' && n && TOO_NEXT.has(n.l)) gram('too', t.s, t.e, matchCase(t.w, 'too'), 'Use “too”', n.e, true);
        // subject–verb (suggest only)
        if (p) {
          if (['he', 'she', 'it'].includes(p.l) && t.l === "don't") gram('sv', t.s, t.e, "doesn't", `Use “doesn't” with “${p.w}”`, t.e, false);
          if (['they', 'we', 'you'].includes(p.l) && t.l === 'was') gram('sv', t.s, t.e, 'were', `Use “were” with “${p.w}”`, t.e, false);
          if (['they', 'we', 'you'].includes(p.l) && t.l === 'is') gram('sv', t.s, t.e, 'are', `Use “are” with “${p.w}”`, t.e, false);
          if (p.w === 'I' && t.l === 'is') gram('sv', t.s, t.e, 'am', 'Use “am” with “I”', t.e, false);
        }
      }
      // space before punctuation (suggest only)
      { const re = /[A-Za-z] +([,.;:!?])(?=\s|$)/g; let m;
        while ((m = re.exec(text))) {
          const s = m.index + 1, e = m.index + m[0].length - 1;
          if (!inRanges(prot, s)) gram('sp', s, e + 1, m[1], 'Remove the space before the punctuation', e + 1, false);
        } }

      // ---- style: wordy phrases (never auto) ----
      if (st.style !== false && !o.noStyle) {
        for (const w of WORDY) {
          w.re.lastIndex = 0; let m;
          while ((m = w.re.exec(text))) {
            if (inRanges(prot, m.index)) continue;
            const key = 'y:' + w.p;
            if (ignore.has(key)) continue;
            const r = matchCase(m[0], w.r);
            push({ s: m.index, e: m.index + m[0].length, word: m[0], replacement: r, suggestions: [r], kind: 'style', rule: 'wordy',
              label: `Wordy — try “${w.r}”`, auto: false, trigEnd: m.index + m[0].length, key });
          }
        }
      }

      // sentence-start capitalization for replacements that begin a sentence
      if (capOn) for (const i of issues) {
        const t = byStart.get(i.s);
        if (t && t.ss && i.replacement && /^[a-z]/.test(i.replacement) && i.kind !== 'style') {
          i.replacement = upFirst(i.replacement); i.suggestions = [i.replacement];
        }
      }

      // resolve overlaps: spelling > grammar > cap > style
      const ordered = issues.slice().sort((a, b) => PRI[a.kind] - PRI[b.kind] || a.s - b.s);
      const kept = [];
      for (const i of ordered) if (!kept.some(k => i.s < k.e && k.s < i.e)) kept.push(i);
      return kept.sort((a, b) => a.s - b.s);
    }

    return { findIssues, tokenize };
  }

  const api = { create, upFirst, matchCase };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AutofixEngine = api;
})(typeof self !== 'undefined' ? self : this);
