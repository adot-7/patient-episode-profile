const BASE_URL = (process.env.SANSYS_BASE_URL || 'http://182.70.249.137:5050').replace(/\/$/, '');
const DUZ = Number(process.env.SANSYS_DUZ || 1);
const TIMEOUT_MS = Number(process.env.SANSYS_TIMEOUT_MS || 30000);
const PAGE_SIZE = 25;
const CACHE_MS = 60_000;
const MAX_CACHE_ENTRIES = 12;
const shellCache = new Map();
const patientCache = new Map();

const asText = (value) => (value === null || value === undefined ? '' : String(value));
const clean = (value) => asText(value).replace(/\s+/g, ' ').trim();
const encoded = (value) => encodeURIComponent(String(value));

class SansysError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'SansysError';
    this.status = status;
  }
}

function retryable(error) {
  if (error?.retryable) return true;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return true;
  const code = error?.cause?.code || error?.code;
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
}

async function requestJson(method, path, body) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        const error = new SansysError(`Sansys ${method} ${path} returned HTTP ${response.status}.`, 502);
        error.retryable = response.status >= 500 || response.status === 429;
        throw error;
      }
      try {
        return await response.json();
      } catch (cause) {
        throw new SansysError(`Sansys ${method} ${path} returned invalid JSON: ${cause.message}`, 502);
      }
    } catch (error) {
      lastError = error;
      if (attempt === 2 || !retryable(error)) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  if (lastError instanceof SansysError) throw lastError;
  throw new SansysError(`Cannot reach Sansys ${method} ${path}: ${lastError?.message || 'network error'}.`, 502);
}

function dataOf(raw) {
  return raw?.data ?? raw ?? {};
}

function listOf(raw, key) {
  if (Array.isArray(raw?.[key])) return raw[key];
  if (Array.isArray(raw?.data)) return raw.data;
  if (Array.isArray(raw?.data?.[key])) return raw.data[key];
  if (Array.isArray(raw?.[key]?.[key])) return raw[key][key];
  return [];
}

function dateValue(value) {
  const date = clean(value);
  return /^(invalid date|n\/?a|null|undefined)$/i.test(date) ? '' : date;
}

function parseEpisodeDate(label) {
  const match = clean(label).match(/^(\d{1,2})\s+([A-Z]{3,4})[ ,]+(\d{4})/i);
  if (!match) return '';
  const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, SEPT: 8, OCT: 9, NOV: 10, DEC: 11 };
  const month = months[match[2].toUpperCase()];
  if (month === undefined) return '';
  return new Date(Date.UTC(Number(match[3]), month, Number(match[1]))).toISOString().slice(0, 10);
}

function addDays(value, amount) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function buildEpisodes(raw) {
  const data = dataOf(raw);
  const visits = data?.visits?.ipVisits ?? raw?.visits?.ipVisits ?? [];
  const episodes = new Map();
  for (const visit of visits) {
    const id = asText(visit?.id);
    if (!/^1-\d+$/.test(id)) continue;
    const label = asText(visit.name || visit.label || id);
    episodes.set(id, {
      id,
      label,
      startDate: parseEpisodeDate(label),
      admissionId: id.slice(2),
      admissionIen: id.slice(2),
    });
  }
  const result = [...episodes.values()].sort((left, right) => right.startDate.localeCompare(left.startDate));
  result.forEach((episode, index) => {
    episode.dateFrom = episode.startDate;
    episode.dateTo = index > 0 ? addDays(result[index - 1].startDate, -1) : '';
  });
  return result;
}

function provenance(endpoint, path, episode, recordId) {
  return {
    sourceType: 'sansys-endpoint',
    endpoint,
    path,
    ...(episode ? { episodeId: episode.id } : {}),
    ...(recordId ? { recordId: asText(recordId) } : {}),
  };
}

function noteProvenance(note, path) {
  return {
    sourceType: 'clinical-note',
    endpoint: `/clinical-notes/view/${encoded(note.note_ien)}`,
    path,
    noteIen: asText(note.note_ien),
    noteTitle: asText(note.note_title),
    noteDate: asText(note.date_of_entry),
    needsVerification: true,
  };
}

function normalizeDemographics(raw) {
  const value = dataOf(raw);
  return {
    firstName: asText(value.lfname),
    lastName: asText(value.llname),
    sex: asText(value.lsex),
    dob: dateValue(value.dob),
    age: asText(value.lage),
    uhid: asText(value.cpPID),
    ipNo: asText(value.cpIPNo),
    ward: asText(value.ward),
    admitDate: dateValue(value.admdt),
    primaryPhysician: asText(value.pphy),
    dischargeDate: dateValue(value.DisDate),
  };
}

function mapDiagnosis(item, source) {
  return {
    diagnosis: clean(item.diagnosis ?? item.diagnosis_name_with_icd ?? item.master_name),
    isPrimary: item.isPrimary === true || /^primary$/i.test(asText(item.isPrimarySecondary)),
    type: asText(item.type || item.isPrimarySecondary),
    dateEntered: dateValue(item.dateEntered ?? item.diag_entered_date ?? item.entered_datetime),
    provenance: [source],
  };
}

function mapProblem(item, source) {
  const comorbidity = item.comorbidity;
  return {
    problem: clean(item.problem ?? item.problem_name_with_icd ?? item.problem_name),
    status: asText(item.status),
    dateOnset: dateValue(item.dateOnset ?? item.date_of_onset),
    comorbidity: comorbidity === true || comorbidity === 1 || ['true', '1', 'yes', 'y'].includes(asText(comorbidity).toLowerCase()),
    provenance: [source],
  };
}

function mapComplaint(item, source) {
  const type = clean(item.complaint_type ?? item.type);
  return {
    name: clean(item.complaint_name ?? item.name),
    type: /^associated complaint$/i.test(type) ? 'Associated Complaint' : 'Chief Complaint',
    remark: clean(item.remark),
    date: dateValue(item.date ?? item.entry_datetime),
    provenance: [source],
  };
}

function mapMedication(item, source) {
  return {
    medication: clean(item.medication_name ?? item.medication),
    startDate: dateValue(item.start_date ?? item.startDate),
    stopDate: dateValue(item.stop_date ?? item.stopDate),
    status: asText(item.status),
    schedule: asText(item.schedule),
    scheduleType: asText(item.schedule_type ?? item.scheduleType),
    route: asText(item.route),
    service: asText(item.service),
    provenance: [source],
    ...(source.needsVerification ? { needsVerification: true } : {}),
  };
}

function mapLab(item, source) {
  return {
    name: clean(item.itemOrdered ?? item.lab_name ?? item.name),
    section: asText(item.section),
    orderDateTime: dateValue(item.orderDateTime ?? item.entry_datetime),
    status: asText(item.status?.name ?? item.status ?? ''),
    provenance: [source],
  };
}

function mapRadiology(item, source) {
  return {
    procedure: clean(item.imaging_procedure ?? item.radiology_name ?? item.procedure),
    imagingType: asText(item.imaging_type),
    status: asText(item.status?.name ?? item.status ?? ''),
    dateTime: dateValue(item.start_date_time ?? item.entry_datetime ?? item.dateTime),
    provenance: [source],
  };
}

function normalizeVitals(raw, episode) {
  return listOf(raw, 'vitals').map((item, index) => {
    let measurements = item.measurements ?? [];
    if (!Array.isArray(measurements) && measurements && typeof measurements === 'object') {
      measurements = Object.entries(measurements).map(([name, measurement]) => ({
        name,
        value: measurement?.value,
        unit: measurement?.unit,
        is_abnormal: measurement?.is_abnormal ?? measurement?.isAbnormal ?? measurement?.bgColor != null,
      }));
    }
    return {
      dateTime: dateValue(item.date_time ?? item.dateTime),
      measurements: measurements
        .filter((measurement) => clean(measurement?.value) && clean(measurement.value).toLowerCase() !== 'not entered')
        .map((measurement) => ({
          name: asText(measurement.name),
          value: asText(measurement.value),
          unit: asText(measurement.unit),
          isAbnormal: measurement.is_abnormal === true || measurement.is_abnormal === 1 || ['true', '1', 'yes', 'y'].includes(asText(measurement.is_abnormal).toLowerCase()),
        })),
      provenance: [provenance('/vitals/dash/load/:dfn', `data.vitals[${index}]`, episode)],
    };
  }).filter((item) => item.measurements.length).sort((left, right) => left.dateTime.localeCompare(right.dateTime));
}

function flattenNoteContent(content, lines = []) {
  for (const group of Array.isArray(content) ? content : []) {
    for (const question of group?.questions || []) {
      const title = asText(question.question);
      const answer = asText(question.answer);
      if (title || answer) lines.push(`${title}${title ? ': ' : ''}${answer}`);
      flattenNoteContent(question.children, lines);
    }
  }
  return lines;
}

function compactPatientObjects(objects = {}) {
  return Object.fromEntries(Object.entries(objects).filter(([, value]) => (
    Array.isArray(value) ? value.length > 0
      : value && typeof value === 'object' ? Object.keys(value).length > 0
        : Boolean(value)
  )));
}

function mapNote(note, detail) {
  const detailData = dataOf(detail);
  return {
    noteIen: asText(note.note_ien),
    title: asText(note.note_title),
    dateOfEntry: asText(note.date_of_entry),
    status: asText(note.status_name),
    author: asText(note.author_name),
    content: flattenNoteContent(detailData.content),
    patientObjects: compactPatientObjects(detailData.patient_objects || {}),
    provenance: [noteProvenance(note, 'data.content')],
    needsVerification: true,
  };
}

async function fetchNotes(dfn, episode) {
  const rawNotes = [];
  let offset = 0;
  while (true) {
    const pageResponse = await requestJson('POST', '/clinical-notes/list', {
      patient_dfn: dfn,
      duz: DUZ,
      limit: PAGE_SIZE,
      offset,
      date_from: episode.dateFrom,
      date_to: episode.dateTo,
      search_text: '',
      status_filter: '',
      visit_id: episode.id,
    });
    const page = listOf(pageResponse, 'notes');
    rawNotes.push(...page);
    const total = pageResponse?.total_records ?? dataOf(pageResponse)?.total_records;
    if (!page.length || (total !== undefined && total !== null && rawNotes.length >= Number(total))) break;
    if ((total === undefined || total === null) && page.length < PAGE_SIZE) break;
    offset += page.length;
  }

  const details = [];
  for (let index = 0; index < rawNotes.length; index += 8) {
    const batch = await Promise.all(rawNotes.slice(index, index + 8).map(async (note) => {
      try {
        return await requestJson('GET', `/clinical-notes/view/${encoded(note.note_ien)}`);
      } catch (error) {
        console.warn(`[sansys] note detail unavailable (${error.message})`);
        return null;
      }
    }));
    details.push(...batch);
  }

  return rawNotes.map((note, index) => mapNote(note, details[index]));
}

function factKey(type, item) {
  if (type === 'diagnoses') return clean(item.diagnosis).toLowerCase();
  if (type === 'problems') return clean(item.problem).toLowerCase();
  if (type === 'complaints') return [item.type, item.name, item.date].map(clean).join('|').toLowerCase();
  if (type === 'medications') return [item.medication, item.route, item.startDate].map(clean).join('|').toLowerCase();
  if (type === 'labOrders') return [item.name, item.orderDateTime].map(clean).join('|').toLowerCase();
  if (type === 'radOrders') return [item.procedure, item.dateTime].map(clean).join('|').toLowerCase();
  if (type === 'allergies') return [item.allergy, item.reaction, item.symptoms].map(clean).join('|').toLowerCase();
  return [item.dateTime, ...(item.measurements || []).map((measurement) => `${measurement.name}:${measurement.value}`)].map(clean).join('|').toLowerCase();
}

function mergeFacts(endpointFacts, noteFacts, type) {
  const result = [];
  const indexes = new Map();
  for (const fact of [...endpointFacts, ...noteFacts]) {
    const key = factKey(type, fact);
    if (!key.replaceAll('|', '')) continue;
    if (!indexes.has(key)) {
      indexes.set(key, result.length);
      result.push(fact);
      continue;
    }
    const index = indexes.get(key);
    const existing = result[index];
    const sources = [...(existing.provenance || []), ...(fact.provenance || [])];
    const uniqueSources = [...new Map(sources.map((source) => [JSON.stringify(source), source])).values()];
    result[index] = {
      ...fact,
      ...existing,
      provenance: uniqueSources,
      needsVerification: uniqueSources.some((source) => source.sourceType === 'clinical-note')
        && !uniqueSources.some((source) => source.sourceType === 'sansys-endpoint'),
    };
  }
  return result;
}

function factsFromNotes(notes) {
  const facts = { diagnoses: [], problems: [], complaints: [], medications: [], labOrders: [], radOrders: [], allergies: [], vitals: [] };
  for (const note of notes) {
    const objects = note.patientObjects || {};
    const noteFact = (field, index) => noteProvenance({
      note_ien: note.noteIen,
      note_title: note.title,
      date_of_entry: note.dateOfEntry,
    }, `data.patient_objects.${field}[${index}]`);
    for (const [key, value, mapper] of [
      ['diagnoses', objects.diagnoses, mapDiagnosis],
      ['problems', objects.problems, mapProblem],
      ['complaints', objects.complaints, mapComplaint],
      ['medications', objects.medications, mapMedication],
      ['labOrders', objects.labs, mapLab],
      ['radOrders', objects.radiology, mapRadiology],
    ]) {
      (Array.isArray(value) ? value : []).forEach((item, index) => facts[key].push(mapper(item, noteFact(key, index))));
    }
    (Array.isArray(objects.allergies) ? objects.allergies : []).forEach((item, index) => facts.allergies.push({
      allergy: clean(item.allergy ?? item.allergy_name),
      reaction: asText(item.reaction ?? item.natureOfReaction ?? item.nature),
      symptoms: asText(item.symptoms),
      date: dateValue(item.date ?? item.entry_datetime),
      provenance: [noteFact('allergies', index)],
      needsVerification: true,
    }));
    (Array.isArray(objects.vitals) ? objects.vitals : []).forEach((item, index) => facts.vitals.push({
      dateTime: dateValue(item.date_time ?? item.entry_datetime),
      measurements: [{
        name: clean(item.name ?? item.vital_name),
        value: asText(item.value ?? item.vital_value),
        unit: asText(item.unit ?? item.vital_unit),
        isAbnormal: false,
      }],
      provenance: [noteFact('vitals', index)],
      needsVerification: true,
    }));
  }
  return facts;
}

function mapEndpointList(raw, key, endpoint, episode, mapper, recordId) {
  return listOf(raw, key).map((item, index) => mapper(item, provenance(endpoint, `data.${key}[${index}]`, episode, recordId?.(item))));
}

function readCache(cache, key) {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(cache, key, value) {
  const now = Date.now();
  cache.delete(key);
  for (const [cachedKey, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(cachedKey);
  }
  while (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expiresAt: now + CACHE_MS });
  return value;
}

export async function fetchPatientShell(dfn) {
  dfn = clean(dfn);
  if (!dfn || dfn.length > 128) throw new SansysError('A valid patient identifier is required.', 400);
  const cacheKey = `shell:${dfn}`;
  const cached = readCache(shellCache, cacheKey);
  if (cached) return structuredClone(cached);

  const [discovery, demographics, allergiesRaw] = await Promise.all([
    requestJson('POST', '/diagnosis/dash/list', { dfn, visit_id: '', duz: DUZ }),
    requestJson('GET', `/patientHome/load-demographics/${encoded(dfn)}?userId=1`),
    requestJson('GET', `/allergies/dashboard-list/${encoded(dfn)}`),
  ]);
  const episodes = buildEpisodes(discovery);
  const defaultId = asText(dataOf(discovery).default_visit);
  const episode = episodes.find((candidate) => candidate.id === defaultId) || episodes[0] || null;
  const allergyItems = listOf(allergiesRaw, 'data').map((item, index) => ({
    allergy: clean(item.allergy ?? item.allergy_name),
    reaction: asText(item.natureOfReaction ?? item.nature),
    symptoms: asText(item.symptoms),
    date: dateValue(item.date ?? item.entry_datetime),
    provenance: [provenance('/allergies/dashboard-list/:patientIen', `data[${index}]`, null)],
  }));
  return structuredClone(writeCache(shellCache, cacheKey, {
    dfn,
    demographics: normalizeDemographics(demographics),
    allergies: { status: asText(allergiesRaw.status), items: allergyItems },
    episodes,
    episodeId: episode?.id || '',
    episode,
    notes: [],
    complaints: [],
    diagnoses: [],
    problems: [],
    medications: [],
    activeMedications: [],
    dischargeMedications: [],
    labOrders: [],
    radOrders: [],
    vitals: [],
  }));
}

async function fetchVitals(dfn, episode) {
  let response = await requestJson('GET', `/vitals/dash/load/${encoded(dfn)}?fromDate=&toDate=&admissionId=${encoded(episode.admissionId)}&range=1`);
  if (listOf(response, 'vitals').length === 0) {
    const admissions = dataOf(response)?.admissions ?? response?.admissions ?? [];
    if (admissions.length && asText(admissions[0].id) !== episode.admissionId) {
      response = await requestJson('GET', `/vitals/dash/load/${encoded(dfn)}?fromDate=&toDate=&admissionId=${encoded(admissions[0].id)}&range=1`);
    }
  }
  return response;
}

export async function fetchEpisodePatient(dfn, requestedEpisodeId) {
  dfn = clean(dfn);
  const cacheKey = `episode:${dfn}:${requestedEpisodeId}`;
  const cached = readCache(patientCache, cacheKey);
  if (cached) return structuredClone(cached);
  const shell = await fetchPatientShell(dfn);
  const episode = shell.episodes.find((candidate) => candidate.id === requestedEpisodeId);
  if (!episode) throw new SansysError(`Episode ${requestedEpisodeId || '(empty)'} was not found for this patient.`, 404);

  const [notes, labsRaw, radRaw, vitalsRaw, problemsRaw, diagnosisRaw, complaintsRaw, medicationsRaw] = await Promise.all([
    fetchNotes(dfn, episode),
    requestJson('POST', '/lab/list', { dfn, status: '0', visit_id: episode.id, from_date: '', to_date: '' }),
    requestJson('POST', '/rad/cpoe-list', { dfn, status: '0', visit_id: episode.id, from_date: '', to_date: '' }),
    fetchVitals(dfn, episode),
    requestJson('POST', '/problems/dash-list', { dfn, status: '', visit_id: episode.id }),
    requestJson('POST', '/diagnosis/dash/list', { dfn, visit_id: episode.id, duz: DUZ }),
    requestJson('GET', `/chiefcomplaint/dash-list/${encoded(dfn)}?status=1&admissionIen=${encoded(episode.admissionIen)}`),
    requestJson('POST', `/med/list?dfn=${encoded(dfn)}`, { dfn, status: '0', schedule_type: '0', visit_id: episode.id, from_date: '', to_date: '' }),
  ]);

  const noteFacts = factsFromNotes(notes);
  const endpointDiagnoses = mapEndpointList(diagnosisRaw, 'diagnoses', '/diagnosis/dash/list', episode, mapDiagnosis, (item) => item.ien);
  const endpointProblems = mapEndpointList(problemsRaw, 'problems', '/problems/dash-list', episode, mapProblem);
  const endpointComplaints = mapEndpointList(complaintsRaw, 'complaints', '/chiefcomplaint/dash-list/:patientIen', episode, mapComplaint);
  const endpointMedications = mapEndpointList(medicationsRaw, 'orders', '/med/list', episode, mapMedication, (item) => item.medication_ien);
  const endpointLabs = mapEndpointList(labsRaw, 'orders', '/lab/list', episode, mapLab, (item) => item.order_ien);
  const endpointRadiology = mapEndpointList(radRaw, 'orders', '/rad/cpoe-list', episode, mapRadiology, (item) => item.order_ien);
  const episodeVitals = normalizeVitals(vitalsRaw, episode);
  const diagnoses = mergeFacts(endpointDiagnoses, noteFacts.diagnoses, 'diagnoses').sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary));
  const problems = mergeFacts(endpointProblems, noteFacts.problems, 'problems');
  const complaints = mergeFacts(endpointComplaints, noteFacts.complaints, 'complaints');
  const medications = mergeFacts(endpointMedications, noteFacts.medications, 'medications');
  const patient = {
    ...shell,
    episodeId: episode.id,
    episode,
    notes,
    diagnoses,
    problems,
    complaints,
    medications,
    activeMedications: medications.filter((item) => [item.status, ...(item.statuses || [])].some((status) => clean(status).toLowerCase() === 'active')),
    dischargeMedications: medications.filter((item) => [item.status, ...(item.statuses || [])].some((status) => clean(status).toLowerCase() === 'active') && !/(infusion|injection|\binj\b|\biv\b|intraven|vial|ampoule|\bamp\b|dextrose|saline|chemotherapy|dressing)/i.test(`${item.medication} ${item.service} ${item.route}`)),
    allergies: {
      ...shell.allergies,
      items: mergeFacts(shell.allergies.items, noteFacts.allergies, 'allergies'),
    },
    labOrders: mergeFacts(endpointLabs, noteFacts.labOrders, 'labOrders'),
    radOrders: mergeFacts(endpointRadiology, noteFacts.radOrders, 'radOrders'),
    vitals: mergeFacts(episodeVitals, noteFacts.vitals, 'vitals').sort((left, right) => left.dateTime.localeCompare(right.dateTime)),
  };
  return structuredClone(writeCache(patientCache, cacheKey, patient));
}

export async function checkSansysConnection() {
  const started = Date.now();
  await requestJson('GET', '/patientHome/load-demographics/PAT123456?userId=1');
  return { ok: true, elapsedMs: Date.now() - started, baseUrl: BASE_URL };
}
