import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { generateEpisodeSummary } from '../server/ai.js';
import { buildLocalEvidence } from '../server/localEvidence.js';

const originalFetch = globalThis.fetch;
const envKeys = ['AI_PROVIDER', 'AI_CACHE_MS', 'OLLAMA_MODEL', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_MODEL', 'GEMINI_REASONING_EFFORT', 'GEMINI_LOCAL_FALLBACK', 'GEMINI_FACTS_FALLBACK'];
let saved;
const headings = ['Presentation', 'Hospital Course', 'Diagnoses and Problems', 'Key Medications', 'Investigations', 'Follow-up / Open Items'];
const patient = {
  episodeId: 'test-local-1',
  episode: { id: 'test-local-1', startDate: '2026-11-02', visitType: 'outpatient' },
  complaints: [],
  problems: [{ problem: 'Coronary artery disease', status: 'ACTIVE', dateOnset: '2026-09-28' }],
  medications: [{ medication: 'Recorded medicine', startDate: '2026-11-03 16:12', status: 'PENDING', schedule: 'BID' }],
  allergies: { items: [{ allergy: 'Recorded allergen', symptoms: 'AGITATION' }] },
};

function selections(schema) {
  return { sections: Object.fromEntries(Object.entries(schema.properties.sections.properties).map(([title, section]) => [title,
    Object.fromEntries(Object.entries(section.properties).map(([slot, property], index) => [slot, index === 0 ? property.enum.find(Boolean) || '' : ''])),
  ])) };
}

function localResponse(body) {
  return { ok: true, json: async () => ({ done: true, done_reason: 'stop', message: { content: JSON.stringify(selections(body.format)) } }) };
}

beforeEach(() => {
  saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.AI_PROVIDER = 'ollama';
  process.env.AI_CACHE_MS = '0';
  process.env.OLLAMA_MODEL = 'qwen2.5:7b';
  process.env.GEMINI_MODEL = 'gemini-3.5-flash-lite';
  delete process.env.GEMINI_REASONING_EFFORT;
  process.env.GEMINI_LOCAL_FALLBACK = 'false';
  process.env.GEMINI_FACTS_FALLBACK = 'false';
  globalThis.fetch = async () => { throw new Error('Unexpected network request in provider test.'); };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

test('local mode calls only Ollama and renders source facts with the original dates', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'qwen2.5:7b');
    assert.equal(body.stream, false);
    assert.equal(body.options.temperature, 0);
    return localResponse(body);
  };
  const result = await generateEpisodeSummary(patient);
  assert.equal(result.provider, 'ollama');
  assert.equal(result.summaryMode, 'evidence-selection');
  assert.equal(result.sections[0].items[0], 'Not recorded in supplied records.');
  assert.match(result.summary, /2026-11-03 16:12.*Recorded medicine/);
  assert.doesNotMatch(result.summary, /chest pain|AGITATION|Admitted for evaluation/);
  assert.equal(calls.length, 1);
});

test('local evidence validation rejects invented text and a problem misclassified as presentation', () => {
  const packet = buildLocalEvidence([patient], headings);
  const output = selections(packet.schema);
  output.sections.Presentation.item1 = 'Patient presented with chest pain.';
  assert.throws(() => packet.render(JSON.stringify(output)), /unsupported evidence/);
  output.sections.Presentation.item1 = output.sections['Diagnoses and Problems'].item1;
  assert.throws(() => packet.render(JSON.stringify(output)), /unsupported evidence/);
});

test('local inference is serialized even when separate requests arrive together', async () => {
  let active = 0;
  let maximum = 0;
  globalThis.fetch = async (_url, options) => {
    active += 1;
    maximum = Math.max(active, maximum);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return localResponse(JSON.parse(options.body));
  };
  await Promise.all([generateEpisodeSummary(patient), generateEpisodeSummary({ ...patient, episodeId: 'second-local-test' })]);
  assert.equal(maximum, 1);
});

test('successful summaries are deduplicated, cached, and refreshed by Regenerate', async () => {
  process.env.AI_CACHE_MS = '30000';
  let calls = 0;
  globalThis.fetch = async (_url, options) => { calls += 1; return localResponse(JSON.parse(options.body)); };
  const source = { ...patient, episodeId: 'cache-local-test' };
  await Promise.all([generateEpisodeSummary(source), generateEpisodeSummary(source), generateEpisodeSummary(source)]);
  assert.equal(calls, 1);
  await generateEpisodeSummary(source);
  assert.equal(calls, 1);
  await generateEpisodeSummary(source, { regenerate: true });
  assert.equal(calls, 2);
  await generateEpisodeSummary({ ...source, complaints: [{ name: 'New recorded complaint', date: '2026-11-04' }] });
  assert.equal(calls, 3);
});

test('Gemini mode sends structured output to Google and never invokes a paid fallback', async () => {
  process.env.AI_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'fixture-google-key';
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer fixture-google-key');
    const body = JSON.parse(options.body);
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.reasoning_effort, 'minimal');
    const content = { sections: Object.fromEntries(headings.map((title) => [title, { item1: 'Not recorded in supplied records.', item2: '' }])) };
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }) };
  };
  const result = await generateEpisodeSummary(patient);
  assert.equal(result.provider, 'gemini');
  assert.equal(result.sections.length, 6);
  assert.equal(calls, 1);
  globalThis.fetch = async () => { calls += 1; return { ok: false, status: 429 }; };
  await assert.rejects(generateEpisodeSummary(patient), /quota exceeded/);
  assert.equal(calls, 2);
});

test('Gemini selection without a key fails clearly without contacting any provider', async () => {
  process.env.AI_PROVIDER = 'gemini';
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  await assert.rejects(generateEpisodeSummary(patient), (error) => error.status === 503 && /set GEMINI_API_KEY/.test(error.message));
});

test('Gemini Flash uses supported thinking effort and exposes array-shaped Google errors', async () => {
  process.env.AI_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'fixture-google-key';
  process.env.GEMINI_MODEL = 'gemini-3.8-flash';
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).reasoning_effort, 'low');
    return { ok: false, status: 400, json: async () => [{ error: { message: 'Example unsupported option' } }] };
  };
  await assert.rejects(generateEpisodeSummary(patient), /Example unsupported option/);
});

test('Gemini corrects a source-date error once using the same provider', async () => {
  process.env.AI_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'fixture-google-key';
  let calls = 0;
  const source = { ...patient, medications: [{ medication: 'AMARYL 1MG TAB', status: 'PENDING', startDate: '2026-11-03 16:12' }] };
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).includes('googleapis.com'));
    calls += 1;
    const body = JSON.parse(options.body);
    if (calls === 2) assert.match(body.messages[1].content, /Source-check feedback/);
    const content = { sections: Object.fromEntries(headings.map((title) => [title, { item1: title === 'Key Medications' ? `${calls === 1 ? '2026-11-02' : '2026-11-03'}: AMARYL 1MG TAB, PENDING order.` : 'Not recorded in supplied records.', item2: '' }])) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
  };
  const result = await generateEpisodeSummary(source);
  assert.equal(calls, 2);
  assert.match(result.sections.find((item) => item.title === 'Key Medications').items[0], /^2026-11-03/);
});

test('optional Gemini outage fallback uses only local evidence and identifies the provider change', async () => {
  process.env.AI_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'fixture-google-key';
  process.env.GEMINI_LOCAL_FALLBACK = 'true';
  const urls = [];
  globalThis.fetch = async (url, options) => {
    urls.push(String(url));
    if (String(url).includes('googleapis.com')) return { ok: false, status: 503, json: async () => ({ error: { message: 'High demand' } }) };
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    return localResponse(JSON.parse(options.body));
  };
  const result = await generateEpisodeSummary(patient);
  assert.equal(result.provider, 'ollama');
  assert.equal(result.summaryMode, 'evidence-selection');
  assert.deepEqual(result.fallback, { from: 'gemini', reason: 'provider was unavailable' });
  assert.equal(urls.length, 2);
});

test('repeated unsupported Gemini claims fall back locally rather than reaching the rendered summary', async () => {
  process.env.AI_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'fixture-google-key';
  process.env.GEMINI_LOCAL_FALLBACK = 'true';
  const source = { ...patient, medications: [{ medication: 'AMARYL 1MG TAB', status: 'PENDING', startDate: '2026-11-03 16:12' }] };
  let cloudCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('11434')) return localResponse(JSON.parse(options.body));
    assert.ok(String(url).includes('googleapis.com'));
    cloudCalls += 1;
    const content = { sections: Object.fromEntries(headings.map((title) => [title, { item1: title === 'Key Medications' ? '2026-11-02: AMARYL PENDING.' : 'Not recorded in supplied records.', item2: '' }])) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
  };
  const result = await generateEpisodeSummary(source);
  assert.equal(cloudCalls, 2);
  assert.equal(result.provider, 'ollama');
  assert.equal(result.fallback.reason, 'source check rejected the narrative');
  assert.match(result.sections.find((item) => item.title === 'Key Medications').items[0], /^2026-11-03/);
});

test('hosted facts fallback needs neither paid credits nor an Ollama server and is not labelled AI', async () => {
  process.env.AI_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'fixture-google-key';
  process.env.GEMINI_FACTS_FALLBACK = 'true';
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    assert.ok(String(url).includes('googleapis.com'));
    return { ok: false, status: 503, json: async () => ({ error: { message: 'High demand' } }) };
  };
  const result = await generateEpisodeSummary(patient);
  assert.equal(calls, 1);
  assert.equal(result.provider, 'recorded');
  assert.equal(result.summaryMode, 'recorded-facts');
  assert.equal(result.sections.length, 6);
  assert.match(result.summary, /2026-11-03 16:12.*Recorded medicine/);
  assert.equal(result.sections[0].items[0], 'Not recorded in supplied records.');
});

test('hosted facts remain available if an optional local inference service cannot be reached', async () => {
  process.env.AI_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'fixture-google-key';
  process.env.GEMINI_LOCAL_FALLBACK = 'true';
  process.env.GEMINI_FACTS_FALLBACK = 'true';
  globalThis.fetch = async (url) => {
    if (String(url).includes('11434')) throw new Error('Local inference unreachable');
    assert.ok(String(url).includes('googleapis.com'));
    return { ok: false, status: 503 };
  };
  assert.equal((await generateEpisodeSummary(patient)).provider, 'recorded');
});
