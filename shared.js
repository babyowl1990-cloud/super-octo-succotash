/* Shared defaults (loaded by content script and popup). */
const AFX_DEFAULTS = {
  enabled: true,
  autoFix: true,        // auto-apply confident spelling fixes
  grammarFix: true,     // auto-apply high-confidence grammar fixes (its/it's, a/an, could of...)
  capSentence: true,    // capitalize the first word of a sentence
  capI: true,           // i -> I, im -> I'm, dont -> don't
  suggest: true,        // show suggestion bar when unsure
  underline: true,      // squiggles under remaining issues; click one to fix
  underlineAll: true,   // squiggle every visible text field on the page, not just the focused one
  style: true,          // wordy-phrase hints
  doubleSpace: false,   // collapse double spaces
  smartPunct: false,    // -- -> —   ... -> …
  rewriteEnabled: false, // optional ✨ rewrite with Claude (needs your own API key)
  rewriteReady: false,   // set by the popup once a key is saved and access is granted
  rewriteTone: 'clearer',
  disabledSites: [],
  custom: [],
  snippets: { ';date': '{date}', ';time': '{time}', ';shrug': '¯\\_(ツ)_/¯' }
};
