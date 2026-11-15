const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const measurementNames = /^(?:blood pressure|systolic blood pressure|diastolic blood pressure|bp|pulse|pulse rate|heart rate|temperature|temp|respiratory rate|respiration|oxygen saturation|pulse oximetry|spo2|height|weight|pain|pain score)$/i;

export function isVitalMeasurementOrder(order) {
  return measurementNames.test(clean(order?.name ?? order?.itemOrdered));
}

export function recordedVitals(patient) {
  const fromOrders = (patient?.labOrders || []).filter(isVitalMeasurementOrder).flatMap((order) => (order.results || []).map((result) => ({
    dateTime: result.dateTime || order.resultDateTime || '',
    measurements: [{ name: result.name || order.name, value: result.value, unit: result.unit || '' }],
    provenance: result.provenance || order.provenance || [],
  })));
  return [...(patient?.vitals || []), ...fromOrders];
}

function timestamp(value) {
  const parsed = Date.parse(clean(value).replace(/\s*@\s*/, ' '));
  return Number.isFinite(parsed) ? parsed : null;
}

export function vitalParameterRows(records) {
  const latest = new Map();
  for (const record of records || []) {
    const patient = record?.patient || record;
    if (!patient) continue;
    for (const vital of recordedVitals(patient)) for (const measurement of vital.measurements || []) {
      const name = clean(measurement.name);
      const value = clean(measurement.value);
      if (!name || !value || /^not entered$/i.test(value)) continue;
      const unit = clean(measurement.unit);
      const key = `${name.toLowerCase()}|${unit}`;
      const time = timestamp(vital.dateTime);
      const previous = latest.get(key);
      if (!previous || (time !== null && (previous.timestamp === null || time >= previous.timestamp)) || (time === null && previous.timestamp === null)) {
        latest.set(key, { name, value, unit, dateTime: vital.dateTime || '', timestamp: time, episodeId: patient.episodeId || patient.episode?.id || '' });
      }
    }
  }
  return [...latest.values()];
}

export function vitalParameterLines(records) {
  return vitalParameterRows(records).map((row) => `${row.name}: ${row.value}${row.unit ? ` ${row.unit}` : ' (unit not supplied)'} · ${row.dateTime || 'Date not recorded'}${row.episodeId ? ` · episode ${row.episodeId}` : ''}`);
}

export function mentionsVitalParameters(text) {
  return /\b(?:vitals|vital signs|vital parameters)\b|\b(?:blood pressure|bp|systolic(?: blood)? pressure|diastolic(?: blood)? pressure|systolic|diastolic|pulse oximetry|pulse(?: rate)?|heart rate|temperature|respiratory rate|respiration|spo2|oxygen saturation|weight|height|pain score)\b\s*(?:[:=]|\d|(?:was|is|of|at|ranged|ranges|recorded|values|measurements|from|dropped|rose|fell|increased|decreased|fluctuated|orders?)\b)/i.test(text);
}
