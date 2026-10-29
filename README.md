# AutoFix Spelling v0.4

Offline Chrome extension (Manifest V3). Fixes spelling and grammar as you type, underlines what's left on **every visible text field**, click to fix. Optional ✨ AI rewrite with **any API key**.

## Install
1. Unzip, open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → pick the `autofix-spelling` folder (reload it if you had an older version).
3. Open `test.html` (or any site) and type: `i think its a good idea teh cat. hello world`

## Auto-fixes on space / Enter (Backspace right after = undo)
- Spelling: `teh recieve wrold beautifull` · contractions `dont im` · `i → I`
- Grammar: `its a → it's a` · `your welcome` · `there going` · `a apple → an apple` · `could of` · `more then` · `to much` · repeated words
- Sentence capitalization · snippets (`;date`, `;time`, `;shrug`, your own) · optional double-space collapse and smart punctuation

## Squiggles (every visible field, up to 8 at a time)
Red spelling · amber capitalization · blue grammar · purple/dotted style. Click a squiggle (or arrow into it) → bar with fixes, `✨ Rewrite`, `Ignore`, `+ Add`. `Alt+1/2/3` picks.

## Fix everything
`Alt+Shift+F` inside a field (great after pasting), or the popup button.

## ✨ AI rewrite — bring any API key (optional, off by default)
Popup → **AI rewrite** → pick a provider → paste a key → **Save** → click **Allow** on Chrome's prompt (access is requested only for that one server) → **Test**.

| Provider | Key | Default model (editable) |
|---|---|---|
| Anthropic (Claude) | sk-ant-… | claude-haiku-5-5 |
| OpenAI | sk-… | gpt-4o-mini |
| Google Gemini | AIza… | gemini-3.5-flash |
| OpenRouter | sk-or-… | openai/gpt-4o-mini |
| Groq | gsk_… | llama-3.1-8b-instant |
| Mistral | key | mistral-small-latest |
| Ollama (local) | none | llama3.2 |
| Custom (any OpenAI-compatible server: LM Studio, vLLM, LiteLLM, Together, DeepSeek, Azure…) | optional | you choose |

Model names change often — if **Test** says "not found", type the current name in the Model box. Keys are remembered per provider, so you can switch without re-pasting.
- **Ollama:** start it with `OLLAMA_ORIGINS="chrome-extension://*"`.
- **Custom:** paste the base URL (e.g. `https://my-server/v1`); https only, except localhost.

**Use it:** `Alt+Shift+R` in any field rewrites your selection or the sentence at your caret. The panel offers **Clearer / Shorter / Friendlier / More formal / Fix only** (Alt+1…5), shows which provider answered, **Alt+Enter** replaces, Esc closes, Ctrl+Z undoes.

**Privacy:** keys live in `chrome.storage.local` on this device (never synced) and are used only by the background worker; web pages and content scripts never see them. Text (max 2,000 characters) goes only to the provider you chose, only when you trigger a rewrite or press Test. Usage is billed by that provider. **Remove key** deletes it and revokes the access.

## Safety rails
Skips passwords, emails/usernames, URLs, `code`, hyphenated words, ACRONYMS, camelCase, mid-sentence Capitalized words (names), code editors, `spellcheck="false"` fields and chat slang. Risky guesses (dropping a letter, swapping a consonant) become suggestions instead of auto-fixes.

## Known limits
- Google Docs / canvas editors don't work; editors that fully hijack typing may not emit `input` events.
- English only. The dictionary (~3 MB) loads in a tab once it has a text field with text in it (or you focus one).
