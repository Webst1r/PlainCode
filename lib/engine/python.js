'use strict';
/**
 * python.js — runs py_simplify.py in a separate python3 process.
 *
 * Why a separate process? Python's own `ast` module is the most reliable way to
 * understand Python code. We send the code in over stdin and read JSON back.
 * The script only PARSES the code; it never executes it.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'py_simplify.py');
const PYTHON = process.env.PYTHON_BIN || 'python3';

function simplifyPython(code, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    // -I = isolated mode: ignore PYTHON* env vars and the current directory.
    const child = spawn(PYTHON, ['-I', SCRIPT], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH },
      windowsHide: true,
    });

    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 2_000_000) child.kill('SIGKILL'); // runaway output guard
    });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Python 3 is not available on this server')); });
    child.on('close', () => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('Python engine timed out'));
      try { resolve(JSON.parse(output)); } catch { reject(new Error('Python engine returned unreadable output')); }
    });
    child.stdin.on('error', () => {}); // ignore EPIPE if the child exits early
    child.stdin.end(JSON.stringify({ code }));
  });
}

module.exports = { simplifyPython };
