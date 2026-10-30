'use strict';
/**
 * engine/index.js — the rule-based simplifier used when no AI key is configured.
 *
 * It picks the right parser for the language, then turns the list of changes into
 * plain-English notes. If the language isn't supported (or the code won't parse),
 * it falls back to the basic comment/whitespace cleanup and says so.
 */

const { simplifyPython } = require('./python');
const { simplifyJavaScript } = require('./javascript');
const { simplifyLocally } = require('../localSimplify');

const plural = (n, one, many) => (n === 1 ? one : many);

// How each rule is described to the user.
const DESCRIBE = {
  unreachable: (n) => `Removed ${n} unreachable ${plural(n, 'statement', 'statements')} that could never run (code after return/raise/break/continue).`,
  pass: (n) => `Removed ${n} unnecessary \`pass\` ${plural(n, 'statement', 'statements')}.`,
  empty_statement: (n) => `Removed ${n} stray \`;\` ${plural(n, 'statement', 'statements')}.`,
  trailing_return: (n) => `Removed ${n} pointless \`return\` at the end of a function.`,
  else_after_exit: (n) => `Flattened ${n} \`else\` after a return/throw/break/continue (less nesting, same behaviour).`,
  else_if: (n) => `Merged ${n} \`else { if … }\` into \`else if\`.`,
  none_compare: (n) => `Changed ${n} \`== None\` check to \`is None\` (same result unless a class overrides \`==\`).`,
  augassign: (n) => `Rewrote ${n} \`x = x + …\` as \`x += …\`.`,
  double_negation: (n) => `Removed ${n} unnecessary \`!!\` in a condition.`,
  unused_import: (n, d) => `Removed unused ${plural(n, 'import', 'imports')}: ${d}. (Check that none were needed for their side effects.)`,
  unused_local: (n, d) => `Removed ${n} unused ${plural(n, 'variable', 'variables')}: ${d}.`,
  comments: (n) => `Removed ${n} ${plural(n, 'comment', 'comments')} that don't explain why. Comments that explain why are kept.`,
};

function buildNotes(changes) {
  const bullets = changes.map((c) => (DESCRIBE[c.rule] ? DESCRIBE[c.rule](c.count, c.detail) : null)).filter(Boolean);
  if (bullets.length === 0) {
    bullets.push('Nothing could be simplified safely. There was no unused or unreachable code and no comments to remove.');
  }
  bullets.push(
    'Rule-based mode only makes changes that cannot alter behaviour. Renaming, replacing patterns and explanations ' +
      'need the AI engine.'
  );
  return bullets.map((b) => `- ${b}`).join('\n');
}

/**
 * @returns {Promise<{code: string, notes: string, engine: 'rules'|'basic'}>}
 */
async function simplifyRuleBased({ code, language }) {
  let reason = null;
  try {
    let result = null;
    if (language === 'python') {
      result = await simplifyPython(code);
      if (!result.ok) { reason = result.error; result = null; }
    } else if (language === 'javascript' || language === 'typescript') {
      try {
        result = simplifyJavaScript(code);
      } catch {
        reason = 'this is not plain JavaScript (TypeScript and JSX are not supported by the rule engine)';
      }
    } else {
      reason = `the rule engine does not cover ${language} yet`;
    }
    if (result) return { code: result.code, notes: buildNotes(result.changes), engine: 'rules' };
  } catch (err) {
    reason = err.message;
  }

  // Fallback: basic, line-based cleanup.
  const basic = simplifyLocally({ code, language });
  return {
    code: basic.code,
    notes:
      `- Used basic cleanup only: ${reason}.\n` +
      '- That removed comment-only lines and extra blank lines. It works line by line, so text inside multi-line ' +
      'strings that looks like a comment is removed too. Check the diff.\n' +
      '- For real simplification of this code, use the AI engine.',
    engine: 'basic',
  };
}

module.exports = { simplifyRuleBased, buildNotes };
