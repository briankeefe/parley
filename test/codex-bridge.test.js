import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../tools/codex-summarizer/server.mjs';
import { childFailure } from '../tools/codex-summarizer/errors.mjs';
import { OpenAISummarizer } from '../src/adapters/summarizer/openai.js';

test('OpenAI adapter does not retry an invalidated subscription authorization', async t => {
  let calls = 0;
  const key = 'test-only-bridge-credential-000000000000';
  const server = createBridge({ key, run: async () => {
    calls++;
    throw childFailure('No API key found for openai-codex.', {});
  }});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const adapter = new OpenAISummarizer('gpt-6.1-sol', `http://127.0.0.1:${server.address().port}/v1`, key);
  await assert.rejects(adapter.summarize('Synthetic boundary transcript.', { attendees: [], summaryLanguage: 'en' }), error =>
    error.status === 424 && error.message.includes('Dedicated subscription login required'));
  assert.equal(calls, 1);
});
