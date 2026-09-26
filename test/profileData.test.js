import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPatientProfile, episodeSnapshot, episodeSummary, longitudinalSummary, metricSeries } from '../client/src/profileData.js';

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
  assert.match(episodeSummary(patient), /Recorded complaint/);
  assert.doesNotMatch(summary, /improved|stable|resolved/i);
});
