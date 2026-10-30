'use strict';
/**
 * app.js — all the browser-side behaviour. No frameworks, no build step.
 *
 * Sections (search for the ==== headings):
 *   1. Tiny helpers
 *   2. Navigation        (active link + mobile menu, runs on every page)
 *   3. Feature tabs      (home page only)
 *   4. The tool          (tool page only: form, API call, output tabs, copy)
 *   5. Diff              (a small line-by-line diff algorithm)
 */

// ==== 1. Tiny helpers ======================================================
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * Escape text before putting it in innerHTML. Code and AI notes are UNTRUSTED:
 * without this, pasted "<script>" would run in the page (an XSS bug).
 */
function escapeHtml(text) {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
}

// ==== 2. Navigation ========================================================
// Each page is a real HTML file, so links work even if JavaScript is off.
// JS only adds polish: highlighting the current link and the mobile menu.
const page = document.body.dataset.page; // 'home' | 'how' | 'tool'
$$('[data-nav]').forEach((link) =>
  link.classList.toggle('active', link.dataset.nav === page),
);

$('#menuBtn').addEventListener('click', () => {
  const open = $('#navLinks').classList.toggle('open');
  $('#menuBtn').setAttribute('aria-expanded', String(open));
});

// ==== 3. Feature tabs (home page) ==========================================
const PILLARS = [
  {
    title: 'Simplify',
    text: 'Two engines. The rule-based engine makes only changes that cannot alter behaviour, with no AI and no key. The AI engine goes further: shorter functions, clearer names, simpler structure.',
    bullets: [
      'Rule-based: removes unused imports and variables, dead code and stray comments',
      'Rule-based: flattens else-after-return and rewrites x = x + y as x += y',
      'AI engine: renames, restructures and replaces over-engineered patterns',
    ],
    stat: 'Rule-based engine: Python and JavaScript',
  },
  {
    title: 'Explain',
    text: 'Get a plain-English walkthrough of what the code does, step by step, with no jargon.',
    bullets: [
      'Short bullet points, not essays',
      'Explains why each change was made',
      'Great for interviews and code reviews',
    ],
    stat: 'Works on its own or together with Simplify',
  },
  {
    title: 'Skill levels',
    text: 'Choose how simple you want it. Beginner mode sticks to basic loops and if-statements.',
    bullets: [
      'Beginner: basic constructs only',
      'Intermediate: idiomatic but uncluttered',
      'Concise: short and direct',
    ],
    stat: 'Switch levels and run again any time',
  },
  {
    title: 'Side-by-side diff',
    text: 'See every added and removed line before you trust the result.',
    bullets: [
      'Green for added, red for removed',
      'Spot behaviour changes quickly',
      'One click to copy the final code',
    ],
    stat: 'Review first, then use',
  },
];

function showPillar(index) {
  const p = PILLARS[index];
  $$('[data-pillar]').forEach((btn) =>
    btn.setAttribute(
      'aria-selected',
      String(Number(btn.dataset.pillar) === index),
    ),
  );
  $('#pillarPanel').innerHTML = `
    <div>
      <h3>${escapeHtml(p.title)}</h3>
      <p>${escapeHtml(p.text)}</p>
      <p class="stat">${escapeHtml(p.stat)}</p>
      <a class="btn btn-small" href="#/tool">Try it →</a>
    </div>
    <ul>${p.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`;
}

if ($('#pillarPanel')) {
  $$('[data-pillar]').forEach((btn) =>
    btn.addEventListener('click', () => showPillar(Number(btn.dataset.pillar))),
  );
  showPillar(0);
}

// ==== 4. The tool ==========================================================
function initTool() {
  const state = {
    status: null, // from GET /api/status
    original: '', // the code that was sent
    result: { code: '', notes: '' },
    tab: 'code', // which output tab is visible
    busy: false,
  };

  const SAMPLE = `# Calculates the total price of items in a cart, applying discounts
import os
import json

class PriceCalculatorFactory:
    """Factory for creating price calculators."""
    def __init__(self):
        self._strategies = {}

    def register(self, name, fn):
        self._strategies[name] = fn
        return self

    def create(self, name):
        return self._strategies.get(name, lambda x: x)

def compute_total(items, discount_percent=0):
    # initialise the total
    total = 0
    unused_counter = 0
    # loop over each item in the list
    for item in items:
        # add the price multiplied by the quantity
        total = total + (item['price'] * item['qty'])
    if discount_percent == None:
        return total
    else:
        # apply the discount
        factory = PriceCalculatorFactory().register('pct', lambda t: t - (t * discount_percent / 100))
        return factory.create('pct')(total)
    print('done')
`;

  async function loadStatus() {
    try {
      const res = await fetch('/api/status');
      state.status = await res.json();
    } catch {
      state.status = null;
    }
    renderStatus();
    if (state.status && $('#language').options.length === 0) {
      state.status.languages.forEach((lang) => {
        const option = new Option(
          lang === 'csharp' ? 'C#' : lang[0].toUpperCase() + lang.slice(1),
          lang,
        );
        $('#language').add(option);
      });
    }
    updateCount();
  }

  function renderStatus() {
    const s = state.status;
    const el = $('#status');
    if (!s) {
      el.innerHTML =
        '<span class="pill warn">Could not reach the server</span>';
      return;
    }
    const engine =
      s.engine === 'ai'
        ? '<span class="pill ok">AI engine on</span>'
        : '<span class="pill ok">Rule-based engine: safe clean-ups, no AI</span>' +
          '<span class="pill warn">Explain and skill levels need the AI engine</span>';
    el.innerHTML = `${engine}<span class="pill">${s.remaining} of ${s.limit} free runs left today</span>`;
  }

  function updateCount() {
    const max = state.status ? state.status.maxChars : 20000;
    const len = $('#code').value.length;
    const el = $('#count');
    el.textContent = `${len.toLocaleString()} / ${max.toLocaleString()}`;
    el.classList.toggle('over', len > max);
  }
  $('#code').addEventListener('input', updateCount);

  function showError(message) {
    const el = $('#error');
    el.textContent = message || '';
    el.hidden = !message;
  }

  // -- Output tabs --
  function renderOutput() {
    const out = $('#output');
    const { code, notes } = state.result;

    $$('[data-out]').forEach((btn) =>
      btn.setAttribute('aria-selected', String(btn.dataset.out === state.tab)),
    );

    if (!code && !notes) {
      out.innerHTML = '<p class="muted">Your result will appear here.</p>';
      return;
    }

    if (state.tab === 'code') {
      out.innerHTML = code
        ? `<pre>${escapeHtml(code)}</pre>`
        : '<p class="muted">No code in this mode. See the Notes tab.</p>';
    } else if (state.tab === 'diff') {
      out.innerHTML = code
        ? renderDiff(state.original, code)
        : '<p class="muted">No code to compare in this mode.</p>';
    } else {
      out.innerHTML = notes
        ? renderNotes(notes)
        : '<p class="muted">No notes in this mode.</p>';
    }
  }

  /** Notes arrive as "- bullet" lines. Turn them into a safe <ul>. */
  function renderNotes(notes) {
    const items = notes
      .split('\n')
      .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
      .filter(Boolean);
    return `<div class="notes"><ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul></div>`;
  }

  $$('[data-out]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.out;
      renderOutput();
    }),
  );

  // -- Submit --
  $('#toolForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.busy) return;
    showError('');

    const payload = {
      code: $('#code').value,
      language: $('#language').value,
      mode: $('#mode').value,
      level: $('#level').value,
    };
    if (!payload.code.trim()) {
      showError('Paste some code first.');
      return;
    }

    state.busy = true;
    $('#runBtn').disabled = true;
    $('#runBtn').textContent = 'Working…';

    try {
      const res = await fetch('/api/simplify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');

      state.original = payload.code;
      state.result = { code: data.code || '', notes: data.notes || '' };
      // Show the most useful tab for the chosen mode.
      state.tab = payload.mode === 'explain' ? 'notes' : 'code';
      if (state.status) {
        state.status.remaining = data.remaining;
        renderStatus();
      }
      renderOutput();
    } catch (err) {
      showError(err.message);
      if (state.status && /free runs/.test(err.message)) {
        state.status.remaining = 0;
        renderStatus();
      }
    } finally {
      state.busy = false;
      $('#runBtn').disabled = false;
      $('#runBtn').textContent = 'Simplify →';
    }
  });

  $('#sampleBtn').addEventListener('click', () => {
    $('#code').value = SAMPLE;
    $('#language').value = 'python';
    updateCount();
  });

  $('#copyBtn').addEventListener('click', async () => {
    const text = state.tab === 'notes' ? state.result.notes : state.result.code;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      $('#copyBtn').textContent = 'Copied ✓';
    } catch {
      $('#copyBtn').textContent = 'Press Ctrl+C';
    }
    setTimeout(() => {
      $('#copyBtn').textContent = 'Copy';
    }, 1500);
  });

  loadStatus();
}

// ==== 5. Diff ==============================================================
/**
 * Line diff using the "longest common subsequence" (LCS) idea:
 * find the lines both versions share, in order; everything else is either
 * removed (only in old) or added (only in new).
 *
 * Complexity is O(n*m), fine for our 20,000-character limit.
 */
function diffLines(oldText, newText) {
  const a = oldText.replace(/\s+$/, '').split('\n');
  const b = newText.replace(/\s+$/, '').split('\n');

  // table[i][j] = length of the LCS of a[i..] and b[j..]
  const table = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  // Walk the table to produce the ordered list of operations.
  const ops = [];
  let i = 0,
    j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: 'del', text: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < a.length) ops.push({ type: 'del', text: a[i++] });
  while (j < b.length) ops.push({ type: 'add', text: b[j++] });
  return ops;
}

function renderDiff(oldText, newText) {
  const prefix = { same: '  ', add: '+ ', del: '- ' };
  const html = diffLines(oldText, newText)
    .map(
      (op) =>
        `<span class="diff-line diff-${op.type}">${prefix[op.type]}${escapeHtml(op.text) || ' '}</span>`,
    )
    .join('');
  return `<div>${html}</div>`;
}

// ==== Start ================================================================
if ($('#toolForm')) initTool();
