const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function sourceDate(value) {
  const text = clean(value).replace(/@/g, ' ').replace(/,/g, '');
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return '';
  const date = new Date(parsed);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function problemName(value) {
  return clean(value).replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function brand(value) {
  const name = clean(value).toLowerCase();
  const first = name.match(/\b\d*[a-z][a-z0-9-]*/i)?.[0] || '';
  return /^(fixture|recorded|example|test)$/.test(first) ? name : first;
}

export function datesFromText(value) {
  const matches = String(value || '').match(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\s+[a-z]{3,4}\s+\d{4}\b/gi) || [];
  return matches.map(sourceDate).filter(Boolean);
}

export function sourceClaimIssues(sections, patients) {
  const issues = [];
  const problems = patients.flatMap((patient) => patient.problems || []);
  const medications = patients.flatMap((patient) => patient.medications || []);
  const notesPresent = patients.some((patient) => patient.notes?.some((note) => note.content?.length));
  const resultsPresent = patients.some((patient) => patient.labOrders?.some((order) => order.results?.length));
  const primaryPresent = patients.some((patient) => patient.diagnoses?.some((item) => item.isPrimary));
  const vitalDates = new Set(patients.flatMap((patient) => patient.vitals || []).map((vital) => sourceDate(vital.dateTime)).filter(Boolean));
  const remarks = new Map();
  for (const complaint of patients.flatMap((patient) => patient.complaints || [])) {
    const remark = clean(complaint.remark).replace(/^patient (?:looks|is|has had|reports)\s*/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    const date = sourceDate(complaint.date);
    if (remark.length < 12 || !date) continue;
    if (!remarks.has(remark)) remarks.set(remark, new Set());
    remarks.get(remark).add(date);
  }
  const pressureValues = new Set(patients.flatMap((patient) => patient.vitals || []).flatMap((vital) => vital.measurements || [])
    .filter((measurement) => /blood pressure|\bbp\b/i.test(measurement.name || ''))
    .map((measurement) => clean(measurement.value)));
  const eventDates = new Set(patients.flatMap((patient) => [
    patient.episode?.startDate,
    ...(patient.diagnoses || []).map((item) => item.dateEntered),
    ...(patient.problems || []).map((item) => item.dateOnset),
    ...(patient.complaints || []).map((item) => item.date),
    ...(patient.medications || []).flatMap((item) => [item.startDate, item.stopDate]),
    ...(patient.labOrders || []).flatMap((item) => [item.orderDateTime, ...(item.results || []).map((result) => result.dateTime)]),
    ...(patient.radOrders || []).map((item) => item.dateTime),
    ...(patient.vitals || []).map((item) => item.dateTime),
    ...(patient.notes || []).map((item) => item.dateOfEntry),
  ]).map(sourceDate).filter(Boolean));
  const statuses = new Map();
  for (const item of problems) {
    const name = problemName(item.problem);
    if (!name) continue;
    if (!statuses.has(name)) statuses.set(name, new Set());
    statuses.get(name).add(clean(item.status).toUpperCase());
  }
  const orders = new Map();
  for (const item of medications) {
    const key = brand(item.medication);
    if (!key) continue;
    if (!orders.has(key)) orders.set(key, []);
    orders.get(key).push(item);
  }
  for (const section of sections) {
    for (const item of section.items) {
      if (!notesPresent && !primaryPresent && /\bprimary diagnosis\s*(?:is|was|:)/i.test(item) && !/no primary|not recorded|not marked/i.test(item)) issues.push('No primary diagnosis is marked in the supplied episode sources. Do not promote a problem-list entry into a primary diagnosis.');
      if (!notesPresent && !resultsPresent && ['Investigations', 'Condition and investigation trends'].includes(section.title)
        && /\b(?:platelets?|haemoglobin|hemoglobin|HbA1c|creatinine|sodium|potassium|glucose|TSH|bilirubin|urea|WBC)\s*(?:was|were|is|of|at|:|=)?\s*\d/i.test(item)) issues.push('No laboratory result values are supplied; do not invent a numerical lab result from an order.');
      if (!notesPresent && /\b(?:active since|became active|reactivated|problem list updated|status changed)\b/i.test(item)) {
        issues.push('Problem onset dates do not establish when status changed or when a condition became active.');
      }
      const labels = [...item.matchAll(/\b(INACTIVE|REMOVED|ACTIVE)\b/gi)];
      for (const [name, recordedStatuses] of statuses) {
        if (recordedStatuses.has('ACTIVE') || name.length < 5) continue;
        const match = new RegExp(`\\b${escape(name)}\\b`, 'i').exec(item);
        if (!match) continue;
        const before = labels.filter((label) => label.index < match.index).at(-1);
        const after = labels.find((label) => label.index > match.index && label.index - match.index - name.length < 35);
        const status = after && /^\s*(?:[(:–—-]|is\b|was\b|marked\b|status\b|recorded\b)/i.test(item.slice(match.index + name.length, after.index)) ? after[0] : before?.[0];
        if (status?.toUpperCase() === 'ACTIVE') issues.push(`${name} is only recorded as ${[...recordedStatuses].join('/')} in these sources; do not call it ACTIVE or expand another problem into it.`);
      }
      const dates = datesFromText(item);
      const vitalsAbsent = /\bno\b.*\bvital|\bvitals? (?:are |were )?not\b/i.test(item);
      if (!vitalsAbsent && dates.length && /\bvitals?|vital signs|recorded measurements\b/i.test(item) && dates.some((date) => !vitalDates.has(date))) issues.push('The cited date range for vital observations includes a date with no supplied vital measurement; do not use laboratory/radiology order dates as vital dates.');
      const compactItem = item.replace(/[^a-z0-9]/gi, '').toLowerCase();
      for (const [remark, recordedDates] of remarks) {
        if (dates.length && compactItem.includes(remark) && !dates.some((date) => recordedDates.has(date))) issues.push('A complaint remark is assigned to the wrong date; keep each dated complaint and its own remark together.');
      }
      if (!notesPresent && dates.length && /\b(?:active|inactive|removed)\b/i.test(item) && /problem status (?:noted|recorded)|status (?:noted|recorded) on/i.test(item) && !/\bonset\b/i.test(item)) issues.push('The problem date is an onset date, not the date that a status was noted. Label the date as onset.');
      if (section.title === 'Dated clinical timeline' && dates.length && !eventDates.has(dates[0])) issues.push(`Timeline date ${dates[0]} has no supplied source event; scope-window boundaries are not clinical events.`);
      const mentionedOrders = [...orders].filter(([key]) => key.length >= 4 && new RegExp(`\\b${escape(key)}\\b`, 'i').test(item));
      for (const [key, records] of orders) {
        if (key.length < 4 || !new RegExp(`\\b${escape(key)}\\b`, 'i').test(item)) continue;
        const allowed = new Set(records.flatMap((record) => [sourceDate(record.startDate), sourceDate(record.stopDate)]).filter(Boolean));
        if (dates.length && allowed.size && !dates.some((date) => allowed.has(date))) issues.push(`${key} has no order start/stop date matching the cited event; use its actual recorded order date, not the episode start.`);
        if (section.title === 'Medication course' && !dates.length && allowed.size) issues.push(`Include a recorded start/stop date for ${key} in Medication course.`);
        if (['Medication course', 'Key Medications'].includes(section.title) && mentionedOrders.length === 1) {
          const allowedStatuses = new Set(records.map((record) => clean(record.status).toUpperCase()).filter(Boolean));
          const claimedStatuses = item.match(/\b(?:ACTIVE|PENDING|UNRELEASED|DISCONTINUED|COMPLETED|HOLD)\b/gi) || [];
          if (allowedStatuses.size && claimedStatuses.some((status) => !allowedStatuses.has(status.toUpperCase()))) issues.push(`${key} order status must be copied from ${[...allowedStatuses].join('/')}, not inferred.`);
        }
      }
      for (const pressure of item.match(/\b\d{2,3}\/\d{2,3}\b/g) || []) {
        if (!pressureValues.has(pressure)) issues.push(`Blood pressure ${pressure} is not a supplied measurement.`);
      }
    }
  }
  return [...new Set(issues)];
}

export function sourceAvailability(patients) {
  const ranges = new Map();
  for (const patient of patients) for (const vital of patient.vitals || []) for (const measurement of vital.measurements || []) {
    const raw = clean(measurement.value);
    const bp = /blood pressure|\bbp\b/i.test(measurement.name || '') && raw.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
    const values = bp ? [['Systolic blood pressure', Number(bp[1]), 'mmHg'], ['Diastolic blood pressure', Number(bp[2]), 'mmHg']]
      : /^[-+]?\d+(?:\.\d+)?$/.test(raw) ? [[measurement.name, Number(raw), measurement.unit || '']] : [];
    for (const [name, value, unit] of values) {
      const key = `${name}|${unit}`;
      const range = ranges.get(key) || { name, unit, minimum: value, maximum: value, count: 0 };
      range.minimum = Math.min(range.minimum, value);
      range.maximum = Math.max(range.maximum, value);
      range.count += 1;
      ranges.set(key, range);
    }
  }
  return {
    episodes: patients.map((patient) => ({ episodeId: patient.episodeId || patient.episode?.id, visitType: patient.episode?.visitType, episodeStartDate: patient.episode?.startDate, primaryDiagnoses: (patient.diagnoses || []).filter((item) => item.isPrimary).map((item) => item.diagnosis), complaintCount: patient.complaints?.length || 0, noteCount: patient.notes?.filter((note) => note.content?.length).length || 0, labResultValueCount: (patient.labOrders || []).reduce((sum, order) => sum + (order.results?.length || 0), 0), observedVitalDateRange: [...new Set((patient.vitals || []).map((vital) => sourceDate(vital.dateTime)).filter(Boolean))].sort().filter((_, index, array) => index === 0 || index === array.length - 1) })),
    problemDateMeaning: 'dateOnset is an onset date only. The date when a listed status became ACTIVE/INACTIVE/REMOVED is not supplied. Conflicting snapshots are not a documented status transition.',
    primaryDiagnosisMeaning: 'An empty primaryDiagnoses list means no primary diagnosis is marked. Do not promote a problem-list entry or medication indication into a primary diagnosis.',
    medicationDateMeaning: 'Use each medication order startDate/stopDate and its own status. An episode start date is not the date of every medication in that episode. Administration is not established by these orders.',
    observedNumericVitalRanges: [...ranges.values()],
  };
}

export function validateSourceClaims(sections, patients) {
  const issues = sourceClaimIssues(sections, patients);
  if (issues.length) throw Object.assign(new Error(`AI source-check failed: ${issues.slice(0, 3).join(' ')}`), { status: 502, code: 'UNSUPPORTED_AI_CLAIM' });
}
