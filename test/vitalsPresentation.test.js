import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isVitalMeasurementOrder, vitalParameterRows, vitalParameterLines } from '../shared/vitals.js';
import { buildPatientProfile, episodeReport, episodeSnapshot } from '../client/src/profileData.js';
import { sourceClaimIssues } from '../server/sourceChecks.js';
import { buildLocalEvidence, recordedEvidenceSummary } from '../server/localEvidence.js';

const headings = ['Presentation', 'Hospital Course', 'Diagnoses and Problems', 'Key Medications', 'Investigations', 'Follow-up / Open Items'];
const patient = {
  episodeId: 'test-vitals', episode: { id: 'test-vitals' },
  vitals: [{ dateTime: '2026-07-01 10:00', measurements: [
    { name: 'BLOOD PRESSURE', value: '120/80', unit: 'mmHg' },
    { name: 'PULSE', value: '80', unit: '/min' },
    { name: 'TEMPERATURE', value: '98.6', unit: 'F' },
  ] }],
  labOrders: [{ name: 'CBC', orderDateTime: '2026-07-01 09:00', results: [{ name: 'Platelets', value: '80000', unit: '/uL', dateTime: '2026-07-01 12:00' }] }, { name: 'Temperature', status: 'PENDING', orderDateTime: '2026-07-02 09:00' }],
};

test('vital parameters render on separate lines with their own timestamps and units', () => {
  const lines = vitalParameterLines([patient]);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^BLOOD PRESSURE: 120\/80 mmHg/);
  assert.doesNotMatch(lines[0], /PULSE|TEMPERATURE/);
  assert.match(lines[1], /^PULSE: 80 \/min/);
  assert.match(lines[2], /^TEMPERATURE: 98\.6 F/);
  assert.ok(lines.every((line) => line.includes('2026-07-01 10:00')));
  const report = episodeReport(patient);
  assert.equal(report.find((section) => section.key === 'observations').title, 'Vital parameters');
  assert.equal(report.find((section) => section.key === 'observations').lines.length, 3);
  assert.doesNotMatch(report.find((section) => section.key === 'investigations').lines.join(' '), /BLOOD PRESSURE|PULSE|TEMPERATURE/i);
});

test('latest vital rows are selected independently without merging incompatible units', () => {
  const rows = vitalParameterRows([patient, { episodeId: 'later', vitals: [{ dateTime: '2026-07-02 10:00', measurements: [{ name: 'PULSE', value: '90', unit: '/min' }, { name: 'TEMPERATURE', value: '37', unit: 'C' }] }] }]);
  assert.equal(rows.find((row) => row.name === 'PULSE').value, '90');
  assert.equal(rows.find((row) => row.name === 'BLOOD PRESSURE').dateTime, '2026-07-01 10:00');
  assert.equal(rows.filter((row) => row.name === 'TEMPERATURE').length, 2);
});

test('vital measurement orders stay outside lab investigations and never borrow an order timestamp for a measurement', () => {
  assert.equal(isVitalMeasurementOrder({ name: 'Temperature' }), true);
  assert.equal(isVitalMeasurementOrder({ name: 'PULSE' }), true);
  assert.equal(isVitalMeasurementOrder({ name: 'Thyroid stimulating hormone' }), false);
  assert.equal(episodeSnapshot(patient).labOrderCount, 1);
  const mixed = { ...patient, labOrders: [...patient.labOrders, { name: 'Pulse', orderDateTime: '2026-07-03', results: [{ name: 'PULSE', value: '95', unit: '/min' }] }] };
  const profile = buildPatientProfile([{ patient: mixed }]);
  assert.ok(profile.labReadings.every((reading) => reading.name === 'Platelets'));
  const undated = vitalParameterRows([{ labOrders: [mixed.labOrders.at(-1)] }]);
  assert.equal(undated[0].dateTime, '');
  assert.equal(undated[0].value, '95');
});

test('AI source checks reject physiological measurements in investigations but allow actual lab results', () => {
  assert.ok(sourceClaimIssues([{ title: 'Investigations', items: ['2026-07-01: BP 120/80 mmHg, pulse 80/min.'] }], [patient]).some((issue) => issue.includes('Vital parameters must be kept out')));
  assert.ok(sourceClaimIssues([{ title: 'Condition and investigation trends', items: ['Temperature ranged from 98.6 to 99 F.'] }], [patient]).some((issue) => issue.includes('Vital parameters must be kept out')));
  assert.deepEqual(sourceClaimIssues([{ title: 'Investigations', items: ['2026-07-01: Platelets 80000 /uL.'] }], [patient]), []);
  assert.deepEqual(sourceClaimIssues([{ title: 'Investigations', items: ['2026-07-02: Spirometry, forced vital capacity 3 L.'] }], [patient]), []);
});

test('local-model and recorded-facts fallbacks do not classify vitals as investigations or combine measured parameters', () => {
  const packet = buildLocalEvidence([patient], headings);
  const response = { sections: Object.fromEntries(Object.entries(packet.schema.properties.sections.properties).map(([title, section]) => [title, Object.fromEntries(Object.keys(section.properties).map((slot) => [slot, '']))])) };
  const course = packet.schema.properties.sections.properties['Hospital Course'].properties.item1.enum.filter(Boolean).slice(-3);
  response.sections['Hospital Course'].item1 = course[0];
  response.sections['Hospital Course'].item2 = course[1];
  const model = packet.render(JSON.stringify(response));
  const fallback = recordedEvidenceSummary([patient], headings);
  for (const result of [model, fallback]) assert.doesNotMatch(result.sections.find((section) => section.title === 'Investigations').items.join(' '), /BLOOD PRESSURE|PULSE|TEMPERATURE/i);
  const lines = model.sections.find((section) => section.title === 'Hospital Course').items;
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => !line.includes(';')));
});
