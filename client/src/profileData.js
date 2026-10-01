const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const keyOf = (...values) => values.map((value) => clean(value).toLocaleLowerCase()).join('|');

function sortedUnique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function provenanceFor(fact) {
  return Array.isArray(fact?.provenance) ? fact.provenance : [];
}

function episodeDate(patient) {
  return patient?.episode?.startDate || patient?.episode?.label || '';
}

export function buildPatientProfile(episodeRecords) {
  const conditions = new Map();
  const medications = new Map();
  const allergies = new Map();
  const vitalReadings = [];

  for (const record of episodeRecords || []) {
    const patient = record?.patient;
    if (!patient) continue;
    const episodeId = patient.episodeId || patient.episode?.id || '';
    const date = episodeDate(patient);

    for (const diagnosis of patient.diagnoses || []) {
      const label = clean(diagnosis.diagnosis);
      if (!label) continue;
      const key = keyOf(label);
      const item = conditions.get(key) || { label, kind: 'Diagnosis', hasDiagnosis: false, hasProblem: false, primary: false, episodes: [], statuses: [], dates: [], provenance: [] };
      item.hasDiagnosis = true;
      item.kind = item.hasProblem ? 'Diagnosis and problem' : 'Diagnosis';
      item.primary ||= diagnosis.isPrimary === true;
      if (episodeId && !item.episodes.some((episode) => episode.id === episodeId)) item.episodes.push({ id: episodeId, date });
      if (diagnosis.dateEntered) item.dates.push(diagnosis.dateEntered);
      item.provenance.push(...provenanceFor(diagnosis));
      conditions.set(key, item);
    }
    for (const problem of patient.problems || []) {
      const label = clean(problem.problem);
      if (!label) continue;
      const key = keyOf(label);
      const item = conditions.get(key) || { label, kind: 'Problem', hasDiagnosis: false, hasProblem: false, primary: false, episodes: [], statuses: [], dates: [], provenance: [] };
      item.hasProblem = true;
      item.kind = item.hasDiagnosis ? 'Diagnosis and problem' : 'Problem';
      if (episodeId && !item.episodes.some((episode) => episode.id === episodeId)) item.episodes.push({ id: episodeId, date });
      if (problem.status) item.statuses.push(problem.status);
      if (problem.dateOnset) item.dates.push(problem.dateOnset);
      item.provenance.push(...provenanceFor(problem));
      conditions.set(key, item);
    }

    for (const medication of patient.medications || []) {
      const name = clean(medication.medication);
      if (!name) continue;
      const route = clean(medication.route);
      const key = keyOf(name, route);
      const item = medications.get(key) || {
        name,
        route,
        schedules: [],
        statuses: [],
        starts: [],
        stops: [],
        episodes: [],
        provenance: [],
      };
      item.schedules.push(medication.schedule, medication.scheduleType);
      item.statuses.push(medication.status, ...(Array.isArray(medication.statuses) ? medication.statuses : []));
      item.starts.push(medication.startDate);
      item.stops.push(medication.stopDate);
      if (episodeId && !item.episodes.some((episode) => episode.id === episodeId)) item.episodes.push({ id: episodeId, date });
      item.provenance.push(...provenanceFor(medication));
      medications.set(key, item);
    }

    for (const allergy of patient.allergies?.items || []) {
      const label = clean(allergy.allergy);
      if (!label) continue;
      const key = keyOf(label, allergy.reaction, allergy.symptoms);
      const item = allergies.get(key) || { ...allergy, episodes: [], provenance: [] };
      if (episodeId && !item.episodes.includes(episodeId)) item.episodes.push(episodeId);
      item.provenance.push(...provenanceFor(allergy));
      allergies.set(key, item);
    }

    for (const vital of patient.vitals || []) {
      for (const measurement of vital.measurements || []) {
        const value = Number(String(measurement.value ?? '').replace(',', '.'));
        const name = clean(measurement.name);
        const normalizedName = name.toLocaleLowerCase();
        const bp = String(measurement.value ?? '').match(/^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
        if (/blood pressure|\bbp\b/.test(normalizedName) && bp) {
          vitalReadings.push({ name: 'Systolic blood pressure', value: Number(bp[1]), unit: 'mmHg', dateTime: vital.dateTime, episodeId });
          vitalReadings.push({ name: 'Diastolic blood pressure', value: Number(bp[2]), unit: 'mmHg', dateTime: vital.dateTime, episodeId });
        } else if (Number.isFinite(value)) {
          const metric = metricName(normalizedName);
          if (metric) vitalReadings.push({ name: metric, value, unit: clean(measurement.unit), dateTime: vital.dateTime, episodeId });
        }
      }
    }
  }

  return {
    conditions: [...conditions.values()].map(({ hasDiagnosis, hasProblem, ...item }) => ({
      ...item,
      episodes: item.episodes.sort((a, b) => String(a.date).localeCompare(String(b.date))),
      statuses: sortedUnique(item.statuses),
      dates: sortedUnique(item.dates),
    })).sort((a, b) => Number(b.primary) - Number(a.primary) || a.label.localeCompare(b.label)),
    medications: [...medications.values()].map((item) => ({
      ...item,
      schedules: sortedUnique(item.schedules),
      statuses: sortedUnique(item.statuses),
      starts: sortedUnique(item.starts).sort(),
      stops: sortedUnique(item.stops).sort(),
      episodes: item.episodes.sort((a, b) => String(a.date).localeCompare(String(b.date))),
    })).sort((a, b) => a.name.localeCompare(b.name)),
    allergies: [...allergies.values()],
    vitalReadings: vitalReadings.sort((a, b) => String(a.dateTime).localeCompare(String(b.dateTime))),
  };
}

function metricName(name) {
  if (/temperature|\btemp\b/.test(name)) return 'Temperature';
  if (/pulse oximetry|oxygen saturation|spo2|o2 sat/.test(name)) return 'Oxygen saturation';
  if (/\bpulse\b|heart rate/.test(name)) return 'Pulse';
  if (/respiratory rate|\brespiration\b/.test(name)) return 'Respiratory rate';
  if (/weight/.test(name)) return 'Weight';
  return '';
}

export function episodeSnapshot(patient) {
  const diagnoses = (patient?.diagnoses || []).map((item) => clean(item.diagnosis)).filter(Boolean);
  const complaints = (patient?.complaints || []).map((item) => clean(item.name)).filter(Boolean);
  return {
    diagnosisCount: new Set(diagnoses.map((name) => name.toLocaleLowerCase())).size,
    diagnoses: sortedUnique(diagnoses),
    complaints: sortedUnique(complaints),
    noteCount: patient?.notes?.length || 0,
    medicationCount: patient?.medications?.length || 0,
    labOrderCount: patient?.labOrders?.length || 0,
    radiologyOrderCount: patient?.radOrders?.length || 0,
  };
}

export function longitudinalSummary(records, profile) {
  const chronological = [...(records || [])].sort((left, right) => (
    String(left.patient?.episode?.startDate || '').localeCompare(String(right.patient?.episode?.startDate || ''))
  ));
  const valid = chronological.filter((record) => record.patient);
  if (!valid.length) return [{ label: 'Episode history', value: 'No inpatient episode data is available to summarize.' }];

  const dates = valid.map((record) => record.patient.episode?.startDate).filter(Boolean).sort();
  const span = dates.length
    ? dates.length === 1 ? shortDate(dates[0]) : `${shortDate(dates[0])} to ${shortDate(dates.at(-1))}`
    : 'dates not recorded';
  const primaryDiagnoses = valid.map(({ patient }) => {
    const diagnosis = patient.diagnoses?.find((item) => item.isPrimary) || patient.diagnoses?.[0];
    return diagnosis?.diagnosis ? `${patient.episode?.startDate ? `${shortDate(patient.episode.startDate)}: ` : ''}${clean(diagnosis.diagnosis)}` : '';
  }).filter(Boolean);
  const primaryLabels = new Set(primaryDiagnoses.map((item) => item.replace(/^.*?: /, '').toLocaleLowerCase()));
  const diagnosesText = primaryDiagnoses.length
    ? `Primary diagnoses recorded: ${sortedUnique(primaryDiagnoses).slice(0, 3).join('; ')}.`
    : 'No primary diagnoses are marked in the available episode records.';
  const conditions = profile.conditions.filter((condition) => !primaryLabels.has(condition.label.toLocaleLowerCase())).slice(0, 4).map((condition) => condition.label);
  const conditionsText = conditions.length
    ? `Additional diagnoses/problems recorded: ${conditions.join('; ')}${profile.conditions.length - conditions.length - primaryLabels.size > 0 ? `, plus ${profile.conditions.length - conditions.length - primaryLabels.size} more` : ''}.`
    : 'No additional diagnosis/problem entries were returned.';
  const medicationStatuses = sortedUnique(profile.medications.flatMap((medication) => medication.statuses));
  const medicationText = profile.medications.length
    ? `${profile.medications.length} distinct medication name/route entries; recorded statuses: ${medicationStatuses.join(', ') || 'not recorded'}.`
    : 'No medication records were returned for the loaded episodes.';

  return [
    { label: 'Episode history', value: `${valid.length} inpatient episode${valid.length === 1 ? '' : 's'} · ${span}` },
    { label: 'Primary diagnoses', value: diagnosesText },
    { label: 'Other recorded conditions', value: conditionsText },
    { label: 'Medication history', value: medicationText },
  ];
}

function noteCourseEvents(notes) {
  const relevantLabel = /^(?!pain\b)(assessment|impression|progress|course|plan|treatment|management|discharge|response|condition at discharge|clinical status|follow[\s-]?up)/i;
  const candidates = [];
  for (const note of notes || []) {
    const excerpts = (note.content || []).filter((line) => {
      const separator = String(line).indexOf(':');
      const label = separator > 0 ? String(line).slice(0, separator) : String(line);
      return relevantLabel.test(label) && String(line).length > 12;
    });
    if (!excerpts.length) continue;
    for (const text of sortedUnique(excerpts).slice(0, 2)) candidates.push({ date: note.dateOfEntry || '', text });
  }
  return candidates;
}

function presentationNoteLines(notes) {
  const pattern = /^(history of present illness|clinical history|presenting complaints|chief complaint|onset|symptoms)/i;
  const lines = [];
  for (const note of notes || []) {
    for (const line of note.content || []) {
      const separator = String(line).indexOf(':');
      if (separator <= 0 || !pattern.test(String(line).slice(0, separator).trim())) continue;
      const answer = String(line).slice(separator + 1).trim();
      if (answer) lines.push(`${note.dateOfEntry ? `${note.dateOfEntry}: ` : ''}${answer}`);
    }
  }
  return sortedUnique(lines).slice(0, 2);
}

function episodeMedicationLines(medications) {
  const groups = new Map();
  for (const medication of medications || []) {
    const name = clean(medication.medication);
    if (!name) continue;
    const key = keyOf(name, medication.route);
    const item = groups.get(key) || { name, route: clean(medication.route), statuses: [], schedules: [], starts: [], stops: [] };
    item.statuses.push(medication.status, ...(Array.isArray(medication.statuses) ? medication.statuses : []));
    item.schedules.push(medication.schedule, medication.scheduleType);
    item.starts.push(medication.startDate);
    item.stops.push(medication.stopDate);
    groups.set(key, item);
  }
  const ordered = [...groups.values()].map((item) => ({
    ...item,
    statuses: sortedUnique(item.statuses),
    schedules: sortedUnique(item.schedules),
    starts: sortedUnique(item.starts),
    stops: sortedUnique(item.stops),
  })).sort((left, right) => (
    Number(right.statuses.some((status) => status.toLowerCase() === 'active'))
      - Number(left.statuses.some((status) => status.toLowerCase() === 'active'))
    || left.name.localeCompare(right.name)
  ));
  return ordered.slice(0, 6).map((item) => [
    item.name,
    item.route,
    item.statuses.length ? `status: ${item.statuses.join(', ')}` : '',
    item.schedules.join(', '),
    item.starts.length ? `start: ${item.starts.join(', ')}` : '',
    item.stops.length ? `stop: ${item.stops.join(', ')}` : '',
  ].filter(Boolean).join(' · '));
}

function investigationLines(items, labelKey, dateKey) {
  const orders = items || [];
  const lines = orders.map((item) => [
    clean(item[labelKey]),
    clean(item.status),
    dateKey ? clean(item[dateKey]) : '',
  ].filter(Boolean).join(' · ')).filter((line) => line.replace(/[^a-z0-9]/gi, '')).slice(0, 4);
  return lines;
}

function latestVitalLine(patient) {
  const vital = patient?.vitals?.at(-1);
  const values = (vital?.measurements || [])
    .map((measurement) => `${clean(measurement.name)} ${clean(measurement.value)}${measurement.unit ? ` ${clean(measurement.unit)}` : ''}`)
    .filter(Boolean);
  return values.length ? `${vital.dateTime || 'Date not recorded'}: ${values.join(' · ')}` : '';
}

function episodeDateKey(value) {
  const text = clean(value);
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime())
    ? text.split(/\s+/).slice(0, 3).join(' ')
    : `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
}

function episodeCourseLines(patient) {
  const byDate = new Map();
  const add = (date, event) => {
    const key = episodeDateKey(date);
    if (!key || !event) return;
    const entries = byDate.get(key) || [];
    if (!entries.includes(event)) entries.push(event);
    byDate.set(key, entries);
  };

  for (const diagnosis of patient?.diagnoses || []) {
    if (diagnosis.dateEntered && diagnosis.diagnosis) add(diagnosis.dateEntered, `Diagnosis recorded: ${clean(diagnosis.diagnosis)}`);
  }
  for (const medication of patient?.medications || []) {
    const name = clean(medication.medication);
    if (!name) continue;
    const status = clean(medication.status);
    if (medication.startDate) add(medication.startDate, `Medication started: ${name}${status ? ` (${status})` : ''}`);
    if (medication.stopDate) add(medication.stopDate, `Medication stop date: ${name}${status ? ` (${status})` : ''}`);
  }
  for (const order of patient?.labOrders || []) {
    if (order.orderDateTime && order.name) add(order.orderDateTime, `Lab order: ${clean(order.name)}${order.status ? ` (${clean(order.status)})` : ''}`);
  }
  for (const order of patient?.radOrders || []) {
    if (order.dateTime && order.procedure) add(order.dateTime, `Imaging order: ${clean(order.procedure)}${order.status ? ` (${clean(order.status)})` : ''}`);
  }
  for (const note of noteCourseEvents(patient?.notes)) {
    add(note.date, note.text);
  }

  const dates = [...byDate.keys()].sort((left, right) => {
    const leftTime = Date.parse(left);
    const rightTime = Date.parse(right);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
    return left.localeCompare(right);
  });
  const selectedDates = dates.length <= 6
    ? dates
    : [...new Set(Array.from({ length: 6 }, (_, index) => Math.round(index * (dates.length - 1) / 5)))].map((index) => dates[index]);
  return selectedDates.map((date) => {
    const events = byDate.get(date);
    const summary = events.slice(0, 3).join('; ');
    const remainder = events.length > 3 ? `; ${events.length - 3} additional entries` : '';
    return `${shortDate(date)} · ${summary}${remainder}`;
  });
}

export function episodeReport(patient) {
  const complaintGroups = new Map();
  for (const complaint of patient?.complaints || []) {
    const name = clean(complaint.name);
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    const item = complaintGroups.get(key) || { name, type: complaint.type, remarks: [] };
    if (/^chief complaint$/i.test(complaint.type || '')) item.type = 'Chief Complaint';
    const remark = clean(complaint.remark);
    if (remark && !item.remarks.includes(remark)) item.remarks.push(remark);
    complaintGroups.set(key, item);
  }
  const complaints = [...complaintGroups.values()]
    .sort((left, right) => Number(/^chief complaint$/i.test(right.type || '')) - Number(/^chief complaint$/i.test(left.type || '')))
    .slice(0, 3)
    .map((item) => `${item.name}${item.remarks.length ? ` — ${item.remarks.slice(0, 2).join('; ')}` : ''}${item.remarks.length > 2 ? '; further remarks in episode details' : ''}`);
  const presentation = [...new Set([...complaints, ...presentationNoteLines(patient?.notes)])].slice(0, 5);

  const diagnosisLines = [];
  const diagnosisKeys = new Set();
  for (const diagnosis of patient?.diagnoses || []) {
    const label = clean(diagnosis.diagnosis);
    const key = label.toLocaleLowerCase();
    if (!label || diagnosisKeys.has(key)) continue;
    diagnosisKeys.add(key);
    diagnosisLines.push(`${diagnosis.isPrimary ? 'Primary diagnosis' : 'Diagnosis'}: ${label}`);
  }
  for (const problem of patient?.problems || []) {
    const label = clean(problem.problem);
    const key = label.toLocaleLowerCase();
    if (!label || diagnosisKeys.has(key)) continue;
    diagnosisKeys.add(key);
    diagnosisLines.push(`Problem: ${label}${problem.status ? ` · ${clean(problem.status)}` : ''}`);
  }
  const diagnosesAndProblems = diagnosisLines.slice(0, 6);

  const allergyGroups = new Map();
  for (const allergy of patient?.allergies?.items || []) {
    const name = clean(allergy.allergy);
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    const item = allergyGroups.get(key) || { name, details: [] };
    for (const detail of [clean(allergy.reaction), clean(allergy.symptoms)].filter(Boolean)) {
      if (!item.details.includes(detail)) item.details.push(detail);
    }
    allergyGroups.set(key, item);
  }
  const allergies = [...allergyGroups.values()].slice(0, 4).map((item) => (
    `${item.name}${item.details.length ? ` · ${item.details.join('; ')}` : ''}`
  ));

  const course = episodeCourseLines(patient);
  const medications = episodeMedicationLines(patient?.medications);
  const labLines = investigationLines(patient?.labOrders, 'name', 'orderDateTime');
  const radiologyLines = investigationLines(patient?.radOrders, 'procedure', 'dateTime');
  const investigations = [
    ...labLines.map((line) => `Laboratory: ${line}`),
    ...radiologyLines.map((line) => `Radiology: ${line}`),
  ];
  const latestVital = latestVitalLine(patient);

  return [
    { key: 'presentation', title: 'Presentation', lines: presentation },
    { key: 'diagnoses', title: 'Diagnoses and problems', lines: diagnosesAndProblems },
    { key: 'allergies', title: 'Allergies', lines: allergies.length ? allergies : (clean(patient?.allergies?.status) ? [clean(patient.allergies.status)] : []) },
    { key: 'course', title: 'Course and dated events', lines: course },
    { key: 'medications', title: 'Treatment / medication course', lines: medications },
    { key: 'investigations', title: 'Investigations', lines: investigations },
    { key: 'observations', title: 'Latest observations', lines: latestVital ? [latestVital] : [] },
  ].filter((section) => section.lines.length > 0);
}

export function shortDate(value) {
  if (!value) return 'Date not recorded';
  const isoDate = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const date = isoDate
    ? new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]))
    : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

export function metricSeries(readings, metric) {
  return (readings || []).filter((reading) => reading.name === metric);
}
