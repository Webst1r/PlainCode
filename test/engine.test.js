'use strict';
/**
 * Tests for the rule-based engine.
 *
 * The most important ones RUN the original and the simplified program and compare their
 * output: that is the real proof that "same behaviour" holds, not just that text changed.
 * (We run our own fixtures here. The product itself never executes users' code.)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const { simplifyPython } = require('../lib/engine/python');
const { simplifyJavaScript } = require('../lib/engine/javascript');
const { simplifyRuleBased } = require('../lib/engine');

const hasPython = spawnSync('python3', ['--version']).status === 0;
const py = { skip: hasPython ? false : 'python3 not installed' };

const runPython = (code) => {
  const r = spawnSync('python3', ['-I', '-c', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, `python failed: ${r.stderr}`);
  return r.stdout;
};
const runJs = (code) => {
  const logs = [];
  vm.runInNewContext(code, { console: { log: (...a) => logs.push(a.join(' ')) } }, { timeout: 2000 });
  return logs.join('\n');
};
const rules = (changes) => Object.fromEntries(changes.map((c) => [c.rule, c.count]));

// ------------------------------------------------------------------------------ Python
test('python: behaviour is identical before and after (end-to-end run)', py, async () => {
  const program = `
import os
import sys
import json

def classify(n):
    if n < 0:
        return 'neg'
    else:
        if n == 0:
            return 'zero'
        else:
            return 'pos'
    print('unreachable')

def total(items, discount=None):
    # sum with discount
    t = 0
    unused = [1, 2]
    for item in items:
        t = t + item * 2
    if discount == None:
        pass
    else:
        t = t - discount
    return t
    return 99

def build(n):
    s = ''
    for i in range(n):
        s = s + str(i)
    return s

def collect(a):
    out = a
    out = out + [1]   # must NOT become += (that would mutate the caller's list)
    return out

data = [3]
res = collect(data)
print(classify(-1), classify(0), classify(5), total([1, 2, 3]), total([1, 2], 1), build(4), data, res, json.dumps({'a': 1}))
`;
  const result = await simplifyPython(program);
  assert.ok(result.ok);
  assert.equal(runPython(result.code), runPython(program));
  assert.equal(runPython(program).trim(), 'neg zero pos 12 5 0123 [3] [3, 1] {"a": 1}');
  const r = rules(result.changes);
  assert.ok(r.unreachable >= 2 && r.augassign >= 2 && r.unused_import === 2 && r.unused_local === 1 && r.none_compare === 1);
  assert.match(result.code, /out = out \+ \[1\]/, 'list accumulation must be left alone');
  assert.doesNotMatch(result.code, /import os|import sys|unused|unreachable|return 99/);
});

test('python: elif chains are not flattened (that would change the logic)', py, async () => {
  const code = "def f(x):\n    if x == 1:\n        return 'a'\n    elif x == 2:\n        return 'b'\n    else:\n        return 'c'\n";
  const result = await simplifyPython(code);
  assert.equal(result.code, code);
  assert.deepEqual(result.changes, []);
});

test('python: augmented assignment only for names proven immutable', py, async () => {
  const code = [
    'def a(x):',
    '    x = x + 1',            // parameter: unknown type, leave alone
    '    return x',
    'def b():',
    '    n = 0',
    '    n = n + 1',            // constant-initialised: safe
    '    return n',
    'def c(items):',
    '    acc = items',          // unknown type
    '    acc = acc + [1]',
    '    return acc',
    '',
  ].join('\n');
  const { code: out } = await simplifyPython(code);
  assert.match(out, /x = x \+ 1/);
  assert.match(out, /n \+= 1/);
  assert.match(out, /acc = acc \+ \[1\]/);
});

test('python: comments that explain why are kept, others dropped; strings are untouched', py, async () => {
  const code = [
    '# adds numbers',
    'def f(a, b):',
    '    # this is the sum',
    '    s = a + b  # add them',
    '    # because the API expects strings, convert here',
    '    return str(s)',
    '',
    'text = """line one',
    '',
    '# not a comment, it is inside a string',
    '   spaced   ',
    '"""',
    'print(f(1, 2), repr(text))',
    '',
  ].join('\n');
  const result = await simplifyPython(code);
  assert.match(result.code, /because the API expects strings/);
  assert.doesNotMatch(result.code, /adds numbers|this is the sum|add them/);
  assert.match(result.code, /# not a comment, it is inside a string\n   spaced   \n"""/);
  assert.equal(runPython(result.code), runPython(code));
});

test('python: unused imports respect __all__, noqa, re-exports and string usage', py, async () => {
  const a = await simplifyPython("import os\nimport sys\n__all__ = ['os']\nprint(1)\n");
  assert.match(a.code, /import os/);                      // module declares __all__: keep everything
  const b = await simplifyPython("import os  # noqa\nprint(1)\n");
  assert.match(b.code, /import os/);
  const c = await simplifyPython("from typing import List as List\nprint(1)\n");
  assert.match(c.code, /List as List/);                   // explicit re-export
  const d = await simplifyPython("import re\nx: 're.Pattern' = None\nprint(x)\n");
  assert.match(d.code, /import re/);                      // used inside a string annotation
  const e = await simplifyPython("from os import path, sep\nprint(sep)\n");
  assert.match(e.code, /^from os import sep\n/);          // partial removal keeps the rest
});

test('python: unused locals are kept when locals()/eval could read them or they are used later', py, async () => {
  const a = await simplifyPython("def f():\n    x = 1\n    return locals()\nprint(f())\n");
  assert.match(a.code, /x = 1/);
  const b = await simplifyPython("def f():\n    x = 1\n    def g():\n        return x\n    return g()\nprint(f())\n");
  assert.match(b.code, /x = 1/);
  const c = await simplifyPython("def f():\n    x = 1\n    y = 2\n    return 0\nprint(f())\n");
  assert.doesNotMatch(c.code, /x = 1|y = 2/);
  assert.match(c.code, /return 0/);                       // block never left empty
});

test('python: decorated function after return is removed with its decorator', py, async () => {
  const code = 'def f():\n    return 1\n\n    @staticmethod\n    def g():\n        pass\n\nprint(f())\n';
  const { code: out } = await simplifyPython(code);
  assert.doesNotMatch(out, /staticmethod|def g/);
  assert.equal(runPython(out), '1\n');
});

test('python: invalid Python reports an error instead of guessing', py, async () => {
  const result = await simplifyPython('def f(:\n');
  assert.equal(result.ok, false);
  assert.match(result.error, /not valid Python 3/);
});

test('python: unicode and Windows line endings survive', py, async () => {
  const code = "def f():\r\n    s = 'héllo ✓'\r\n    t = 0\r\n    t = t + 1\r\n    return s, t\r\nprint(f())\r\n";
  const result = await simplifyPython(code);
  assert.match(result.code, /héllo ✓/);
  assert.match(result.code, /t \+= 1/);
  assert.equal(runPython(result.code), runPython(code.replace(/\r\n/g, '\n')));
});

// ------------------------------------------------------------------------------ JavaScript
test('javascript: behaviour is identical before and after (end-to-end run)', () => {
  const program = `
function classify(n) {
  if (n < 0) { return 'neg'; } else { if (n === 0) { return 'zero'; } else { return 'pos'; } }
  console.log('unreachable');
}
function total(items) {
  let t = 0;
  const unused = 5;
  for (const i of items) { t = t + i * 2; }
  ;
  if (!!t) { return t; } else { return -1; }
  return;
}
function build(n) { var s = ''; for (var i = 0; i < n; i++) { s = s + i; } return s; }
function mix(a, b) { let x = a; x = x * (a + b); x = x - (b - a); return x; }
console.log(classify(-1), classify(0), classify(5), total([1, 2, 3]), total([]), build(4), mix(2, 3));
`;
  const result = simplifyJavaScript(program);
  assert.equal(runJs(result.code), runJs(program));
  assert.equal(runJs(program), 'neg zero pos 12 -1 0123 9');
  const r = rules(result.changes);
  assert.ok(r.unreachable >= 1 && r.augassign >= 3 && r.unused_local === 1 && r.double_negation === 1 && r.empty_statement === 1);
  assert.doesNotMatch(result.code, /unused|unreachable/);
});

test('javascript: augmented assignment only when exactly equivalent', () => {
  const { code } = simplifyJavaScript(
    'let x = 1, y = 2, z = 3, a = 4, b = 5;\nx = x + y;\ny = y * z + 1;\nz = z + (a, b);\nconsole.log(x, y, z);\n'
  );
  assert.match(code, /x \+= y/);
  assert.match(code, /y = y \* z \+ 1/);     // (y*z)+1 is not y *= z+1
  assert.match(code, /z = z \+ \(a, b\)/);   // sequence expression: leave alone
});

test('javascript: else is not flattened when it declares let/const, and else-if is merged', () => {
  const a = simplifyJavaScript('function f(x) {\n  if (x) { return 1; } else { const y = 2; return y; }\n}\n');
  assert.match(a.code, /else/);
  const b = simplifyJavaScript('function f(x) {\n  if (x > 1) { console.log(1); } else { if (x > 0) { console.log(2); } }\n}\n');
  assert.match(b.code, /else if \(x > 0\)/);
});

test('javascript: unused imports and requires are removed, used ones kept', () => {
  const a = simplifyJavaScript("import fs from 'fs';\nimport { a, b as c } from './x.js';\nimport * as ns from 'ns';\nconsole.log(a, ns);\n");
  assert.doesNotMatch(a.code, /\bfs\b|b as c/);
  assert.match(a.code, /import \{ a \} from '\.\/x\.js';/);
  assert.match(a.code, /import \* as ns from 'ns';/);
  const b = simplifyJavaScript("const fs = require('fs');\nconst path = require('path');\nconsole.log(path.sep);\n");
  assert.doesNotMatch(b.code, /fs/);
  assert.match(b.code, /require\('path'\)/);
});

test('javascript: a local is kept when used in a nested function or as an object shorthand', () => {
  const a = simplifyJavaScript('function f() {\n  const k = 3;\n  return () => k;\n}\nconsole.log(f()());\n');
  assert.match(a.code, /const k = 3/);
  const b = simplifyJavaScript('function f() {\n  const k = 3;\n  return { k };\n}\nconsole.log(f().k);\n');
  assert.match(b.code, /const k = 3/);
  const c = simplifyJavaScript('function f() {\n  const k = 3;\n  return { k: 1 };\n}\nconsole.log(f().k);\n'); // `k:` is a key, not a use
  assert.doesNotMatch(c.code, /const k/);
});

test('javascript: comments — JSDoc, why-comments, hashbang and in-string text are kept', () => {
  const code = [
    '#!/usr/bin/env node',
    '// adds numbers',
    '/** Adds two numbers. */',
    'function add(a, b) {',
    '  // plain remark',
    '  return a + b; // trailing remark',
    '}',
    '// because the legacy API wants strings',
    "const s = '// not a comment';",
    'const t = `/* also not */ ${add(1, 2)}`;',
    'const u = add(/* inline */ 1, 2);',
    'console.log(s, t, u);',
    '',
  ].join('\n');
  const { code: out } = simplifyJavaScript(code);
  assert.match(out, /^#!\/usr\/bin\/env node/);
  assert.match(out, /\/\*\* Adds two numbers\. \*\//);
  assert.match(out, /because the legacy API/);
  assert.match(out, /'\/\/ not a comment'/);
  assert.match(out, /`\/\* also not \*\/ \$\{add\(1, 2\)\}`/);
  assert.match(out, /\/\* inline \*\//);
  assert.doesNotMatch(out, /adds numbers|plain remark|trailing remark/);
});

test('javascript: modules, scripts and Windows line endings all parse', () => {
  assert.ok(simplifyJavaScript("export const a = 1;\nawait Promise.resolve();\n").code.includes('export const a'));
  assert.ok(simplifyJavaScript("var a = 1;\r\nwith_ = a;\r\n").code.includes('var a'));
  assert.ok(simplifyJavaScript('return 5;\n').code.includes('return 5')); // top-level return (CommonJS wrappers)
});

test('javascript: unreachable code keeps hoisted function declarations', () => {
  const { code } = simplifyJavaScript('function f() {\n  return g();\n  console.log(1);\n  function g() { return 2; }\n}\nconsole.log(f());\n');
  assert.match(code, /function g\(\)/);
  assert.doesNotMatch(code, /console\.log\(1\)/);
});

// ------------------------------------------------------------------------------ dispatcher
test('engine: TypeScript, invalid code and other languages fall back to basic cleanup with an honest note', async () => {
  const ts = await simplifyRuleBased({ code: 'const a: number = 1;\n// hi\n', language: 'typescript' });
  assert.equal(ts.engine, 'basic');
  assert.match(ts.notes, /TypeScript/);
  assert.doesNotMatch(ts.code, /hi/);
  const bad = await simplifyRuleBased({ code: 'function (', language: 'javascript' });
  assert.equal(bad.engine, 'basic');
  const go = await simplifyRuleBased({ code: '// hi\nfunc main() {}\n', language: 'go' });
  assert.equal(go.engine, 'basic');
  assert.match(go.notes, /does not cover go/);
});

test('engine: says so when there is nothing to simplify', async () => {
  const r = await simplifyRuleBased({ code: 'function f(x) {\n  return x + 1;\n}\n', language: 'javascript' });
  assert.equal(r.engine, 'rules');
  assert.match(r.notes, /Nothing could be simplified safely/);
});

test('engine: idempotent (running it on its own output changes nothing)', async () => {
  const first = simplifyJavaScript('function f(x) {\n  let t = 0;\n  t = t + x;\n  // why: because\n  return t;\n  return 1;\n}\n');
  const second = simplifyJavaScript(first.code);
  assert.equal(second.code, first.code);
  assert.deepEqual(second.changes, []);
});
