// Optional, bounded live audit. Not included in `npm test`; run with an explicit provider.
// Example: node test/liveModels.js --provider=gemini --source=/tmp/opencode/model-source.json --out=/tmp/opencode/gemini-audit.json
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { loadServerEnvironment } from '../server/environment.js';

loadServerEnvironment();
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const separator = arg.indexOf('=');
  return [arg.slice(2, separator), arg.slice(separator + 1)];
}));
const mode = args.provider;
assert.ok(['gemini', 'ollama', 'capture'].includes(mode), 'Use --provider=gemini, --provider=ollama, or --provider=capture');
process.env.AI_PROVIDER = mode;
process.env.AI_CACHE_MS = '0';
// Compare the requested model itself unless application fallback is explicitly part of the audit.
process.env.GEMINI_LOCAL_FALLBACK = args.fallback === 'true' ? 'true' : 'false';
if (args.model) process.env[mode === 'gemini' ? 'GEMINI_MODEL' : 'OLLAMA_MODEL'] = args.model;
const { generateEpisodeSummary, generateLongitudinalSummary } = await import('../server/ai.js');
const { sourceClaimIssues, datesFromText } = await import('../server/sourceChecks.js');

async function get(path) {
  const response = await fetch(`http://127.0.0.1:3002${path}`, { signal: AbortSignal.timeout(120000) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Source API returned ${response.status}`);
  return body;
}

let source;
if (mode === 'capture') {
  assert.ok(args.dfn && args.out, 'Capture requires --dfn=<patient> --out=<private JSON path>');
  const shell = await get(`/api/patients/${encodeURIComponent(args.dfn)}/shell`);
  const patients = [];
  for (const episode of shell.episodes || []) patients.push(await get(`/api/patients/${encodeURIComponent(args.dfn)}?episodeId=${encodeURIComponent(episode.id)}&includeNoteDetails=true`));
  source = { capturedAt: new Date().toISOString(), dfn: args.dfn, patients };
  await writeFile(args.out, JSON.stringify(source, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ capturedAt: source.capturedAt, episodes: patients.map((patient) => ({ id: patient.episodeId, diagnoses: patient.diagnoses.length, complaints: patient.complaints.length, medications: patient.medications.length, labs: patient.labOrders.length, resultValues: patient.labOrders.flatMap((order) => order.results || []).length, notes: patient.notes.length })) }));
  process.exit(0);
}
assert.ok(args.source && args.out, 'Audit requires --source=<captured JSON path> --out=<private report JSON path>');
source = JSON.parse(await readFile(args.source, 'utf8'));

function checksFor(result, patients, scope) {
  const checks = [];
  const add = (name, passed, detail = '') => checks.push({ name, passed: Boolean(passed), detail });
  const sections = result.sections || [];
  const text = result.summary || '';
  const section = (title) => sections.find((item) => item.title === title)?.items.join(' ') || '';
  add('all_six_sections', sections.length === 6);
  add('selected_provider_only', result.provider === mode || args.fallback === 'true' && result.provider === 'ollama' && result.fallback?.from === mode);
  const groundingIssues = sourceClaimIssues(sections, patients);
  add('dates_statuses_and_source_claims', groundingIssues.length === 0, groundingIssues.join(' '));
  add('no_markdown_artifacts', !/\*\*|^#{1,6}\s/m.test(text));
  add('no_unsupported_future_forecast', !/will develop|high risk of|likely to|probably/i.test(text));
  if (patients.every((patient) => !patient.notes?.length)) {
    add('no_invented_admission_or_recovery', !/was admitted|admitted for|was discharged|patient recovered|clinically improved|reactivated|decompensat/i.test(text));
  }
  const results = patients.flatMap((patient) => (patient.labOrders || []).flatMap((order) => order.results || []));
  if (!results.length) {
    add('no_invented_laboratory_values', !/(?:platelets?|haemoglobin|hemoglobin|HbA1c|creatinine)\s*(?:was|were|is|of|at|:|=)?\s*\d/i.test(text));
  }
  if (scope === 'episode' && !patients[0].complaints?.length && !patients[0].notes?.some((note) => note.content?.length)) {
    add('no_allergy_symptom_as_presentation', !/chest pain|agitation|anaphylaxis|fever|headache/i.test(section('Presentation')));
  }
  for (const patient of patients) {
    for (const medication of patient.medications || []) {
      if (!/AMARYL|GLYCOMET/.test(medication.medication)) continue;
      const matching = sections.flatMap((item) => item.items).filter((item) => item.includes(medication.medication));
      if (!matching.length) continue;
      const expected = /AMARYL/.test(medication.medication) ? ['2026-11-03', 'PENDING'] : ['2026-11-02', 'UNRELEASED'];
      add(`correct_${medication.medication.split(' ')[0]}_order_date_status`, matching.every((item) => datesFromText(item).includes(expected[0]) && item.includes(expected[1])), expected.join(' / '));
    }
  }
  if (scope === 'longitudinal') {
    const timeline = sections.find((item) => item.title === 'Dated clinical timeline')?.items || [];
    const dates = timeline.map((item) => item.match(/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?/)?.[0]).filter(Boolean);
    add('timeline_chronological', dates.every((date, index) => index === 0 || date >= dates[index - 1]));
    const starts = patients.map((patient) => patient.episode.startDate).filter(Boolean).sort();
    if (starts.length > 1) add('timeline_spans_earlier_and_latest_episode', dates.some((date) => date < starts.at(-1)) && dates.some((date) => date >= starts.at(-1)));
    if (patients.every((patient) => !patient.backgroundHistory?.length)) {
      add('missing_history_not_invented', /not recorded|not documented|not supplied|no .*supplied/i.test(section('Recorded background')));
    }
    add('monitoring_section_present', Boolean(section('Monitoring considerations')));
  }
  return checks;
}

const plateletFixture = [
  { episodeId: 'FIXTURE-1', episode: { id: 'FIXTURE-1', startDate: '2026-07-01', visitType: 'inpatient' }, demographics: { age: '40', sex: 'Male' }, diagnoses: [{ diagnosis: 'Dengue', isPrimary: true, dateEntered: '2026-07-01 09:00' }], complaints: [{ name: 'Fever', date: '2026-07-01 08:00' }], labOrders: [{ name: 'CBC', orderDateTime: '2026-07-01 09:10', results: [{ name: 'Platelets', value: '80000', unit: '/uL', dateTime: '2026-07-01 10:00' }, { name: 'Platelets', value: '60000', unit: '/uL', dateTime: '2026-07-02 10:00', flag: 'LOW' }] }], medications: [{ medication: 'Fixture medicine', status: 'PENDING', startDate: '2026-07-01 09:30' }], backgroundHistory: [], notes: [] },
  { episodeId: 'FIXTURE-2', episode: { id: 'FIXTURE-2', startDate: '2026-07-03', visitType: 'outpatient' }, demographics: { age: '40', sex: 'Male' }, diagnoses: [{ diagnosis: 'Dengue follow-up', dateEntered: '2026-07-03 09:00' }], labOrders: [{ name: 'CBC', orderDateTime: '2026-07-03 09:10', results: [{ name: 'Platelets', value: '120000', unit: '/uL', dateTime: '2026-07-03 10:00' }] }], medications: [], backgroundHistory: [], notes: [] },
];
const historyFixture = structuredClone(plateletFixture);
historyFixture[0].backgroundHistory = [
  { category: 'Social history', label: 'Smoking history', value: 'Former smoker; quit in 2020', date: '2026-07-01 08:30', noteTitle: 'Fixture admission note', episodeId: 'FIXTURE-1' },
  { category: 'Family history', label: 'Family history', value: 'Father: diabetes mellitus', date: '2026-07-01 08:30', noteTitle: 'Fixture admission note', episodeId: 'FIXTURE-1' },
];
const report = { provider: mode, sourceCapturedAt: source.capturedAt, startedAt: new Date().toISOString(), cases: [] };
const priorReport = args.review ? JSON.parse(await readFile(args.review, 'utf8')) : null;
if (priorReport) {
  assert.equal(priorReport.sourceCapturedAt, source.capturedAt, 'Review must use the identical captured source snapshot');
  report.reviewOf = args.review;
}
const cases = [
  ...source.patients.map((patient) => ({ name: `patient-episode-${patient.episodeId}`, scope: 'episode', patients: [patient] })),
  { name: 'patient-longitudinal', scope: 'longitudinal', patients: source.patients },
  { name: 'synthetic-platelet-trend', scope: 'longitudinal', patients: plateletFixture, synthetic: true },
  { name: 'synthetic-recorded-history', scope: 'longitudinal', patients: historyFixture, synthetic: true },
];
for (const item of cases.filter((item) => !args.case || new RegExp(args.case).test(item.name))) {
  const prior = priorReport?.cases.find((entry) => entry.name === item.name);
  if (priorReport && !prior) continue;
  const started = Date.now();
  let result;
  let error;
  if (prior) {
    result = prior.result;
    error = prior.error;
  } else {
    try {
      result = item.scope === 'episode' ? await generateEpisodeSummary(item.patients[0]) : await generateLongitudinalSummary(item.patients);
    } catch (failure) {
      error = failure.message;
    }
  }
  const checks = result ? checksFor(result, item.patients, item.scope) : [];
  if (result && item.synthetic) {
    const trend = result.sections.find((section) => section.title === 'Condition and investigation trends')?.items.join(' ').replace(/,/g, '') || '';
    checks.push({ name: 'serial_platelet_values_and_unit', passed: ['80000', '60000', '120000', '/uL'].every((value) => trend.includes(value)), detail: 'Explicit synthetic fixture, not a result from PAT123456.' });
  }
  if (result && item.name === 'synthetic-recorded-history') {
    const history = result.sections.find((section) => section.title === 'Recorded background')?.items.join(' ') || '';
    checks.push({ name: 'recorded_family_and_social_history', passed: /former smoker/i.test(history) && /2020/.test(history) && /father.*diabetes/i.test(history), detail: 'Explicit synthetic history; PAT123456 has no retrieved history notes.' });
  }
  const entry = { name: item.name, scope: item.scope, synthetic: Boolean(item.synthetic), elapsedMs: prior?.elapsedMs ?? Date.now() - started, result, error, checks };
  report.cases.push(entry);
  await writeFile(args.out, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ name: entry.name, provider: result?.provider, model: result?.model, elapsedMs: entry.elapsedMs, error, checks, summary: result?.summary }));
  if (error && /429|quota exceeded|authentication|API key|insufficient.*credits/i.test(error)) break;
}
report.finishedAt = new Date().toISOString();
await writeFile(args.out, JSON.stringify(report, null, 2), { mode: 0o600 });
if (report.cases.some((item) => item.error || item.checks.some((check) => !check.passed))) process.exitCode = 1;
