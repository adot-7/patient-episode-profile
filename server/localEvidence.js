const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

function dated(value) {
  const text = clean(value).replace(/@/g, ' ').replace(/,/g, '');
  if (!text) return '';
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
  if (iso) return `${iso[1]}${iso[2] ? ` ${iso[2]}` : ''}`;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return '';
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const time = text.match(/\b\d{1,2}:\d{2}\b/)?.[0];
  return `${day}${time ? ` ${time.padStart(5, '0')}` : ''}`;
}

function evenly(items, limit) {
  if (items.length <= limit) return items;
  return Array.from({ length: limit }, (_, index) => items[Math.round(index * (items.length - 1) / (limit - 1))]);
}

// A small local model ranks recorded evidence. It is never allowed to invent prose,
// replace dates/values, or convert a background problem into a presenting complaint.
export function buildLocalEvidence(patients, headings) {
  const longitudinal = headings.includes('Overall clinical story');
  const options = Object.fromEntries(headings.map((heading) => [heading, []]));
  const evidence = new Map();
  const duplicateIds = new Map();
  const episodeAnchors = [];
  const labSeries = new Map();
  const trendIds = [];
  const main = longitudinal ? 'Overall clinical story' : 'Presentation';
  const course = longitudinal ? 'Dated clinical timeline' : 'Hospital Course';
  const diagnoses = longitudinal ? 'Condition and investigation trends' : 'Diagnoses and Problems';
  const medications = longitudinal ? 'Medication course' : 'Key Medications';
  const investigations = longitudinal ? diagnoses : 'Investigations';
  const monitoring = longitudinal ? 'Monitoring considerations' : 'Follow-up / Open Items';

  function add(patient, date, text, targets, kind = '') {
    const timestamp = dated(date);
    const episodeId = patient.episodeId || patient.episode?.id || 'not recorded';
    const prefix = `${timestamp || 'Date not recorded'} · episode ${episodeId}: `;
    const full = prefix + clean(text);
    const rendered = full.length > 340 ? `${full.slice(0, 320).replace(/\s+\S*$/, '')}… [source excerpt]` : full;
    const key = `${episodeId}|${timestamp.slice(0, 10)}|${clean(text).toLowerCase()}`;
    const id = duplicateIds.get(key) || `F${evidence.size + 1}`;
    if (!evidence.has(id)) evidence.set(id, { text: rendered, timestamp, episodeId, kind });
    duplicateIds.set(key, id);
    for (const target of targets) if (options[target] && !options[target].includes(id)) options[target].push(id);
    return id;
  }

  for (const patient of patients) {
    const episode = patient.episode || {};
    const anchor = add(patient, episode.startDate, `${episode.visitType || 'Recorded'} episode recorded${episode.label ? ` · ${episode.label}` : ''}.`, longitudinal ? [main, course] : [], 'episode');
    episodeAnchors.push(anchor);
    for (const item of evenly(patient.complaints || [], 10)) {
      // Keep placeholder/test entries in the source record, but not as clinical highlights.
      if (/^(test|testing|good one|dummy|asdf|not entered|n\/?a)$/i.test(clean(item.name))) continue;
      add(patient, item.date, `Recorded complaint: ${item.name}${item.remark ? ` · ${item.remark}` : ''}`, [main, course]);
    }
    for (const item of (patient.diagnoses || []).slice(0, 12)) {
      add(patient, item.dateEntered, `${item.isPrimary ? 'Primary diagnosis' : 'Diagnosis'} recorded: ${item.diagnosis}`, [main, diagnoses, course]);
    }
    for (const item of (patient.problems || []).slice(0, 20)) {
      const fact = `Problem: ${item.problem} · recorded status ${item.status || 'not supplied'}${item.dateOnset ? ' · date shown is onset, not a status-change date' : ''}`;
      add(patient, item.dateOnset, fact, [diagnoses]);
      if (/^active$/i.test(item.status || '')) add(patient, item.dateOnset, `For clinician review: ${fact}. Current state requires confirmation.`, [monitoring]);
    }
    for (const item of evenly(patient.medications || [], 12)) {
      add(patient, item.startDate, `Medication order: ${item.medication} · ${item.schedule || 'schedule not supplied'} · ${item.status || 'status not supplied'}${item.stopDate ? ` · stop date ${item.stopDate}` : ''}. Administration not established.`, [medications, course], 'medication');
    }
    const labs = [...(patient.labOrders || [])].sort((left, right) => Number(Boolean(right.results?.length)) - Number(Boolean(left.results?.length)));
    for (const order of labs.slice(0, 12)) {
      if (!order.results?.length) {
        add(patient, order.orderDateTime, `Laboratory order: ${order.name} · ${order.status || 'status not supplied'} · result values not supplied.`, [investigations, course]);
      }
      for (const result of (order.results || []).slice(0, 12)) {
        const key = `${clean(result.name || order.name).toLowerCase()}|${clean(result.unit)}`;
        if (dated(result.dateTime) && /^[-+]?\d+(?:,\d{3})*(?:\.\d+)?$/.test(clean(result.value))) {
          if (!labSeries.has(key)) labSeries.set(key, []);
          labSeries.get(key).push({ patient, result, name: result.name || order.name, timestamp: dated(result.dateTime) });
        }
        add(patient, result.dateTime, `Laboratory result: ${result.name || order.name} ${result.value}${result.unit ? ` ${result.unit}` : ''}${result.referenceRange ? ` · reference ${result.referenceRange}` : ''}${result.flag ? ` · flag ${result.flag}` : ''}`, [investigations, main, course]);
        if (result.flag) add(patient, result.dateTime, `For clinician review: recorded ${result.name || order.name} ${result.value} ${result.unit || ''} · source flag ${result.flag}. This is a historical result.`, [monitoring]);
      }
    }
    for (const item of evenly(patient.vitals || [], 10)) {
      const values = (item.measurements || []).map((measurement) => `${measurement.name}: ${measurement.value}${measurement.unit ? ` ${measurement.unit}` : ''}`).join('; ');
      if (values) add(patient, item.dateTime, `Recorded measurements: ${values}`, [investigations, course]);
    }
    for (const note of (patient.notes || []).slice(0, 8)) {
      for (const line of (note.content || []).filter((line) => /^(assessment|progress|course|plan|treatment|discharge|follow[- ]?up|history of present illness|chief complaint)\s*:/i.test(line)).slice(0, 3)) {
        const targets = [course];
        if (/^(history of present illness|chief complaint)/i.test(line)) targets.push(main);
        if (/^(plan|follow[- ]?up)/i.test(line)) targets.push(monitoring);
        add(patient, note.dateOfEntry, `${note.title || 'Clinical note'} · ${line}`, targets);
      }
    }
    if (longitudinal) for (const item of (patient.backgroundHistory || []).slice(0, 12)) {
      add(patient, item.date, `${item.category}: ${item.label} · ${item.value} · ${item.noteTitle || 'Clinical note'}`, ['Recorded background']);
    }
  }

  for (const series of labSeries.values()) {
    const ordered = [...new Map(series.map((item) => [`${item.timestamp}|${item.result.value}`, item])).values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    if (ordered.length < 2) continue;
    const selected = evenly(ordered, 3);
    const text = `Recorded ${selected[0].name} results: ${selected.map((item) => `${item.result.value} ${item.result.unit || ''} (${item.timestamp})`).join(' → ')}. No clinical outcome inferred.`;
    const id = add(selected.at(-1).patient, selected.at(-1).result.dateTime, text, [diagnoses, main], 'lab-trend');
    trendIds.push(id);
  }

  for (const title of headings) {
    if (title === 'Dated clinical timeline') options[title] = options[title].filter((id) => evidence.get(id).timestamp);
    options[title] = evenly(options[title], title === 'Dated clinical timeline' ? 40 : 24);
  }
  while ([...new Set(Object.values(options).flat())].reduce((size, id) => size + evidence.get(id).text.length, 0) > 24000) {
    for (const title of headings) options[title] = evenly(options[title], Math.max(2, Math.floor(options[title].length * 0.75)));
  }
  if (longitudinal) for (const title of [main, course]) for (const id of evenly(episodeAnchors, 2)) {
    if (evidence.get(id).timestamp && !options[title].includes(id)) options[title].push(id);
  }
  for (const id of trendIds.slice(0, 2)) if (!options[diagnoses].includes(id)) options[diagnoses].push(id);
  const used = new Set(Object.values(options).flat());
  const schema = {
    type: 'object',
    properties: {
      sections: {
        type: 'object',
        properties: Object.fromEntries(headings.map((title) => {
          const count = title === 'Dated clinical timeline' ? 6 : title === 'Monitoring considerations' ? 3 : 2;
          const slots = Array.from({ length: count }, (_, index) => `item${index + 1}`);
          return [title, {
            type: 'object',
            properties: Object.fromEntries(slots.map((slot) => [slot, { type: 'string', enum: ['', ...options[title]] }])),
            required: slots,
            additionalProperties: false,
          }];
        })),
        required: headings,
        additionalProperties: false,
      },
    },
    required: ['sections'],
    additionalProperties: false,
  };
  const prompt = [
    'Select the most informative recorded evidence for a clinician reviewing this patient. Return only evidence IDs, never clinical statements.',
    'Do not write a reason for presentation, a diagnosis, a date, an outcome or treatment advice. All text is rendered directly from verified source evidence after selection.',
    'Return {"sections":{<each required section>:{"item1":"F<number>","item2":""}}}. Use empty strings for unused slots or sections without evidence. Only use IDs allowed for that section. Do not repeat an ID within a section.',
    'Prioritize presentation, primary diagnoses, results, changes and records spanning different dates/episodes. Include earlier and later events in the timeline.',
    `Allowed evidence IDs by section: ${JSON.stringify(options)}`,
    `Recorded evidence: ${JSON.stringify(Object.fromEntries([...evidence].filter(([id]) => used.has(id)).map(([id, item]) => [id, item.text])))}`,
  ].join('\n\n');

  function render(content) {
    let parsed;
    try { parsed = JSON.parse(content); } catch { throw Object.assign(new Error('Local AI returned invalid evidence selections.'), { status: 502 }); }
    const raw = parsed?.sections;
    if (!raw || typeof raw !== 'object' || Object.keys(raw).length !== headings.length) throw Object.assign(new Error('Local AI omitted required evidence sections.'), { status: 502 });
    const sections = headings.map((title) => {
      const slots = raw[title];
      const selections = slots && typeof slots === 'object' ? Object.values(slots) : null;
      const count = title === 'Dated clinical timeline' ? 6 : title === 'Monitoring considerations' ? 3 : 2;
      if (!selections || selections.length > count || selections.some((id) => typeof id !== 'string' || (id !== '' && !options[title].includes(id)))) throw Object.assign(new Error('Local AI selected unsupported evidence; no clinical claims were accepted.'), { status: 502 });
      const ids = [...new Set(selections.filter(Boolean))];
      if (!ids.length && options[title].length) ids.push(options[title][0]);
      if (longitudinal && [main, course, medications].includes(title)) {
        const episodeIds = [...new Set(options[title].map((id) => evidence.get(id).episodeId))];
        for (const episodeId of evenly(episodeIds, Math.min(2, episodeIds.length))) {
          if (ids.some((id) => evidence.get(id).episodeId === episodeId)) continue;
          const candidates = options[title].filter((id) => evidence.get(id).episodeId === episodeId);
          const newest = [...candidates].sort((left, right) => evidence.get(left).timestamp.localeCompare(evidence.get(right).timestamp)).at(-1);
          const candidate = title === main ? candidates.find((id) => evidence.get(id).kind === 'episode') || newest : newest;
          if (ids.length >= count) {
            const replace = ids.findLastIndex((id) => ids.filter((other) => evidence.get(other).episodeId === evidence.get(id).episodeId).length > 1);
            ids.splice(replace >= 0 ? replace : ids.length - 1, 1);
          }
          if (candidate) ids.push(candidate);
        }
      }
      if (title === diagnoses && trendIds.some((id) => options[title].includes(id)) && !ids.some((id) => evidence.get(id).kind === 'lab-trend')) {
        if (ids.length >= count) ids.pop();
        ids.push(trendIds.find((id) => options[title].includes(id)));
      }
      const records = ids.map((id) => evidence.get(id));
      if ([main, course, medications].includes(title)) records.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
      return { title, items: records.length ? records.map((item) => item.text) : ['Not recorded in supplied records.'] };
    });
    return {
      sections,
      summary: sections.map((section) => `${section.title}\n${section.items.map((item) => `- ${item}`).join('\n')}`).join('\n\n'),
      summaryMode: 'evidence-selection',
    };
  }
  return { prompt, schema, render };
}

export function recordedEvidenceSummary(patients, headings) {
  const packet = buildLocalEvidence(patients, headings);
  const sections = Object.fromEntries(Object.entries(packet.schema.properties.sections.properties).map(([title, section]) => {
    const slots = Object.keys(section.properties);
    const ids = section.properties.item1.enum.filter(Boolean);
    const chosen = evenly(ids, Math.min(slots.length, ids.length));
    return [title, Object.fromEntries(slots.map((slot, index) => [slot, chosen[index] || '']))];
  }));
  return { ...packet.render(JSON.stringify({ sections })), provider: 'recorded', model: 'source-excerpts', summaryMode: 'recorded-facts' };
}
