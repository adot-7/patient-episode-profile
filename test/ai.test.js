import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

process.env.BHARATCODE_API_KEY = 'test-key';
process.env.BHARATCODE_MODEL = 'qwen-3.8-27b';
process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
const originalMode = process.env.AI_PROVIDER;
const originalCache = process.env.AI_CACHE_MS;
process.env.AI_PROVIDER = 'auto';
process.env.AI_CACHE_MS = '0';
delete process.env.ANTHROPIC_API_KEY;

const { generateEpisodeSummary, generateLongitudinalSummary, formatStructuredSummary } = await import('../server/ai.js');
const originalFetch = globalThis.fetch;
const episodeHeadings = ['Presentation', 'Hospital Course', 'Diagnoses and Problems', 'Key Medications', 'Investigations', 'Follow-up / Open Items'];
const longitudinalHeadings = ['Overall clinical story', 'Dated clinical timeline', 'Condition and investigation trends', 'Medication course', 'Recorded background', 'Monitoring considerations'];
function structuredResponse(headings, firstText) {
  return JSON.stringify({ sections: headings.map((title, index) => ({ title, items: [index === 0 ? firstText : 'Not recorded in supplied records.'] })) });
}

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
      json: async () => ({ choices: [{ message: { content: structuredResponse(episodeHeadings, 'Recorded episode facts.') } }] }),
    };
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  if (originalMode === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = originalMode;
  if (originalCache === undefined) delete process.env.AI_CACHE_MS;
  else process.env.AI_CACHE_MS = originalCache;
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
  assert.match(result.summary, /^Presentation\n- Recorded episode facts\./);
  assert.equal(result.sections.length, 6);
});

test('falls back to Anthropic Haiku when BharatCode fails', async () => {
  process.env.ANTHROPIC_API_KEY = 'anthropic-test-key';
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('bharatcode.ai')) {
      return { ok: false, status: 503, text: async () => 'provider unavailable' };
    }
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(options.headers['x-api-key'], 'anthropic-test-key');
    assert.equal(options.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'claude-haiku-4-5-20251001');
    assert.equal(body.max_tokens, 1800);
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.equal(body.output_config.format.schema.properties.sections.required.length, 6);
    assert.equal(body.output_config.format.schema.properties.sections.properties.Presentation.properties.item1.pattern, '^.{1,220}$');
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: structuredResponse(episodeHeadings, 'Anthropic fallback facts.') }] }),
    };
  };

  const result = await generateEpisodeSummary({ episode: { id: '2-3' }, demographics: {}, notes: [] });

  assert.equal(calls.length, 2);
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.model, 'claude-haiku-4-5-20251001');
  assert.match(result.summary, /^Presentation\n- Anthropic fallback facts\./);
});

test('longitudinal AI uses chronological source evidence and limits monitoring to supported considerations', async () => {
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.messages[1].content;
    assert.equal(body.max_tokens, 2400);
    assert.ok(prompt.indexOf('earlier-episode') < prompt.indexOf('later-episode'));
    assert.match(prompt, /do not predict|Do not predict/);
    assert.match(prompt, /not a count\/list/);
    assert.match(prompt, /Former smoker/);
    assert.match(prompt, /Platelets/);
    assert.match(prompt, /No lab values|no lab values/i);
    assert.ok(prompt.length < 140000);
    return { ok: true, json: async () => ({ choices: [{ message: { content: structuredResponse(longitudinalHeadings, 'Connected recorded story.') } }] }) };
  };
  const result = await generateLongitudinalSummary([
    { episode: { id: 'later-episode', startDate: '2026-02-01' }, notes: [{ content: ['x'.repeat(100000)] }] },
    { episode: { id: 'earlier-episode', startDate: '2025-01-01' }, backgroundHistory: [{ value: 'Former smoker' }], labOrders: [{ name: 'CBC', results: [{ name: 'Platelets', value: '80', unit: '10^9/L', dateTime: '2025-01-01' }] }] },
  ]);
  assert.equal(result.episodeCount, 2);
  assert.match(result.summary, /Connected recorded story/);
});

test('both provider failures produce an actionable error without a fabricated summary', async () => {
  process.env.ANTHROPIC_API_KEY = 'invalid-key';
  globalThis.fetch = async (url) => ({ ok: false, status: String(url).includes('anthropic') ? 401 : 503, text: async () => 'provider unavailable' });
  await assert.rejects(generateLongitudinalSummary([{ episode: { id: '1-1' } }]), (error) => error.status === 502 && /Anthropic authentication failed/.test(error.message));
});

test('structured summaries reject missing final sections and sort dated timeline items', () => {
  const parsed = JSON.parse(structuredResponse(longitudinalHeadings, 'Recorded story.'));
  parsed.sections[1].items = ['2026-11-02: Later recorded episode.', '2026-03-23: Earlier recorded episode.'];
  const result = formatStructuredSummary(JSON.stringify(parsed), longitudinalHeadings);
  assert.match(result.sections[1].items[0], /^2026-03-23/);
  assert.equal(result.sections.at(-1).title, 'Monitoring considerations');
  parsed.sections.pop();
  assert.throws(() => formatStructuredSummary(JSON.stringify(parsed), longitudinalHeadings), /missing required/);
  assert.throws(() => formatStructuredSummary('{"sections":[', longitudinalHeadings), /incomplete or invalid/);
});

test('truncated provider output falls back instead of becoming a ready summary', async () => {
  process.env.ANTHROPIC_API_KEY = 'fixture-anthropic-key';
  globalThis.fetch = async (url) => ({ ok: true, json: async () => String(url).includes('anthropic')
    ? { stop_reason: 'end_turn', content: [{ type: 'text', text: structuredResponse(episodeHeadings, 'Complete fallback.') }] }
    : { choices: [{ finish_reason: 'length', message: { content: 'Presentation only, cut off' } }] } });
  const result = await generateEpisodeSummary({ episode: { id: '1-1' } });
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.sections.at(-1).title, 'Follow-up / Open Items');
});

test('fixed-slot output normalizes into complete sections and rejects JSON null', () => {
  const content = { sections: Object.fromEntries(episodeHeadings.map((title) => [title, { item1: 'Not recorded in supplied records.', item2: '' }])) };
  const result = formatStructuredSummary(JSON.stringify(content), episodeHeadings);
  assert.equal(result.sections.length, 6);
  assert.ok(result.sections.every((section) => section.items.length === 1));
  assert.throws(() => formatStructuredSummary('null', episodeHeadings), /missing required/);
});

test('Anthropic billing failure is distinguishable from an invalid API key', async () => {
  process.env.ANTHROPIC_API_KEY = 'fixture-key';
  globalThis.fetch = async (url) => ({ ok: false, status: String(url).includes('anthropic') ? 400 : 503, text: async () => String(url).includes('anthropic') ? 'Your credit balance is too low to access the Anthropic API.' : 'Model unavailable' });
  await assert.rejects(generateEpisodeSummary({ episode: { id: '1-1' } }), (error) => /Anthropic has insufficient API credits/.test(error.message) && !/authentication failed/.test(error.message));
});
