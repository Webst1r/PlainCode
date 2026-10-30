'use strict';
/**
 * llm.js — talks to the Anthropic Messages API and parses the reply.
 *
 * Uses Node's built-in fetch (no SDK needed), so you can see exactly what
 * goes over the wire: one POST request with a JSON body.
 */

const { buildSystemPrompt, buildUserPrompt } = require('./prompt');

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5-5';

/** Pull the text between <tag>...</tag>. Returns '' if the tag is missing. */
function extractTag(text, tag) {
  const match = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`));
  return match ? match[1] : '';
}

/** Models sometimes wrap code in ``` fences even when told not to. Strip them. */
function stripFences(code) {
  return code.replace(/^```[\w-]*\n/, '').replace(/\n```\s*$/, '');
}

/** Parse the model's reply into { code, notes }. Exported so it can be unit tested. */
function parseModelOutput(text) {
  return {
    code: stripFences(extractTag(text, 'code')),
    notes: extractTag(text, 'notes'),
  };
}

async function simplifyWithLLM({ code, language, mode, level }) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
      max_tokens: 4096,
      system: buildSystemPrompt({ mode, level, language }),
      messages: [{ role: 'user', content: buildUserPrompt(code) }],
    }),
    // Don't let a slow upstream hang our server forever.
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    // Log the detail server-side, but never leak it (or the API key) to the browser.
    const detail = await response.text().catch(() => '');
    console.error(`LLM error ${response.status}: ${detail.slice(0, 300)}`);
    throw new Error('The AI service is unavailable right now. Please try again.');
  }

  const data = await response.json();
  const text = (data.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const parsed = parseModelOutput(text);
  if (mode !== 'explain' && !parsed.code) {
    throw new Error('The AI reply could not be read. Please try again.');
  }
  return parsed;
}

module.exports = { simplifyWithLLM, parseModelOutput };
