import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPatientProfile, episodeReport, episodeSnapshot, longitudinalSummary, metricSeries } from '../client/src/profileData.js';

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
  assert.match(summary, /1 inpatient episode/);
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
  assert.match(sections['Course and dated events'], /Medication started: Recorded medicine/);
  assert.match(sections['Treatment \/ medication course'], /Recorded medicine.*ACTIVE/);
  assert.match(sections.Investigations, /Recorded test.*Recorded imaging/);
  assert.match(sections['Latest observations'], /PULSE 72/);
  assert.doesNotMatch(JSON.stringify(report), /improved|stable|resolved/i);
});
