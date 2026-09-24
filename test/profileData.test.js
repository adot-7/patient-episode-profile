import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPatientProfile, episodeSnapshot, metricSeries } from '../client/src/profileData.js';

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
