'use strict';
/**
 * javascript.js — behaviour-preserving clean-ups for JavaScript, using the Acorn parser.
 *
 * Same design as py_simplify.py (compare them!):
 *   1. Parse to a tree so we understand structure, not just text.
 *   2. Each rule proposes EDITS ({start, end, text}) against the ORIGINAL text, so the
 *      user's formatting and comments survive wherever we did not touch them.
 *   3. Apply non-overlapping edits; if the result no longer parses, keep only edits that do.
 *   4. Repeat until nothing changes, then remove comments that don't explain WHY.
 *
 * We never run the code. Acorn parses plain JavaScript (modern ES, modules or scripts).
 * TypeScript and JSX are not supported: parse() throws and the caller falls back.
 */

const acorn = require('acorn');

const MAX_PASSES = 6;
const TERMINATORS = new Set(['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement']);
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
// `x = x OP y` can always be written `x OP= y` for a plain variable x.
const AUG_OPS = new Set(['+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>']);

// Comments matching this are kept: they usually explain WHY, or are tool directives.
const KEEP_COMMENT = new RegExp(
  '\\b(because|why|so that|workaround|hack|todo|fixme|xxx|note|warning|careful|must|otherwise|' +
    'due to|bug|issue|avoid|ensure|legacy|deprecated|security|important|beware|caveat|assumes?|' +
    'invariant|unless|reason)\\b' +
    '|eslint|prettier|istanbul|c8 |v8 ignore|webpack|@ts-|@license|@preserve|@flow|@jsx|biome|' +
    '#__PURE__|@__PURE__|sourceMappingURL|jshint|https?://',
  'i'
);

// ----------------------------------------------------------------------------- parsing
function parse(src) {
  const comments = [];
  const base = {
    ecmaVersion: 'latest',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    onComment: comments,
  };
  try {
    return { ast: acorn.parse(src, { ...base, sourceType: 'module' }), comments };
  } catch {
    comments.length = 0; // the failed attempt may have collected some
    return { ast: acorn.parse(src, { ...base, sourceType: 'script' }), comments };
  }
}

const parses = (src) => {
  try {
    parse(src);
    return true;
  } catch {
    return false;
  }
};

// ----------------------------------------------------------------------------- tree helpers
function childNodes(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && out.push([c, key]));
    else if (v && typeof v.type === 'string') out.push([v, key]);
  }
  return out;
}

/** Depth-first walk. visit(node, parent, key) — return false to skip the node's children. */
function walk(node, visit, parent = null, key = null) {
  if (visit(node, parent, key) === false) return;
  for (const [child, k] of childNodes(node)) walk(child, visit, node, k);
}

/** The statement list a node owns, if any. */
function statementList(node) {
  if (node.type === 'Program' || node.type === 'BlockStatement' || node.type === 'StaticBlock') return node.body;
  if (node.type === 'SwitchCase') return node.consequent;
  return null;
}

/** Statement lists belonging to ONE function (not crossing into nested functions). */
function listsInFunction(fn) {
  const lists = [];
  walk(fn.body, (node) => {
    if (node !== fn.body && FUNCTION_TYPES.has(node.type)) return false;
    const list = statementList(node);
    if (list) lists.push(list);
    return true;
  });
  return lists;
}

/** True when an Identifier node is a real variable reference/declaration (not a property name or label). */
function isVariableIdentifier(node, parent, key) {
  if (!parent) return true;
  if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return false;
  if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') &&
      key === 'key' && !parent.computed) return false;
  if (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent.type) && key === 'label') return false;
  if (parent.type === 'MetaProperty') return false;
  return true;
}

/** Count Identifier nodes named `name` inside `root` (over-counting is safe: we only delete at zero). */
function countName(root, name, ignoreNode = null, skipImports = false) {
  let n = 0;
  walk(root, (node, parent, key) => {
    if (skipImports && node.type === 'ImportDeclaration') return false;
    if (node.type === 'Identifier' && node.name === name && node !== ignoreNode && isVariableIdentifier(node, parent, key)) n++;
    return true;
  });
  return n;
}

const isPure = (node) => {
  if (!node) return true; // `let x;`
  switch (node.type) {
    case 'Literal': return true;
    case 'TemplateLiteral': return node.expressions.every(isPure);
    case 'UnaryExpression': return ['-', '+', '!'].includes(node.operator) && isPure(node.argument);
    case 'ArrayExpression': return node.elements.every((e) => e && e.type !== 'SpreadElement' && isPure(e));
    case 'ObjectExpression':
      return node.properties.every((p) => p.type === 'Property' && !p.computed && p.kind === 'init' && isPure(p.value));
    default: return false;
  }
};

/** Does this statement always leave the surrounding block (return/throw/break/continue)? */
function exits(stmt) {
  if (TERMINATORS.has(stmt.type)) return true;
  if (stmt.type === 'BlockStatement') return stmt.body.length > 0 && exits(stmt.body[stmt.body.length - 1]);
  return false;
}

// ----------------------------------------------------------------------------- edit helpers
/** Whole-line range if the node is alone on its line(s), otherwise just the node's own range. */
function lineRange(src, start, end) {
  let s = start;
  while (s > 0 && (src[s - 1] === ' ' || src[s - 1] === '\t')) s--;
  let e = end;
  while (e < src.length && (src[e] === ' ' || src[e] === '\t')) e++;
  const alone = (s === 0 || src[s - 1] === '\n') && (e >= src.length || src[e] === '\n');
  return alone ? [s, e < src.length ? e + 1 : e] : [start, end];
}

function removeNode(src, node, rule, detail = 1) {
  const [start, end] = lineRange(src, node.start, node.end);
  return { start, end, text: '', rule, detail };
}

// ----------------------------------------------------------------------------- rules
// Each rule returns an array of edits: { start, end, text, rule, detail }.

/** Code after return/throw/break/continue can never run (hoisted functions/var are kept). */
function ruleUnreachable(src, ast) {
  const edits = [];
  walk(ast, (node) => {
    const list = statementList(node);
    if (!list) return true;
    const i = list.findIndex((s) => TERMINATORS.has(s.type));
    if (i === -1) return true;
    for (const dead of list.slice(i + 1)) {
      const hoisted = dead.type === 'FunctionDeclaration' || (dead.type === 'VariableDeclaration' && dead.kind === 'var');
      if (!hoisted) edits.push(removeNode(src, dead, 'unreachable'));
    }
    return true;
  });
  return edits;
}

/** A lone `;` statement does nothing. */
function ruleEmptyStatement(src, ast) {
  const edits = [];
  walk(ast, (node) => {
    const list = statementList(node);
    if (list) for (const s of list) if (s.type === 'EmptyStatement') edits.push(removeNode(src, s, 'empty_statement'));
    return true;
  });
  return edits;
}

/** `x = x + y`  ->  `x += y` (exactly equivalent for a plain variable). */
function ruleAugAssign(src, ast) {
  const edits = [];
  walk(ast, (node) => {
    if (
      node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'Identifier' &&
      node.right.type === 'BinaryExpression' && AUG_OPS.has(node.right.operator) &&
      node.right.left.type === 'Identifier' && node.right.left.name === node.left.name &&
      node.right.right.type !== 'SequenceExpression'
    ) {
      const rhs = src.slice(node.right.right.start, node.right.right.end);
      if (/\bin\b/.test(rhs)) return true; // `in` is illegal unparenthesised in a for-loop header
      edits.push({
        start: node.start, end: node.end,
        text: `${node.left.name} ${node.right.operator}= ${rhs}`, rule: 'augassign', detail: 1,
      });
    }
    return true;
  });
  return edits;
}

/** `if (c) { return x } else { y }`  ->  `if (c) { return x }  y`  (one level less nesting). */
function ruleElseAfterExit(src, ast, comments) {
  const edits = [];
  walk(ast, (node) => {
    const list = statementList(node);
    if (!list) return true;
    for (const stmt of list) {
      if (stmt.type !== 'IfStatement' || !stmt.alternate || stmt.alternate.type !== 'BlockStatement') continue;
      if (!exits(stmt.consequent)) continue;
      const alt = stmt.alternate;
      // Moving `let/const/class/function` out of the else-block could clash with outer names.
      const clashes = alt.body.some(
        (s) => (s.type === 'VariableDeclaration' && s.kind !== 'var') || s.type === 'ClassDeclaration' || s.type === 'FunctionDeclaration'
      );
      if (clashes) continue;
      if (comments.some((c) => c.start >= stmt.consequent.end && c.end <= alt.start)) continue;
      const inner = src.slice(alt.start + 1, alt.end - 1);
      edits.push({ start: stmt.consequent.end, end: alt.end, text: '\n' + inner, rule: 'else_after_exit', detail: 1 });
    }
    return true;
  });
  return edits;
}

/** `else { if (...) ... }`  ->  `else if (...) ...` */
function ruleElseIf(src, ast, comments) {
  const edits = [];
  walk(ast, (node) => {
    if (node.type === 'IfStatement' && node.alternate && node.alternate.type === 'BlockStatement') {
      const alt = node.alternate;
      if (alt.body.length === 1 && alt.body[0].type === 'IfStatement') {
        const inner = alt.body[0];
        const hasComments = comments.some((c) => c.start >= alt.start && c.end <= alt.end && (c.end <= inner.start || c.start >= inner.end));
        if (!hasComments) {
          edits.push({ start: alt.start, end: alt.end, text: src.slice(inner.start, inner.end), rule: 'else_if', detail: 1 });
        }
      }
    }
    return true;
  });
  return edits;
}

/** `if (!!x)` -> `if (x)` where the value is only used as true/false. */
function ruleDoubleNegation(src, ast) {
  const edits = [];
  const isDouble = (n) => n && n.type === 'UnaryExpression' && n.operator === '!' && n.argument.type === 'UnaryExpression' && n.argument.operator === '!';
  walk(ast, (node) => {
    const test = ['IfStatement', 'WhileStatement', 'DoWhileStatement', 'ForStatement', 'ConditionalExpression'].includes(node.type) ? node.test : null;
    if (isDouble(test)) {
      const inner = test.argument.argument;
      const simple = ['Identifier', 'MemberExpression', 'CallExpression'].includes(inner.type);
      if (node.type !== 'ConditionalExpression' || simple) {
        edits.push({ start: test.start, end: test.end, text: src.slice(inner.start, inner.end), rule: 'double_negation', detail: 1 });
      }
    }
    return true;
  });
  return edits;
}

/** A bare `return;` as the last statement of a function does nothing. */
function ruleTrailingReturn(src, ast) {
  const edits = [];
  walk(ast, (node) => {
    if (FUNCTION_TYPES.has(node.type) && node.body.type === 'BlockStatement' && node.body.body.length > 0) {
      const last = node.body.body[node.body.body.length - 1];
      const bare = last.type === 'ReturnStatement' && (!last.argument || (last.argument.type === 'Identifier' && last.argument.name === 'undefined'));
      if (bare) edits.push(removeNode(src, last, 'trailing_return'));
    }
    return true;
  });
  return edits;
}

/** Unused ES imports and `const x = require('y')` at the top level. */
function ruleUnusedImports(src, ast) {
  const edits = [];
  const usage = new Map(); // name -> occurrences outside import declarations
  walk(ast, (node, parent, key) => {
    if (node.type === 'ImportDeclaration') return false;
    if (node.type === 'Identifier' && isVariableIdentifier(node, parent, key)) usage.set(node.name, (usage.get(node.name) || 0) + 1);
    return true;
  });
  for (const stmt of ast.body) {
    if (stmt.type === 'ImportDeclaration' && stmt.specifiers.length > 0 && !(stmt.attributes && stmt.attributes.length)) {
      const keep = stmt.specifiers.filter((s) => usage.get(s.local.name));
      const drop = stmt.specifiers.filter((s) => !usage.get(s.local.name));
      if (drop.length === 0) continue;
      const names = drop.map((s) => s.local.name).join(', ');
      if (keep.length === 0) {
        edits.push(removeNode(src, stmt, 'unused_import', names));
      } else {
        const parts = [];
        const def = keep.find((s) => s.type === 'ImportDefaultSpecifier');
        const ns = keep.find((s) => s.type === 'ImportNamespaceSpecifier');
        const named = keep.filter((s) => s.type === 'ImportSpecifier');
        if (def) parts.push(src.slice(def.start, def.end));
        if (ns) parts.push(src.slice(ns.start, ns.end));
        if (named.length) parts.push('{ ' + named.map((s) => src.slice(s.start, s.end)).join(', ') + ' }');
        edits.push({ start: stmt.start, end: stmt.end, text: `import ${parts.join(', ')} from ${stmt.source.raw};`, rule: 'unused_import', detail: names });
      }
    } else if (stmt.type === 'VariableDeclaration' && stmt.declarations.length === 1) {
      const d = stmt.declarations[0];
      const isRequire = d.id.type === 'Identifier' && d.init && d.init.type === 'CallExpression' &&
        d.init.callee.type === 'Identifier' && d.init.callee.name === 'require' &&
        d.init.arguments.length === 1 && d.init.arguments[0].type === 'Literal';
      if (isRequire && (usage.get(d.id.name) || 0) <= 1) edits.push(removeNode(src, stmt, 'unused_import', d.id.name));
    }
  }
  return edits;
}

/** `const x = <literal>` inside a function where x is never used. */
function ruleUnusedLocals(src, ast) {
  const edits = [];
  walk(ast, (node) => {
    if (!FUNCTION_TYPES.has(node.type) || node.body.type !== 'BlockStatement') return true;
    let usesEval = false;
    walk(node, (n) => { if ((n.type === 'Identifier' && n.name === 'eval') || n.type === 'WithStatement') usesEval = true; return true; });
    if (usesEval) return true;
    for (const list of listsInFunction(node)) {
      for (const stmt of list) {
        if (stmt.type !== 'VariableDeclaration' || stmt.declarations.length !== 1) continue;
        const d = stmt.declarations[0];
        if (d.id.type !== 'Identifier' || !isPure(d.init)) continue;
        if (countName(node, d.id.name, d.id) === 0) edits.push(removeNode(src, stmt, 'unused_local', d.id.name));
      }
    }
    return true;
  });
  return edits;
}

const RULES = [
  ruleUnreachable, ruleEmptyStatement, ruleAugAssign, ruleElseAfterExit, ruleElseIf,
  ruleDoubleNegation, ruleTrailingReturn, ruleUnusedImports, ruleUnusedLocals,
];

// ----------------------------------------------------------------------------- applying edits
function applyEdits(src, edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const kept = [];
  let lastEnd = -1;
  for (const e of sorted) {
    if (e.start >= lastEnd) { kept.push(e); lastEnd = e.end; }
  }
  const apply = (text, list) => [...list].sort((a, b) => b.start - a.start).reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);

  const all = apply(src, kept);
  if (parses(all)) return { text: all, applied: kept };

  // Something produced invalid code: keep only the edits that individually stay valid.
  let text = src;
  const applied = [];
  for (const e of [...kept].sort((a, b) => b.start - a.start)) { // back to front keeps offsets valid
    const trial = apply(text, [e]);
    if (parses(trial)) { text = trial; applied.push(e); }
  }
  return { text, applied };
}

// ----------------------------------------------------------------------------- comments
function cleanComments(src) {
  let parsed;
  try { parsed = parse(src); } catch { return { text: src, removed: 0, kept: 0 }; }
  const edits = [];
  let kept = 0;
  for (const c of parsed.comments) {
    const text = src.slice(c.start, c.end);
    if ((c.start === 0 && text.startsWith('#!')) || (c.type === 'Block' && text.startsWith('/**')) || (c.type === 'Block' && text.startsWith('/*!')) || KEEP_COMMENT.test(text)) {
      kept++;
      continue;
    }
    let s = c.start;
    while (s > 0 && (src[s - 1] === ' ' || src[s - 1] === '\t')) s--;
    let e = c.end;
    while (e < src.length && (src[e] === ' ' || src[e] === '\t')) e++;
    const startsLine = s === 0 || src[s - 1] === '\n';
    const endsLine = e >= src.length || src[e] === '\n';
    if (startsLine && endsLine) edits.push({ start: s, end: e < src.length ? e + 1 : e, text: '' }); // whole-line comment
    else if (endsLine) edits.push({ start: s, end: c.end, text: '' });                                // trailing comment
    else kept++;                                                                                      // inline /* … */ between code
  }
  if (edits.length === 0) return { text: src, removed: 0, kept };
  const out = [...edits].sort((a, b) => b.start - a.start).reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), src);
  return parses(out) ? { text: out, removed: edits.length, kept } : { text: src, removed: 0, kept };
}

// ----------------------------------------------------------------------------- entry point
/**
 * @returns {{code: string, changes: Array<{rule: string, count: number, detail: string}>}}
 * @throws if the code is not plain JavaScript (e.g. TypeScript or JSX)
 */
function simplifyJavaScript(code) {
  let text = code.replace(/\r\n?/g, '\n');
  parse(text); // throws on syntax Acorn can't read; the caller falls back
  const counts = new Map();
  const details = new Map();
  const note = (rule, detail) => {
    if (typeof detail === 'number') counts.set(rule, (counts.get(rule) || 0) + detail);
    else { counts.set(rule, (counts.get(rule) || 0) + 1); details.set(rule, [...(details.get(rule) || []), detail]); }
  };

  // Drop comments first: a removable comment inside `else { … }` would otherwise block a rewrite.
  const early = cleanComments(text);
  text = early.text;
  if (early.removed) note('comments', early.removed);

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const { ast, comments } = parse(text);
    const edits = RULES.flatMap((rule) => rule(text, ast, comments));
    if (edits.length === 0) break;
    const { text: next, applied } = applyEdits(text, edits);
    if (next === text || applied.length === 0) break;
    applied.forEach((e) => note(e.rule, e.detail));
    text = next;
  }

  const cleaned = cleanComments(text); // catches comments that only became removable after the rewrites
  text = cleaned.text;
  if (cleaned.removed) note('comments', cleaned.removed);

  const changes = [...counts].map(([rule, count]) => ({ rule, count, detail: [...new Set(details.get(rule) || [])].join(', ') }));
  return { code: text, changes, keptComments: early.kept };
}

module.exports = { simplifyJavaScript };
