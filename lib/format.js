'use strict';
/**
 * format.js — runs Prettier over the model's output for languages it supports.
 *
 * Why: the AI is good at logic but inconsistent about whitespace. A formatter
 * guarantees tidy, predictable layout. If formatting fails (e.g. the model
 * produced invalid syntax), we return the code unchanged rather than erroring.
 */

const prettier = require('prettier');

// Our language names -> Prettier parser names.
const PARSERS = {
  javascript: 'babel',
  typescript: 'typescript',
  json: 'json',
  css: 'css',
  html: 'html',
};

async function formatCode(code, language) {
  const parser = PARSERS[language];
  if (!parser) return code;
  try {
    return await prettier.format(code, { parser, singleQuote: true, printWidth: 80 });
  } catch {
    return code;
  }
}

module.exports = { formatCode };
