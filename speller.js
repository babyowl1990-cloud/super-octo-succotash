/* AutoFix Spelling — core engine. Pure logic, no DOM. Works in the content script and in Node tests. */
(function (root) {
  'use strict';

  const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

  // QWERTY neighbours: a slip onto an adjacent key is a much likelier typo.
  const ADJ = {
    q: 'wa', w: 'qes', e: 'wrd', r: 'etf', t: 'ryg', y: 'tuh', u: 'yij', i: 'uok', o: 'ipl', p: 'ol',
    a: 'qsz', s: 'awdx', d: 'sefc', f: 'drgv', g: 'fthb', h: 'gyjn', j: 'hukm', k: 'jilm', l: 'kop',
    z: 'asx', x: 'zsdc', c: 'xdfv', v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk'
  };

  // Always-fix list: classic misspellings and typos that are real/rare words or are >1 edit away.
  const TYPO = {
    teh: 'the', adn: 'and', hte: 'the', taht: 'that', waht: 'what', wiht: 'with', thier: 'their',
    recieve: 'receive', recieved: 'received', definately: 'definitely', definatly: 'definitely',
    definitly: 'definitely', seperate: 'separate', occured: 'occurred', occurence: 'occurrence',
    untill: 'until', becuase: 'because', beacuse: 'because', becasue: 'because', alot: 'a lot',
    wich: 'which', thsi: 'this', tihs: 'this', yuo: 'you', jsut: 'just', abotu: 'about', aslo: 'also',
    cna: 'can', freind: 'friend', wierd: 'weird', goverment: 'government', enviroment: 'environment',
    tommorow: 'tomorrow', tommorrow: 'tomorrow', begining: 'beginning', beleive: 'believe',
    calender: 'calendar', existance: 'existence', foriegn: 'foreign', grammer: 'grammar',
    happend: 'happened', immediatly: 'immediately', interesing: 'interesting', knowlege: 'knowledge',
    neccessary: 'necessary', necesary: 'necessary', occassion: 'occasion', publically: 'publicly',
    realy: 'really', sucess: 'success', succesful: 'successful', suprise: 'surprise', tatoo: 'tattoo',
    truely: 'truly', wensday: 'Wednesday', mispell: 'misspell', accomodate: 'accommodate',
    acheive: 'achieve', adress: 'address', agressive: 'aggressive', apparantly: 'apparently',
    basicly: 'basically', buisness: 'business', comming: 'coming', commited: 'committed',
    concious: 'conscious', dissapear: 'disappear', embarass: 'embarrass', excersize: 'exercise',
    familar: 'familiar', finaly: 'finally', fourty: 'forty', gaurd: 'guard', harrass: 'harass',
    independant: 'independent', millenium: 'millennium', noticable: 'noticeable', persistant: 'persistent',
    posession: 'possession', prefered: 'preferred', privelege: 'privilege', refered: 'referred',
    relevent: 'relevant', restaraunt: 'restaurant', rythm: 'rhythm', shedule: 'schedule',
    unfortunatly: 'unfortunately', wellcome: 'welcome', writting: 'writing'
  };

  // Missing-apostrophe contractions (and lowercase "i'm" family).
  const APOS = {
    dont: "don't", doesnt: "doesn't", didnt: "didn't", cant: "can't", couldnt: "couldn't",
    wouldnt: "wouldn't", shouldnt: "shouldn't", isnt: "isn't", arent: "aren't", wasnt: "wasn't",
    werent: "weren't", hasnt: "hasn't", havent: "haven't", hadnt: "hadn't", wont: "won't",
    im: "I'm", ive: "I've", youre: "you're", theyre: "they're", thats: "that's", whats: "what's",
    "i'm": "I'm", "i'll": "I'll", "i've": "I've", "i'd": "I'd"
  };

  // Chat/internet shorthand — never touch.
  const SKIP = new Set(('lol omg btw tbh idk imo imho brb afk fyi ngl smh wtf lmao rofl thx pls plz ' +
    'ty np gg wp irl dm tldr iirc afaik yolo fomo wfh eta asap diy faq cya yep nope yeah yay nah meh ' +
    'hmm umm uhh ugh ooh aww yup gonna wanna gotta kinda sorta dunno lemme gimme').split(' '));

  function matchCase(orig, fixed) {
    if (orig.length > 1 && orig[0] !== orig[0].toLowerCase() && orig.slice(1) === orig.slice(1).toLowerCase()) {
      return fixed[0].toUpperCase() + fixed.slice(1);
    }
    return fixed;
  }

  function create(WORDS, FREQ) {
    function* edits1(w) {
      const n = w.length;
      for (let i = 0; i < n; i++) yield [w.slice(0, i) + w.slice(i + 1), 'del', i];
      for (let i = 0; i < n - 1; i++) yield [w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2), 'tr', i];
      for (let i = 0; i < n; i++) for (const c of LETTERS) if (c !== w[i]) yield [w.slice(0, i) + c + w.slice(i + 1), 'rep', i, c];
      for (let i = 0; i <= n; i++) for (const c of LETTERS) yield [w.slice(0, i) + c + w.slice(i), 'ins', i];
    }

    // Ranked edit-distance-1 candidates. s = score used for ranking, f = real corpus frequency (0 = obscure word).
    function candidates(w) {
      const out = new Map();
      for (const [c, type, i, ch] of edits1(w)) {
        if (!WORDS.has(c)) continue;
        const f = FREQ.get(c) || 0;
        let s = f > 0 ? f : 0.001;
        if (type === 'tr') s *= 3;
        if (type === 'rep' && ADJ[w[i]] && ADJ[w[i]].includes(ch)) s *= 3;
        if (i === 0 && type !== 'ins') s *= 0.2; // people rarely mistype the first letter
        const prev = out.get(c);
        // Too guessy to auto-apply: dropping a non-doubled letter (stdout -> stout), or swapping a consonant for a
        // non-neighbouring key (offsite -> offside). Vowel swaps (importent -> important) and adjacent keys are fine.
        const risky = (type === 'del' && w[i] !== w[i - 1] && w[i] !== w[i + 1]) ||
          (type === 'rep' && !(ADJ[w[i]] && ADJ[w[i]].includes(ch)) && !(/[aeiou]/.test(w[i]) && /[aeiou]/.test(ch)));
        if (!prev || prev.s < s) out.set(c, { word: c, s, f, type, risky });
      }
      return [...out.values()].sort((a, b) => b.s - a.s);
    }

    // Edit distance 2, only used to populate the suggestion bar (never auto-applied).
    function candidates2(w) {
      const out = new Map();
      if (w.length > 10) return [];
      for (const [e1] of edits1(w)) {
        for (const [e2] of edits1(e1)) {
          if (e2 === w || out.has(e2) || !WORDS.has(e2)) continue;
          const f = FREQ.get(e2) || 0;
          if (f > 0) out.set(e2, { word: e2, s: f * 0.01, f, type: 'e2' });
        }
      }
      return [...out.values()].sort((a, b) => b.s - a.s);
    }

    /**
     * @returns null | {action:'fix', fixed} | {action:'suggest', suggestions:[...]}
     * opts: {sentenceStart, settings:{autoFix,suggest,capI}, ignore:Set, custom:Set}
     */
    function analyze(word, opts) {
      const o = opts || {};
      const st = o.settings || { autoFix: true, suggest: true, capI: true };
      const lower = word.toLowerCase();
      const norm = lower.replace(/’/g, "'");
      if ((o.ignore && o.ignore.has(lower)) || (o.custom && o.custom.has(lower))) return null;

      if (APOS[norm]) {
        const f = norm.includes("'") && norm[0] === 'i' ? APOS[norm] : matchCase(word, APOS[norm]);
        return f === word ? null : { action: 'fix', fixed: f };
      }
      if (norm.includes("'")) return null;
      if (word === 'i') return st.capI ? { action: 'fix', fixed: 'I' } : null;
      if (word.length < 2) return null;

      if (TYPO[lower]) return { action: 'fix', fixed: matchCase(word, TYPO[lower]) };

      if (word.length < 3) return null;
      if (word === word.toUpperCase()) return null;               // ACRONYMS
      if (/[A-Z]/.test(word.slice(1))) return null;                // camelCase / mixed
      if (word[0] !== word[0].toLowerCase() && !o.sentenceStart) return null; // probably a name
      if (/(.)\1\1\1/.test(lower) || /([aeiouy])\1\1/.test(lower)) return null; // "sooooo"
      if (!/[aeiouy]/.test(lower)) return null;                    // npm, brb, hmm
      if (SKIP.has(lower)) return null;

      if (WORDS.has(lower)) {
        // Valid but obscure word that is one swap away from a very common word ("form"/"from" are both
        // common so they never reach here; this catches things like "nad" -> "and").
        if (!FREQ.has(lower) && lower.length <= 7) {
          const hits = [];
          for (let i = 0; i < lower.length - 1; i++) {
            const c = lower.slice(0, i) + lower[i + 1] + lower[i] + lower.slice(i + 2);
            if ((FREQ.get(c) || 0) >= 3000) hits.push(c);
          }
          if (hits.length === 1 && st.autoFix) return { action: 'fix', fixed: matchCase(word, hits[0]) };
        }
        return null;
      }

      let cands = candidates(lower);
      if (cands.length) {
        const best = cands[0], second = cands[1];
        const confident = best.f > 0 && !best.risky && (!second || best.s >= 5 * second.s) && (lower.length >= 4 || best.type === 'tr');
        if (confident && st.autoFix) return { action: 'fix', fixed: matchCase(word, best.word) };
      } else if (lower.length >= 4) {
        cands = candidates2(lower);
      }
      if (!st.suggest || !cands.length) return null;
      const sugg = cands.filter(c => c.f > 0 || cands.length <= 3).slice(0, 3).map(c => matchCase(word, c.word));
      return sugg.length ? { action: 'suggest', suggestions: sugg } : null;
    }

    return { analyze, candidates };
  }

  const api = { create, matchCase };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AutofixSpeller = api;
})(typeof self !== 'undefined' ? self : this);
