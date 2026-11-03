import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

process.env.BHARATCODE_API_KEY = 'test-key';
process.env.BHARATCODE_MODEL = 'qwen-3.8-27b';

const { generateEpisodeSummary } = await import('../server/ai.js');
const originalFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://bharatcode.ai/api/model/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'qwen-3.8-27b');
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.match(body.messages[0].content, /Never fabricate/);
    assert.doesNotMatch(body.messages[1].content, /22 Jun 2026/);
    assert.match(body.messages[1].content, /03 JUN 2026/);
    assert.ok(body.messages[1].content.length < 70000);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'Presentation\n* Recorded episode facts.' } }] }),
    };
  };
});

after(() => {
  globalThis.fetch = originalFetch;
});

test('BharatCode summary request is bounded and episode-scoped', async () => {
  const result = await generateEpisodeSummary({
    episode: { id: '1-19337733', label: '03 JUN 2026 - PPG-EMERGENCY MEDICINE' },
    demographics: { age: '52', sex: 'M', admitDate: '22 Jun 2026', ward: 'Current ward' },
    diagnoses: [{ diagnosis: 'Recorded diagnosis', isPrimary: true }],
    problems: [],
    complaints: [],
    allergies: { items: [] },
    medications: [],
    labOrders: [],
    radOrders: [],
    vitals: [],
    notes: [{ title: 'Progress note', content: ['recorded '.repeat(100000)] }],
  });

  assert.equal(result.model, 'qwen-3.8-27b');
  assert.equal(result.summary, 'Presentation\n* Recorded episode facts.');
});
