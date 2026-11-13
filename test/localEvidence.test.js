import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLocalEvidence } from '../server/localEvidence.js';

const headings = ['Overall clinical story', 'Dated clinical timeline', 'Condition and investigation trends', 'Medication course', 'Recorded background', 'Monitoring considerations'];

function output(schema) {
  return { sections: Object.fromEntries(Object.entries(schema.properties.sections.properties).map(([title, section]) => [title, Object.fromEntries(Object.keys(section.properties).map((slot) => [slot, '']))])) };
}

test('local timeline and medication course retain both ends of episode history even when the model chooses only older facts', () => {
  const packet = buildLocalEvidence([
    { episodeId: 'old', episode: { id: 'old', startDate: '2026-03-23' }, complaints: [{ name: 'Fever', date: '2026-03-25' }], medications: [{ medication: 'Old medicine', startDate: '2026-03-25', status: 'DISCONTINUED' }] },
    { episodeId: 'new', episode: { id: 'new', startDate: '2026-11-02' }, medications: [{ medication: 'New medicine', startDate: '2026-11-03', status: 'PENDING' }] },
  ], headings);
  const response = output(packet.schema);
  for (const title of ['Overall clinical story', 'Dated clinical timeline', 'Medication course']) response.sections[title].item1 = packet.schema.properties.sections.properties[title].properties.item1.enum.find(Boolean);
  const result = packet.render(JSON.stringify(response));
  for (const title of ['Overall clinical story', 'Dated clinical timeline', 'Medication course']) {
    const items = result.sections.find((section) => section.title === title).items;
    assert.ok(items.some((item) => item.includes('episode old:')));
    assert.ok(items.some((item) => item.includes('episode new:')));
  }
  assert.match(result.sections.find((section) => section.title === 'Dated clinical timeline').items.at(-1), /^2026-11-03/);
});

test('local evidence omits placeholder highlights and coalesces identical same-day complaint text without changing the source records', () => {
  const complaints = [{ name: 'Abdominal pain', remark: 'Recorded remark', date: '2026-07-09 15:03' }, { name: 'Abdominal pain', remark: 'Recorded remark', date: '2026-07-09 16:05' }, { name: 'GOOD ONE', date: '2026-07-09' }];
  const packet = buildLocalEvidence([{ episode: { id: '1' }, complaints }], ['Presentation', 'Hospital Course', 'Diagnoses and Problems', 'Key Medications', 'Investigations', 'Follow-up / Open Items']);
  const choices = packet.schema.properties.sections.properties.Presentation.properties.item1.enum.filter(Boolean);
  assert.equal(choices.length, 1);
  assert.doesNotMatch(packet.prompt, /GOOD ONE/);
  assert.equal(complaints.length, 3);
});

test('local condition trends preserve dated serial platelet values and units instead of one isolated result', () => {
  const packet = buildLocalEvidence([
    { episodeId: '1', episode: { id: '1', startDate: '2026-07-01' }, labOrders: [{ name: 'CBC', results: [{ name: 'Platelets', value: '80000', unit: '/uL', dateTime: '2026-07-01 10:00' }, { name: 'Platelets', value: '60000', unit: '/uL', dateTime: '2026-07-02 10:00' }] }] },
    { episodeId: '2', episode: { id: '2', startDate: '2026-07-03' }, labOrders: [{ name: 'CBC', results: [{ name: 'Platelets', value: '120000', unit: '/uL', dateTime: '2026-07-03 10:00' }] }] },
  ], headings);
  const result = packet.render(JSON.stringify(output(packet.schema)));
  const trend = result.sections.find((section) => section.title === 'Condition and investigation trends').items.join(' ');
  assert.match(trend, /80000 \/uL \(2026-07-01 10:00\).*60000 \/uL \(2026-07-02 10:00\).*120000 \/uL \(2026-07-03 10:00\)/);
});
