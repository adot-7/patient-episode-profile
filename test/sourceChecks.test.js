import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceClaimIssues, sourceAvailability } from '../server/sourceChecks.js';

const patient = {
  episode: { id: '2-new', startDate: '2026-11-02', visitType: 'outpatient', dateTo: '2026-11-04' },
  diagnoses: [], notes: [],
  problems: [{ problem: 'Essential', status: 'ACTIVE', dateOnset: '28 SEP 2026' }, { problem: 'Essential (primary) hypertension (I10)', status: 'INACTIVE', dateOnset: '13 JUL 2026' }],
  medications: [{ medication: 'AMARYL 1MG TAB', status: 'PENDING', startDate: '03 NOV 2026 16:12' }],
  vitals: [{ dateTime: '03 JUL 2026', measurements: [{ name: 'BLOOD PRESSURE', value: '90/60', unit: 'mmHg' }] }, { dateTime: '16 JUL 2026', measurements: [{ name: 'BLOOD PRESSURE', value: '220/90', unit: 'mmHg' }] }],
};
const issues = (title, item) => sourceClaimIssues([{ title, items: [item] }], [patient]);

test('source checks distinguish an ambiguous active label from inactive hypertension', () => {
  assert.ok(issues('Overall clinical story', 'Active conditions include essential hypertension.').length > 0);
  assert.deepEqual(issues('Diagnoses and Problems', 'Essential hypertension (INACTIVE); Essential (ACTIVE).'), []);
});

test('source checks reject onset/status confusion, wrong drug dates, and wrong order statuses', () => {
  assert.ok(issues('Monitoring considerations', 'Coronary artery disease active since 2026-09-28.').length > 0);
  assert.ok(issues('Dated clinical timeline', '2026-11-02: AMARYL PENDING order.').length > 0);
  assert.ok(issues('Key Medications', '2026-11-03: AMARYL ACTIVE.').length > 0);
  assert.deepEqual(issues('Key Medications', '2026-11-03 16:12: AMARYL 1MG TAB, PENDING order.'), []);
  assert.deepEqual(issues('Key Medications', 'AMARYL 1MG TAB: start 03 NOV 2026 16:12, PENDING.'), []);
  assert.ok(issues('Key Medications', 'AMARYL 1MG TAB: start 02 NOV 2026 16:12, PENDING.').length > 0);
});

test('an episode ID containing a generic fixture word is not mistaken for a medication reference', () => {
  const fixture = { episode: { id: 'FIXTURE-2', startDate: '2026-07-03' }, medications: [{ medication: 'Fixture medicine', startDate: '2026-07-01', status: 'PENDING' }] };
  assert.deepEqual(sourceClaimIssues([{ title: 'Dated clinical timeline', items: ['2026-07-03 · episode FIXTURE-2: outpatient episode recorded.'] }], [fixture]), []);
});

test('source checks reject invented primary diagnoses, lab values, BP values and scope-boundary events', () => {
  assert.ok(issues('Diagnoses and Problems', 'Primary diagnosis: hypertension.').length > 0);
  assert.ok(issues('Investigations', 'Platelets: 120000 /uL.').length > 0);
  assert.ok(issues('Condition and investigation trends', 'Blood pressure 110/80 mmHg.').length > 0);
  assert.ok(issues('Dated clinical timeline', '2026-11-04: Episode ended.').length > 0);
  assert.deepEqual(issues('Dated clinical timeline', '2026-11-02: Outpatient episode recorded.'), []);
});

test('availability metadata provides computed BP limits and keeps primary-diagnosis absence explicit', () => {
  const metadata = sourceAvailability([patient]);
  assert.deepEqual(metadata.episodes[0].primaryDiagnoses, []);
  assert.equal(metadata.observedNumericVitalRanges.find((item) => item.name === 'Systolic blood pressure').minimum, 90);
  assert.equal(metadata.observedNumericVitalRanges.find((item) => item.name === 'Systolic blood pressure').maximum, 220);
});

test('complaint remarks and vital date ranges cannot be borrowed from unrelated events', () => {
  const source = { ...patient, complaints: [{ name: 'Abdominal pain', date: '2026-07-09', remark: 'Patient looks pale and dehydrated.' }] };
  const bad = [{ title: 'Presentation', items: ['2026-03-25: Fever; patient looks pale and dehydrated.'] }, { title: 'Hospital Course', items: ['Vitals recorded between 2026-07-03 and 2026-10-29.'] }];
  assert.equal(sourceClaimIssues(bad, [source]).length, 2);
  assert.deepEqual(sourceClaimIssues([{ title: 'Presentation', items: ['2026-07-09: Abdominal pain; patient looks pale and dehydrated.'] }], [source]), []);
  assert.deepEqual(sourceClaimIssues([{ title: 'Investigations', items: ['2026-11-02: No vitals recorded.'] }], [source]), []);
  assert.ok(sourceClaimIssues([{ title: 'Monitoring considerations', items: ['Essential: active problem status noted on 2026-09-28.'] }], [source]).length > 0);
});
