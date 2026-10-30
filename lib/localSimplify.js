'use strict';
/**
 * localSimplify.js — the "offline" engine used when no API key is configured.
 *
 * It does only mechanical, safe cleanup (no AI):
 *   - removes full-line comments
 *   - removes trailing whitespace
 *   - collapses runs of blank lines
 *
 * It deliberately does NOT rename or restructure anything, because that can
 * change behaviour. Real simplification needs the AI engine.
 */

// Line-comment markers per language. Languages not listed are left untouched.
const COMMENT_MARKERS = {
  python: ['#'],
  javascript: ['//'],
  typescript: ['//'],
  java: ['//'],
  csharp: ['//'],
  go: ['//'],
  rust: ['//'],
  php: ['//', '#'],
  ruby: ['#'],
  bash: ['#'],
  sql: ['--'],
};

function simplifyLocally({ code, language }) {
  const markers = COMMENT_MARKERS[language] || [];
  const out = [];
  let removed = 0;

  code.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();

    // Keep shebangs (#!/usr/bin/env ...) and encoding lines; they are not comments.
    const isShebang = index === 0 && trimmed.startsWith('#!');
    const isComment = markers.some((m) => trimmed.startsWith(m)) && !isShebang;

    if (isComment) {
      removed += 1;
      return;
    }
    out.push(line);
  });

  const cleaned = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // max one blank line in a row
    .trim() + '\n';

  return {
    code: cleaned,
    notes:
      `- Offline mode: removed ${removed} comment line(s), trailing spaces and extra blank lines.\n` +
      '- Renaming, restructuring and explanations need the AI engine (set ANTHROPIC_API_KEY).',
  };
}

module.exports = { simplifyLocally };
