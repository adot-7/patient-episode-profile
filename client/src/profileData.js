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
