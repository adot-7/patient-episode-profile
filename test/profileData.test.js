import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPatientProfile, episodeReport, episodeSnapshot, longitudinalSummary, metricSeries, chartPositions, chartLabelIndices, shortDate, shortTimestamp } from '../client/src/profileData.js';

test('longitudinal profile merges repeated conditions and medication courses while retaining episodes', () => {
  const profile = buildPatientProfile([
    { patient: {
      episodeId: '1-1', episode: { id: '1-1', startDate: '2025-01-01' },
      diagnoses: [{ diagnosis: 'Hypertension', isPrimary: true }],
      problems: [{ problem: 'Hypertension', status: 'ACTIVE' }],
      medications: [{ medication: 'Drug A', route: 'ORAL', status: 'ACTIVE', schedule: 'OD', startDate: '2025-01-01' }],
      vitals: [{ dateTime: '2025-01-01', measurements: [{ name: 'BLOOD PRESSURE', value: '140/90' }] }],
    } },
    { patient: {
      episodeId: '1-2', episode: { id: '1-2', startDate: '2026-01-01' },
      diagnoses: [{ diagnosis: 'Hypertension', isPrimary: false }],
      medications: [{ medication: 'Drug A', route: 'ORAL', status: 'DISCONTINUED', schedule: 'OD', startDate: '2025-01-01', stopDate: '2025-12-01' }],
      vitals: [{ dateTime: '2026-01-01', measurements: [{ name: 'BLOOD PRESSURE', value: '130/85' }] }],
    } },
  ]);

  assert.equal(profile.conditions.length, 1);
  assert.equal(profile.conditions[0].kind, 'Diagnosis and problem');
  assert.deepEqual(profile.conditions[0].episodes.map((episode) => episode.id), ['1-1', '1-2']);
  assert.deepEqual(profile.medications[0].statuses, ['ACTIVE', 'DISCONTINUED']);
  assert.equal(metricSeries(profile.vitalReadings, 'Systolic blood pressure').length, 2);
  assert.equal(metricSeries(profile.vitalReadings, 'Diastolic blood pressure')[1].value, 85);
});

test('vital metric series sorts Sansys day-month timestamps chronologically', () => {
  const profile = buildPatientProfile([{ patient: {
    episodeId: '2-3',
    vitals: [
      { dateTime: '23 Mar 2026 @ 21:24', measurements: [{ name: 'PULSE', value: '90' }] },
      { dateTime: '02 Jul 2026 @ 20:00', measurements: [{ name: 'PULSE', value: '80' }] },
    ],
  } }]);

  assert.deepEqual(metricSeries(profile.vitalReadings, 'Pulse').map((reading) => reading.value), [90, 80]);
});

test('chart positions reflect elapsed time and retain complete Sansys dates/times', () => {
  const positions = chartPositions([{ dateTime: '23 Mar 2026 @ 21:24' }, { dateTime: '02 Jul 2026 @ 20:00' }, { dateTime: '16 Jul 2026 @ 17:43' }]);
  assert.equal(positions[0], 0);
  assert.equal(positions[2], 1);
  assert.ok(positions[1] > 0.8, 'July must not be plotted halfway between March and July');
  assert.match(shortDate('16 Jul 2026 @ 17:43'), /2026/);
  assert.match(shortTimestamp('16 Jul 2026 @ 17:43'), /17:43/);
  assert.equal(shortTimestamp('not supplied'), 'not supplied');
});

test('nearby measurements do not produce overlapping x-axis date labels', () => {
  assert.deepEqual(chartLabelIndices([0, 0.5, 0.51, 1], 450), [0, 1, 3]);
  assert.deepEqual(chartLabelIndices([0.5, 0.5], 450), [0]);
});

test('laboratory trends use dated numerical results, not order dates or inequality values', () => {
  const profile = buildPatientProfile([{ patient: {
    episodeId: '1-1',
    labOrders: [{ name: 'CBC', orderDateTime: '2025-01-01', results: [
      { name: 'Platelets', value: '80,000', unit: '/uL', dateTime: '2025-01-03 10:00' },
      { name: 'Platelets', value: '60,000', unit: '/uL', dateTime: '2025-01-02 10:00' },
      { name: 'Platelets', value: '<10', unit: '/uL', dateTime: '2025-01-04' },
      { name: 'Platelets', value: '90,000', unit: '/uL' },
    ] }],
  } }]);
  assert.deepEqual(profile.labReadings.map((result) => result.value), [60000, 80000]);
  assert.deepEqual(profile.labReadings.map((result) => result.dateTime), ['2025-01-02 10:00', '2025-01-03 10:00']);
  assert.ok(profile.labReadings.every((result) => result.episodeId === '1-1'));
});

test('recorded episode facts do not use an order date as an undated result timestamp', () => {
  const report = episodeReport({ labOrders: [{ name: 'CBC', orderDateTime: '2026-07-01 09:00', results: [{ name: 'Platelets', value: '80000', unit: '/uL' }] }] });
  const investigations = report.find((section) => section.key === 'investigations').lines.join(' ');
  assert.match(investigations, /Result date not recorded/);
  assert.doesNotMatch(investigations, /2026-07-01 09:00/);
});

test('latest recorded observations are selected chronologically rather than by source-array order', () => {
  const report = episodeReport({ vitals: [
    { dateTime: '02 Jul 2026 @ 20:00', measurements: [{ name: 'PULSE', value: '90' }] },
    { dateTime: '23 Mar 2026 @ 21:24', measurements: [{ name: 'PULSE', value: '70' }] },
  ] });
  const latest = report.find((section) => section.key === 'observations').lines.join(' ');
  assert.match(latest, /PULSE: 90/);
  assert.doesNotMatch(latest, /PULSE: 70/);
});

test('episode snapshot counts recorded material and does not synthesize missing facts', () => {
  const snapshot = episodeSnapshot({ diagnoses: [], complaints: [], notes: [], medications: [], labOrders: [], radOrders: [] });
  assert.deepEqual(snapshot, {
    diagnosisCount: 0,
    diagnoses: [],
    complaints: [],
    noteCount: 0,
    medicationCount: 0,
    labOrderCount: 0,
    radiologyOrderCount: 0,
  });
});

test('clinical summaries use only recorded diagnoses, complaints, and episode counts', () => {
  const patient = {
    episodeId: '1-2025',
    episode: { startDate: '2025-01-12' },
    diagnoses: [{ diagnosis: 'Recorded condition', isPrimary: true }],
    complaints: [{ name: 'Recorded complaint' }],
    notes: [{}, {}],
    medications: [{}],
    labOrders: [{}],
    radOrders: [],
  };
  const records = [{ patient }];
  const profile = buildPatientProfile(records);
  const summaryFacts = longitudinalSummary(records, profile);
  const summary = summaryFacts.map((item) => item.value).join(' ');
  assert.match(summary, /1 recorded episode/);
  assert.match(summary, /Recorded condition/);
  assert.deepEqual(summaryFacts.map((item) => item.label), ['Episode history', 'Primary diagnoses', 'Other recorded conditions', 'Medication history']);
  const report = episodeReport(patient);
  assert.ok(report.find((section) => section.title === 'Presentation').lines.some((line) => line.includes('Recorded complaint')));
  assert.ok(report.find((section) => section.title === 'Diagnoses and problems').lines.some((line) => line.includes('Recorded condition')));
  assert.doesNotMatch(summary, /improved|stable|resolved/i);
});

test('episode report organizes recorded presentation, note course, medications, investigations, and vitals', () => {
  const report = episodeReport({
    episodeId: '1-44',
    complaints: [{ name: 'Recorded symptom', remark: 'Recorded for four days' }],
    diagnoses: [{ diagnosis: 'Recorded diagnosis', isPrimary: true }],
    problems: [{ problem: 'Recorded comorbidity', status: 'ACTIVE' }],
    allergies: { items: [{ allergy: 'Recorded allergen', reaction: 'Rash' }] },
    notes: [{ title: 'Progress note', dateOfEntry: '12 JAN 2025', content: ['Assessment: Documented episode progression.', 'Plan: Continue recorded course.'] }],
    medications: [{ medication: 'Recorded medicine', status: 'ACTIVE', route: 'ORAL', schedule: 'BD', startDate: '2025-01-13' }],
    labOrders: [{ name: 'Recorded test', status: 'COMPLETED', orderDateTime: '2025-01-12' }],
    radOrders: [{ procedure: 'Recorded imaging', status: 'COMPLETED', dateTime: '2025-01-12' }],
    vitals: [{ dateTime: '2025-01-12 10:00', measurements: [{ name: 'PULSE', value: '72' }] }],
  });
  const sections = Object.fromEntries(report.map((section) => [section.title, section.lines.join(' ')]));
  assert.match(sections.Presentation, /Recorded symptom.*four days/);
  assert.match(sections['Diagnoses and problems'], /Recorded diagnosis.*Recorded comorbidity/);
  assert.match(sections['Course and dated events'], /Assessment: Documented episode progression/);
  assert.match(sections['Course and dated events'], /Lab order: Recorded test/);
  assert.match(sections['Course and dated events'], /Medication order start date: Recorded medicine/);
  assert.match(sections['Treatment \/ medication course'], /Recorded medicine.*ACTIVE/);
  assert.match(sections.Investigations, /Recorded test.*Recorded imaging/);
  assert.match(sections['Vital parameters'], /PULSE: 72/);
  assert.doesNotMatch(JSON.stringify(report), /improved|stable|resolved/i);
});
