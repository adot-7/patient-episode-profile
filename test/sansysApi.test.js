import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import request from 'supertest';
import { createApp } from '../server/app.js';

const originalFetch = globalThis.fetch;
let fetchCalls;

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function sansysFixtureFetch(input, options = {}) {
  const url = new URL(String(input));
  const method = options.method || 'GET';
  const body = options.body ? JSON.parse(options.body) : {};
  fetchCalls.push(`${method} ${url.pathname}`);

  if (url.pathname === '/diagnosis/dash/list' && method === 'POST' && !body.visit_id) {
    return jsonResponse({ success: true, data: {
      default_visit: '1-2025',
      visits: { ipVisits: [
        { id: '0', name: 'Invalid non-episode' },
        { id: '1-2025', name: '12 JAN 2025 11:00 - MEDICAL WARD' },
        { id: '1-2024', name: '03 MAY 2024 09:00 - SURGICAL WARD' },
      ] },
      diagnoses: [],
    } });
  }
  if (url.pathname === '/patientHome/load-demographics/TEST-PROFILE-1') {
    return jsonResponse({ success: true, data: { lfname: 'Sample', llname: 'Patient', lsex: 'Female', lage: '42', cpPID: 'TEST-UHID', cpIPNo: 'IP-1', admdt: '2025-01-12' } });
  }
  if (url.pathname === '/allergies/dashboard-list/TEST-PROFILE-1') {
    return jsonResponse({ success: true, status: 'Known allergies', data: [{ allergy: 'Example allergen', natureOfReaction: 'Drug', symptoms: 'Rash', date: '2024-01-01' }] });
  }
  if (url.pathname === '/clinical-notes/list' && method === 'POST') {
    assert.equal(body.visit_id, '1-2025');
    return jsonResponse({ success: true, total_records: 1, data: [{ note_ien: 'NOTE-1', note_title: 'Ward review', date_of_entry: '12 JAN 2025', status_name: 'SIGNED', author_name: 'Clinician' }] });
  }
  if (url.pathname === '/clinical-notes/view/NOTE-1') {
    return jsonResponse({ success: true, data: {
      content: [{ questions: [{ question: 'Assessment', answer: 'Recorded findings.' }] }],
      patient_objects: { medications: [{ medication_name: 'Note-only medication', status: 'ACTIVE', route: 'ORAL' }] },
    } });
  }
  if (url.pathname === '/lab/list') return jsonResponse({ success: true, data: { orders: [{ itemOrdered: 'CBC', orderDateTime: '2025-01-12', status: { name: 'COMPLETED' } }] } });
  if (url.pathname === '/rad/cpoe-list') return jsonResponse({ success: true, data: { orders: [] } });
  if (url.pathname.startsWith('/vitals/dash/load/')) return jsonResponse({ success: true, data: { vitals: [{ date_time: '2025-01-12 10:00', measurements: { 'BLOOD PRESSURE': { value: '124/78', unit: 'mmHg' }, PULSE: { value: '72' } } }], admissions: [] } });
  if (url.pathname === '/problems/dash-list') return jsonResponse({ success: true, data: { problems: [{ problem: 'Recorded problem', status: 'ACTIVE', dateOnset: '2020-01-01' }] } });
  if (url.pathname === '/diagnosis/dash/list' && body.visit_id) return jsonResponse({ success: true, data: { diagnoses: [{ diagnosis: 'Recorded diagnosis', isPrimary: true, type: 'Primary', dateEntered: '2025-01-12' }] } });
  if (url.pathname === '/chiefcomplaint/dash-list/TEST-PROFILE-1') return jsonResponse({ success: true, data: { complaints: [{ complaint_name: 'Headache', complaint_type: 'Chief Complaint', remark: 'Recorded complaint', date: '2025-01-12' }] } });
  if (url.pathname === '/med/list') return jsonResponse({ success: true, data: { orders: [{ medication_name: 'Endpoint medication', status: 'ACTIVE', route: 'ORAL', start_date: '2025-01-12' }] } });
  throw new Error(`Unexpected Sansys fixture request: ${method} ${url.pathname}`);
}

beforeEach(() => {
  fetchCalls = [];
  globalThis.fetch = sansysFixtureFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('profile API builds episodes from Sansys discovery and ignores invalid visit rows', async () => {
  const response = await request(createApp()).get('/api/patients/TEST-PROFILE-1/shell');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.episodes.map((episode) => episode.id), ['1-2025', '1-2024']);
  assert.equal(response.body.episodeId, '1-2025');
  assert.equal(response.body.demographics.firstName, 'Sample');
  assert.equal(response.body.allergies.items[0].allergy, 'Example allergen');
});

test('profile API loads selected episode collections, notes, and source provenance', async () => {
  const response = await request(createApp()).get('/api/patients/TEST-PROFILE-1?episodeId=1-2025');
  assert.equal(response.status, 200);
  assert.equal(response.body.episodeId, '1-2025');
  assert.equal(response.body.diagnoses[0].diagnosis, 'Recorded diagnosis');
  assert.equal(response.body.medications.length, 2);
  assert.ok(response.body.medications.some((item) => item.medication === 'Note-only medication' && item.needsVerification));
  assert.equal(response.body.notes[0].content[0], 'Assessment: Recorded findings.');
  assert.equal(response.body.labOrders[0].name, 'CBC');
  assert.equal(response.body.vitals[0].measurements.find((item) => item.name === 'BLOOD PRESSURE').value, '124/78');
  assert.ok(response.body.diagnoses[0].provenance[0].endpoint.includes('/diagnosis/dash/list'));
  assert.ok(fetchCalls.some((call) => call === 'GET /clinical-notes/view/NOTE-1'));
});

test('profile API rejects writes and converts upstream failures to a clear 502', async () => {
  const write = await request(createApp()).post('/api/patients/TEST-PROFILE-1').send({});
  assert.equal(write.status, 405);
  assert.equal(fetchCalls.length, 0);

  globalThis.fetch = async () => jsonResponse({ error: 'unavailable' }, 500);
  const response = await request(createApp()).get('/api/patients/TEST-PROFILE-FAIL/shell');
  assert.equal(response.status, 502);
  assert.match(response.body.error, /HTTP 500/);
});

test('profile API supports deployment beneath an EHR URL prefix', async () => {
  const previous = process.env.APP_BASE_PATH;
  process.env.APP_BASE_PATH = '/patient-profile/';
  try {
    const response = await request(createApp()).get('/patient-profile/api/health');
    assert.equal(response.status, 200);
    assert.equal(response.body.service, 'patient-episode-profile');
  } finally {
    if (previous === undefined) delete process.env.APP_BASE_PATH;
    else process.env.APP_BASE_PATH = previous;
  }
});
