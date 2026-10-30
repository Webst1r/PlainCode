# PlainCode

Paste messy or over-engineered code, get simple readable code back with plain-English notes.
No frameworks and no build step: a small Express server and a plain HTML/CSS/JS front end.

## Run it

```bash
npm install
npm start                      # http://localhost:3000 (rule-based engine, no AI needed)

# With the AI engine (simplify, explain, skill levels):
export ANTHROPIC_API_KEY=your-key-here
npm start
```

`npm test` runs 36 automated tests (no API key or network needed). Python tests need `python3` installed.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Turns on the AI engine. Keep it server-side only. |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Which model to call. |
| `FREE_RUNS_PER_DAY` | 5 | Free runs per visitor per day. |
| `MAX_CHARS` | 20000 | Longest code accepted. |
| `PORT` | 3000 | Server port. |
| `PYTHON_BIN` | `python3` | Python 3.9+ command used by the rule-based engine for Python code. |
| `TRUST_PROXY` | unset | Set to `1` when hosted behind a proxy (Render, Fly, nginx) so the rate limit sees real visitor IPs. |

## Project map

```
server.js              Express app: routes, validation, security headers
lib/prompt.js          The instructions sent to the AI (the "product")
lib/llm.js             Calls the Anthropic API and parses the reply
lib/engine/index.js    Rule-based engine: picks the language, writes the notes
lib/engine/javascript.js  JavaScript rules (Acorn parser)
lib/engine/py_simplify.py Python rules (Python's own ast module)
lib/engine/python.js   Runs py_simplify.py as a separate, time-limited process
lib/localSimplify.js   Basic fallback: comment-line and blank-line cleanup
lib/format.js          Prettier pass over the output
lib/rateLimit.js       "N free runs per day" in memory
public/index.html      Home page
public/how.html        How it works page
public/tool.html       The tool page (needs the server running)
public/styles.css      Theme variables at the top, then components
public/app.js          Nav, feature tabs, tool logic, diff algorithm
test/api.test.js       Unit + API tests
test/engine.test.js    Engine tests, including run-before-and-after behaviour checks
```

## The two engines

| | Rule-based (default, no key) | AI (needs `ANTHROPIC_API_KEY`) |
|---|---|---|
| Languages | Python, JavaScript | 14 |
| Changes | Only ones that cannot alter behaviour | Renaming, restructuring, simplifying patterns |
| Explain mode and skill levels | No | Yes |
| Cost | Free | API cost per run |

What the rule-based engine does: removes unused imports and unused local variables, unreachable code, `pass` and
`return` that do nothing, and comments that don't explain *why*; flattens `else` after `return`; rewrites
`x = x + y` as `x += y` (only where provably safe); `== None` becomes `is None`; and in JavaScript merges
`else { if }` into `else if` and drops `!!` in conditions. Every change is listed in the Notes tab.

How it was checked: 36 tests; the original and simplified programs are run and their output compared; 331 Python
standard-library files and 356 JavaScript files were processed with no crashes, invalid output or unstable
results; and doctests of 37 standard-library modules pass or fail identically before and after.

## Note on opening the pages

The three pages are real HTML files, so you can open `public/index.html` straight from a file viewer and click between pages.
The tool page only *works* (Simplify button) when the server is running, because it calls `/api/simplify`.

## Deploying

This needs a Node host (Render, Railway, Fly.io, a VPS). It is not a static site, because the API key must stay on the server.
Set `ANTHROPIC_API_KEY` and `TRUST_PROXY=1` in the host's environment settings.

## Known limits and next steps

- **Rate limit is in memory.** It resets on restart and isn't shared across servers. Move it to Redis or Supabase before real traffic.
- **Rule engine limits.** It works on one file at a time, so it can't know whether another file imports a name you didn't use. It does not support TypeScript or JSX (falls back to basic cleanup). Removing an unused import can drop a side effect, so the notes tell users to check. It is deliberately conservative: it misses some simplifications rather than risk changing behaviour.
- **No behaviour verification in the product yet.** Running users' code to compare before and after is risky (it's remote code execution) and needs a proper sandbox. Until then the UI tells people to test the result.
- **No accounts or payments yet.** Pro tier plan: Supabase for auth, PayFast or Yoco for ZAR payments.
- **Formatting** only covers JS, TS, JSON, CSS and HTML (Prettier). Python (Black) would be a good addition.
- **Fonts** load from Google Fonts. If you want zero third-party requests, self-host them and tighten the CSP in `server.js`.
