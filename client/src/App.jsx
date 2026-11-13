import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchEpisode, fetchPatientShell, generateEpisodeSummary, generateLongitudinalSummary } from './api.js';
import { buildPatientProfile, episodeReport, episodeSnapshot, shortDate, compareDateValues } from './profileData.js';
import VitalsChart from './VitalsChart.jsx';
import LabTrendChart from './LabTrendChart.jsx';

const OVERVIEW = '__overview__';

function GenerationSource({ state }) {
  if (!state?.model) return null;
  const label = ({ ollama: 'Local Ollama', gemini: 'Gemini', bharatcode: 'BharatCode', anthropic: 'Anthropic', recorded: 'Recorded source data' })[state.provider] || 'AI';
  return <><p className="coverage-note">{state.provider === 'recorded' ? 'Prepared from' : 'Generated with'} {label} · {state.model} · {state.summaryMode === 'recorded-facts' ? 'dated source excerpts; not AI-generated' : state.summaryMode === 'evidence-selection' ? 'AI-selected dated source excerpts; no generated clinical claims' : 'bounded source data'} · draft for clinician review</p>{state.fallback && <p className="coverage-note" role="status">Gemini {state.fallback.reason}. Showing {state.provider === 'recorded' ? 'recorded source facts' : 'local recorded-evidence highlights'} instead.</p>}</>;
}

function displayName(patient) {
  const demographics = patient?.demographics || {};
  return [demographics.firstName, demographics.lastName].filter(Boolean).join(' ') || 'Patient profile';
}

function episodeLabel(episode) {
  const label = String(episode?.label || episode?.name || episode?.id || 'Recorded episode');
  return label.replace(/^\d{1,2}\s+[A-Z]{3}\s+\d{4}\s+\d{1,2}:\d{2}\s+-\s*/i, '');
}

function uniqueProvenance(facts) {
  const seen = new Set();
  return (facts || []).flatMap((fact) => Array.isArray(fact?.provenance) ? fact.provenance : []).filter((source) => {
    const key = JSON.stringify(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ProvenanceAppendix({ records }) {
  const noteSources = new Map();
  const endpointSources = new Map();

  for (const record of records) {
    const patient = record.patient;
    const episode = patient.episode?.label || patient.episodeId;
    const facts = [
      ...(patient.notes || []),
      ...(patient.diagnoses || []),
      ...(patient.problems || []),
      ...(patient.complaints || []),
      ...(patient.medications || []),
      ...(patient.allergies?.items || []),
      ...(patient.labOrders || []),
      ...(patient.radOrders || []),
      ...(patient.vitals || []),
    ];
    for (const source of uniqueProvenance(facts)) {
      if (source.sourceType === 'clinical-note') {
        const key = `${patient.episodeId}|${source.noteIen || source.endpoint}`;
        const item = noteSources.get(key) || {
          episodeId: patient.episodeId,
          episode,
          title: source.noteTitle || source.endpoint,
          noteDate: source.noteDate || '',
          paths: new Set(),
        };
        if (source.path) item.paths.add(source.path);
        noteSources.set(key, item);
        continue;
      }
      const key = `${patient.episodeId}|${source.endpoint}|${source.path}`;
      const item = endpointSources.get(key) || {
        episodeId: source.episodeId || patient.episodeId,
        episode,
        endpoint: source.endpoint || 'Sansys endpoint',
        path: source.path || '',
        count: 0,
      };
      item.count += 1;
      endpointSources.set(key, item);
    }
  }

  const notes = [...noteSources.values()].sort((a, b) => String(b.noteDate).localeCompare(String(a.noteDate)));
  const endpoints = [...endpointSources.values()].sort((a, b) => a.episode.localeCompare(b.episode) || a.endpoint.localeCompare(b.endpoint));
  if (!notes.length && !endpoints.length) return null;

  return <details className="provenance-appendix">
    <summary>Source provenance · {notes.length} notes · {endpoints.length} data sources</summary>
    <div className="provenance-appendix-content">
      {notes.length > 0 && <section>
        <h3>Clinical note sources</h3>
        <div className="table-wrap"><table className="provenance-table">
          <thead><tr><th>Episode</th><th>Note</th><th>Date</th><th>Source paths</th></tr></thead>
          <tbody>{notes.map((item, index) => <tr key={`${item.episodeId}-${item.title}-${index}`}>
            <td>{item.episode}</td><td>{item.title}</td><td>{item.noteDate || 'Not recorded'}</td><td>{[...item.paths].join('; ')}</td>
          </tr>)}</tbody>
        </table></div>
      </section>}
      {endpoints.length > 0 && <section>
        <h3>Sansys endpoint sources</h3>
        <div className="table-wrap"><table className="provenance-table">
          <thead><tr><th>Episode</th><th>Endpoint</th><th>Response path</th><th>Facts</th></tr></thead>
          <tbody>{endpoints.map((item, index) => <tr key={`${item.episodeId}-${item.endpoint}-${item.path}-${index}`}>
            <td>{item.episode}</td><td>{item.endpoint}</td><td>{item.path}</td><td>{item.count}</td>
          </tr>)}</tbody>
        </table></div>
      </section>}
    </div>
  </details>;
}

function Card({ title, eyebrow, action, className = '', children }) {
  return <section className={`card ${className}`}>
    <header className="card-header">
      <div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2></div>
      {action && <div className="card-action">{action}</div>}
    </header>
    {children}
  </section>;
}

function Empty({ children = 'No matching entry is recorded in the available data.' }) {
  return <p className="empty-state">{children}</p>;
}

function StatusPill({ children, tone = 'neutral' }) {
  if (!children) return null;
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

function medicationStatuses(medication) {
  return [...new Set([medication.status, ...(Array.isArray(medication.statuses) ? medication.statuses : [])].filter(Boolean))];
}

function TrendCards({ readings, emptyMessage = 'No numeric vital trends are available for these episodes.' }) {
  const metrics = ['Systolic blood pressure', 'Diastolic blood pressure', 'Pulse', 'Temperature', 'Oxygen saturation', 'Respiratory rate', 'Weight'];
  const present = metrics.filter((metric) => readings.some((reading) => reading.name === metric));
  if (!present.length) return <Empty>{emptyMessage}</Empty>;
  return <div className="vitals-grid">{present.map((metric) => <VitalsChart key={metric} readings={readings} metric={metric} />)}</div>;
}

function EpisodeReport({ patient }) {
  const sections = episodeReport(patient);
  return <section className="episode-report">
    <header className="episode-report-header"><h2>Recorded episode facts</h2><span>{patient.episode?.startDate ? shortDate(patient.episode.startDate) : patient.episodeId}</span></header>
    <div className="episode-report-grid">{sections.map((section) => <section className={`report-section report-${section.key}`} key={section.title}>
      <h3>{section.title}</h3>
      {section.lines.length === 1 ? <p>{section.lines[0]}</p> : <ul>{section.lines.map((line, index) => <li key={`${section.title}-${index}`}>{line}</li>)}</ul>}
    </section>)}</div>
  </section>;
}

function PatientHeading({ patient, dfn }) {
  const demographics = patient?.demographics || {};
  return <div className="patient-heading">
    <div className="patient-heading-main">
      <div className="patient-name-row"><h1>{displayName(patient)}</h1></div>
      <div className="patient-demographics">
        <span><b>Patient ID</b> {demographics.uhid || dfn || '—'}</span>
        <span><b>Age / sex</b> {[demographics.age, demographics.sex].filter(Boolean).join(' / ') || '—'}</span>
        <span><b>DOB</b> {demographics.dob || '—'}</span>
        <span><b>IP number</b> {demographics.ipNo || '—'}</span>
        {demographics.primaryPhysician && <span><b>Primary physician</b> {demographics.primaryPhysician}</span>}
      </div>
    </div>
  </div>;
}

function PatientOverview({ shell, records, profile, failedRecords, onEpisode, longitudinal, onRegenerate }) {
  const conditions = profile.conditions;
  const allergies = profile.allergies.length ? profile.allergies : (shell?.allergies?.items || []);
  const history = longitudinal.backgroundHistory || records.flatMap((record) => record.patient.backgroundHistory || []);
  const chronological = [...records].sort((a, b) => String(a.patient.episode?.startDate || '').localeCompare(String(b.patient.episode?.startDate || '')));
  const synthesizing = ['queued', 'loading'].includes(longitudinal.status);
  const medications = [...profile.medications].sort((left, right) => (
    Number(right.statuses.some((status) => status.toLowerCase() === 'active'))
      - Number(left.statuses.some((status) => status.toLowerCase() === 'active'))
    || left.name.localeCompare(right.name)
  ));
  const visibleConditions = conditions.slice(0, 8);
  const visibleMedications = medications.slice(0, 10);
  return <div className="view-stack">
    <div className="view-title-row">
      <div><h1>Patient overview</h1><p>{records.length} recorded episode{records.length === 1 ? '' : 's'}</p></div>
    </div>
    <Card title={longitudinal.provider === 'recorded' ? 'Recorded cross-episode highlights (AI unavailable)' : 'Longitudinal clinical summary'} eyebrow={longitudinal.provider === 'recorded' ? 'Source facts · across episodes' : 'AI synthesis · across episodes'} action={<button type="button" disabled={!records.length || synthesizing} onClick={onRegenerate}>{synthesizing ? 'Synthesizing…' : 'Regenerate'}</button>}>
      {longitudinal.error && <div className="error-banner" role="alert">{longitudinal.error}</div>}
      <GenerationSource state={longitudinal} />
      {longitudinal.summary ? <AiSummary summary={longitudinal.summary} exclude={['monitoring considerations', 'recorded background']} /> : <Empty>{synthesizing ? 'Connecting the clinical story across dated episode records…' : longitudinal.status === 'error' ? 'The longitudinal synthesis is unavailable. Dated source records remain available below.' : 'The AI longitudinal synthesis will appear after episode records finish loading.'}</Empty>}
      {longitudinal.coverage && <p className="coverage-note">Covered {longitudinal.coverage.summarizedEpisodes} of {longitudinal.coverage.requestedEpisodes} selected episodes. {longitudinal.coverage.failedEpisodes?.length > 0 ? `${longitudinal.coverage.failedEpisodes.length} episodes could not be loaded. ` : ''}{longitudinal.coverage.truncated ? 'Coverage is limited to the selected episodes (maximum 30 per synthesis). ' : ''}Note detail and prompt inputs are bounded; source records remain available below.</p>}
    </Card>
    <div className="overview-brief-grid">
      <Card title="Personal, social & family history" eyebrow="Recorded background">
        {['Social history', 'Family history'].map((category) => <section className="background-category" key={category}>
          <h3>{category}</h3>
          {history.some((item) => item.category === category) ? <ul>{history.filter((item) => item.category === category).map((item, index) => <li key={`${category}-${index}`}><strong>{item.label}: </strong>{item.value}<small>{item.date || 'Date not recorded'} · {item.noteTitle} · episode {item.episodeId || 'not recorded'}</small></li>)}</ul> : <Empty>{category === 'Social history' ? 'Smoking, alcohol and other social history are not documented in the retrieved note details.' : 'Family history is not documented in the retrieved note details.'}</Empty>}
        </section>)}
      </Card>
      <section className="allergy-brief" aria-label="Recorded allergies">
        <h2>Allergies</h2>
        {allergies.length
          ? <ul>{allergies.map((allergy, index) => <li key={`${allergy.allergy}-${index}`}><strong>{allergy.allergy}</strong>{allergy.reaction && ` · ${allergy.reaction}`}{allergy.symptoms && ` · ${allergy.symptoms}`}</li>)}</ul>
          : <p>{shell?.allergies?.status || 'No allergy items returned.'}</p>}
      </section>
    </div>
    <Card title="Episode timeline" className="span-two timeline-summary-card">
      {records.length ? <div className="timeline-list">{chronological.map((record) => {
        const patient = record.patient;
        const snapshot = episodeSnapshot(patient);
        const primary = patient.diagnoses?.find((diagnosis) => diagnosis.isPrimary)?.diagnosis;
        return <button type="button" className="timeline-card" key={patient.episodeId} onClick={() => onEpisode(patient.episodeId)}>
          <span className="timeline-point" />
          <span className="timeline-date">{patient.episode?.startDate ? shortDate(patient.episode.startDate) : 'Date not recorded'}</span>
          <strong>{episodeLabel(patient.episode)}</strong>
          <span><b>Presentation:</b> {snapshot.complaints.slice(0, 2).join('; ') || 'Not recorded'}</span>
          <span><b>Primary diagnosis:</b> {primary || 'Not recorded'}</span>
          <span><b>Recorded course:</b> {episodeReport(patient).find((section) => section.key === 'course')?.lines.slice(0, 2).join(' → ') || 'No dated course documented'}</span>
        </button>;
      })}</div> : <Empty />}
    </Card>
    <Card title="Predictive analysis & monitoring priorities" eyebrow={longitudinal.provider === 'recorded' ? 'Source-derived review points' : 'AI-generated considerations for clinician review'}>
      <p className="coverage-note">Evidence-linked monitoring considerations, not a validated risk prediction or forecast. Historical findings do not establish the patient's current state.</p>
      {longitudinal.summary ? <AiSummary summary={longitudinal.summary} only={['monitoring considerations']} /> : <Empty>{synthesizing ? 'Reviewing recorded conditions and trends…' : 'Monitoring considerations require the longitudinal AI synthesis.'}</Empty>}
    </Card>
    <LabResults records={records} />
    <Card title="Vital-sign trends" className="span-two">
      <TrendCards readings={profile.vitalReadings} />
    </Card>
    <details className="overview-details">
      <summary>Expanded patient history · diagnoses, problems, and medication courses</summary>
      <div className="overview-grid">
      <Card title="Conditions recorded">
        {visibleConditions.length ? <div className="condition-list">{visibleConditions.map((condition) => <article className="condition-row" key={`${condition.kind}-${condition.label}`}>
          <div className="condition-main"><strong>{condition.label}</strong><div className="condition-meta"><span>{condition.kind}</span>{condition.primary && <StatusPill tone="blue">Primary</StatusPill>}{condition.statuses.map((status) => <StatusPill key={status}>{status}</StatusPill>)}</div></div>
          <div className="condition-episodes">{condition.episodes.map((episode) => <button type="button" className="text-link" key={episode.id} onClick={() => onEpisode(episode.id)}>{episode.date || episode.id}</button>)}</div>
        </article>)}</div> : <Empty />}
        {conditions.length > visibleConditions.length && <details className="more-records"><summary>Show {conditions.length - visibleConditions.length} more recorded conditions</summary><div className="condition-list">{conditions.slice(visibleConditions.length).map((condition) => <article className="condition-row" key={`${condition.kind}-${condition.label}`}><div className="condition-main"><strong>{condition.label}</strong><div className="condition-meta"><span>{condition.kind}</span>{condition.statuses.map((status) => <StatusPill key={status}>{status}</StatusPill>)}</div></div><div className="condition-episodes">{condition.episodes.map((episode) => <button type="button" className="text-link" key={episode.id} onClick={() => onEpisode(episode.id)}>{episode.date || episode.id}</button>)}</div></article>)}</div></details>}
      </Card>
      <Card title="Medication history">
        {visibleMedications.length ? <div className="table-wrap"><table className="clinical-table">
          <thead><tr><th>Medication</th><th>Recorded status</th><th>Schedule / course</th><th>Episodes</th></tr></thead>
          <tbody>{visibleMedications.map((medication) => <tr key={`${medication.name}-${medication.route}`}>
            <td><strong>{medication.name}</strong>{medication.route && <small>{medication.route}</small>}</td>
            <td>{medication.statuses.join(', ') || 'Not recorded'}</td>
            <td>{[...medication.schedules, medication.starts.length ? `Start ${medication.starts.join(', ')}` : '', medication.stops.length ? `Stop ${medication.stops.join(', ')}` : ''].filter(Boolean).join(' · ') || 'No schedule or dates recorded'}</td>
            <td><div className="episode-chip-list">{medication.episodes.map((episode) => <button type="button" className="text-link" key={episode.id} onClick={() => onEpisode(episode.id)}>{episode.date || episode.id}</button>)}</div></td>
          </tr>)}</tbody>
        </table></div> : <Empty />}
        {medications.length > visibleMedications.length && <details className="more-records"><summary>Show {medications.length - visibleMedications.length} more medication records</summary><div className="table-wrap"><table className="clinical-table"><thead><tr><th>Medication</th><th>Status</th><th>Schedule / course</th><th>Episodes</th></tr></thead><tbody>{medications.slice(visibleMedications.length).map((medication) => <tr key={`${medication.name}-${medication.route}`}><td><strong>{medication.name}</strong>{medication.route && <small>{medication.route}</small>}</td><td>{medication.statuses.join(', ') || 'Not recorded'}</td><td>{[...medication.schedules, ...medication.starts, ...medication.stops].filter(Boolean).join(' · ') || 'Not recorded'}</td><td>{medication.episodes.map((episode) => episode.date || episode.id).join('; ')}</td></tr>)}</tbody></table></div></details>}
      </Card>
      {failedRecords.length > 0 && <Card title="Episodes not loaded" eyebrow="Data availability" className="span-two">
        {failedRecords.map((record) => <div className="load-failure" key={record.episode.id}><strong>{episodeLabel(record.episode)}</strong><span>{record.error}</span></div>)}
      </Card>}
      </div>
    </details>
  </div>;
}

function DiagnosisCard({ patient }) {
  const diagnoses = patient.diagnoses || [];
  return <Card title="Diagnoses" eyebrow="Episode record">
    {diagnoses.length ? <div className="fact-list">{diagnoses.map((diagnosis, index) => <article className="fact-row" key={`${diagnosis.diagnosis}-${index}`}>
      <div><strong>{diagnosis.diagnosis}</strong>{diagnosis.isPrimary && <StatusPill tone="blue">Primary</StatusPill>}<span>{diagnosis.type || ''} {diagnosis.dateEntered ? `· ${diagnosis.dateEntered}` : ''}</span></div>
    </article>)}</div> : <Empty />}
  </Card>;
}

function EpisodeMedicationCard({ patient }) {
  const [expanded, setExpanded] = useState(false);
  const medications = [...(patient.medications || [])].sort((left, right) => Number(String(right.status).toLowerCase() === 'active') - Number(String(left.status).toLowerCase() === 'active') || compareDateValues(left.startDate, right.startDate));
  const visible = expanded ? medications : medications.slice(0, 6);
  return <Card title="Medication records">
    <p className="coverage-note">Recorded orders and dates; an ACTIVE order does not confirm administration or current use.</p>
    {medications.length ? <div className="fact-list medication-course-grid">{visible.map((medication, index) => {
      const statuses = medicationStatuses(medication);
      return <article className="fact-row" key={`${medication.medication}-${index}`}>
        <div className="fact-row-top"><strong>{medication.medication}</strong><span className="fact-statuses">{statuses.length ? statuses.map((status) => <StatusPill key={status} tone={String(status).toLowerCase() === 'active' ? 'green' : 'neutral'}>{status}</StatusPill>) : <StatusPill>Not recorded</StatusPill>}</span></div>
      <span>{[medication.schedule, medication.scheduleType, medication.route].filter(Boolean).join(' · ') || 'Schedule / route not recorded'}</span>
       <dl className="medication-dates"><div><dt>Start</dt><dd>{medication.startDate || 'Not recorded'}</dd></div><div><dt>Stop</dt><dd>{medication.stopDate || 'Not recorded'}</dd></div></dl>
      </article>;
    })}</div> : <Empty />}
    {medications.length > 6 && <button className="text-link" type="button" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show fewer' : `Show all ${medications.length} medication orders`}</button>}
  </Card>;
}

function OrderCard({ title, items, labelKey, dateKey }) {
  return <Card title={title}>
    {items?.length ? <div className="fact-list">{items.map((item, index) => <article className="fact-row" key={`${item[labelKey]}-${index}`}>
      <div className="fact-row-top"><strong>{item[labelKey]}</strong><StatusPill>{item.status}</StatusPill></div>
      <span>{[item.section, item.imagingType].filter(Boolean).join(' · ') || 'Order record'}</span>
      {item[dateKey] && <small>{item[dateKey]}</small>}
    </article>)}</div> : <Empty />}
  </Card>;
}

function LabResults({ records }) {
  const [focus, setFocus] = useState('all');
  const profile = buildPatientProfile(records);
  const orders = records.flatMap(({ patient }) => (patient.labOrders || []).map((order) => ({ ...order, episodeId: patient.episodeId })));
  const results = orders.flatMap((order) => (order.results || []).map((result) => ({ ...result, name: result.name || order.name, episodeId: order.episodeId, orderDateTime: order.orderDateTime })));
  const patterns = { dengue: /platelet|hematocrit|haematocrit|wbc|white blood|haemoglobin|hemoglobin/i, diabetes: /glucose|blood sugar|hba1c|creatinine|ketone/i, renal: /creatinine|urea|egfr|potassium|sodium/i, liver: /bilirubin|ast|alt|albumin|inr/i };
  const pattern = patterns[focus];
  const visible = pattern ? results.filter((result) => pattern.test(result.name)) : results;
  const series = [...new Map(profile.labReadings.filter((reading) => !pattern || pattern.test(reading.name)).map((reading) => [`${reading.name}|${reading.unit}`, { name: reading.name, unit: reading.unit }])).values()];
  return <Card title="Laboratory results & trends" eyebrow="Measured results · timestamped" action={<label className="focus-picker">Clinical focus <select value={focus} onChange={(event) => setFocus(event.target.value)}><option value="all">All results</option><option value="dengue">Dengue / haematology</option><option value="diabetes">Diabetes / glucose</option><option value="renal">Renal / electrolytes</option><option value="liver">Liver function</option></select></label>}>
    <p className="coverage-note">Focus changes result emphasis only; it does not assign a diagnosis.</p>
    {visible.length ? <>
      {series.length > 0 && <div className="vitals-grid">{series.map((item) => <LabTrendChart key={`${item.name}-${item.unit}`} readings={profile.labReadings.filter((reading) => reading.unit === item.unit)} testName={item.name} />)}</div>}
      <div className="table-wrap"><table className="clinical-table result-table"><thead><tr><th>Test / episode</th><th>Result</th><th>Reference / flag</th><th>Result timestamp</th><th>Ordered</th></tr></thead><tbody>{visible.map((result, index) => <tr key={`${result.episodeId}-${result.name}-${index}`}><td><strong>{result.name}</strong><small>Episode {result.episodeId}</small></td><td><strong>{result.value} {result.unit}</strong></td><td>{result.referenceRange || 'Not supplied'}{result.flag && <StatusPill>{result.flag}</StatusPill>}</td><td>{result.dateTime || 'Not supplied'}</td><td>{result.orderDateTime || 'Not supplied'}</td></tr>)}</tbody></table></div>
    </> : <Empty>{results.length ? 'No supplied results match this focus. Select All results to view the other tests.' : orders.some((order) => order.isResultAvailable) ? 'Sansys flags some orders as having results, but the connected response does not include their values or reports. Numerical trends cannot be plotted from order status alone.' : 'No laboratory result values were returned for these records. Orders are listed separately; an order is not a measured result.'}</Empty>}
  </Card>;
}

function NotesCard({ notes }) {
  const visibleNotes = (notes || []).slice(0, 30);
  return <details className="note-index span-two">
    <summary>Source notes · {notes?.length || 0}</summary>
    {notes?.length ? <div className="note-timeline">{visibleNotes.map((note, index) => <details className="note-entry" key={`${note.noteIen}-${index}`}>
      <summary><span className="note-title"><strong>{note.title || 'Clinical note'}</strong><small>{note.author || 'Author not recorded'} · {note.dateOfEntry || 'Date not recorded'} · {note.status || 'Status not recorded'}</small></span></summary>
      {note.content?.length > 0 && <div className="note-body"><div className="note-content">{note.content.map((line, lineIndex) => <p key={lineIndex}>{line}</p>)}</div></div>}
    </details>)}</div> : <p className="empty-state">No notes were returned for this episode.</p>}
    {notes?.length > visibleNotes.length && <p className="note-index-count">Showing {visibleNotes.length} of {notes.length} note headers. The AI summary uses selected note details across the episode.</p>}
  </details>;
}

function ProblemCard({ patient }) {
  const problems = patient.problems || [];
  return <Card title="Problem list" eyebrow="Recorded conditions">
    {problems.length ? <div className="fact-list">{problems.map((problem, index) => <article className="fact-row" key={`${problem.problem}-${index}`}>
      <div className="fact-row-top"><strong>{problem.problem}</strong><StatusPill tone={String(problem.status).toLowerCase() === 'active' ? 'green' : 'neutral'}>{problem.status}</StatusPill></div>
      {problem.dateOnset && <small>Onset recorded: {problem.dateOnset}</small>}
    </article>)}</div> : <Empty />}
  </Card>;
}

const SUMMARY_HEADINGS = new Set([
  'presentation',
  'hospital course',
  'diagnoses and problems',
  'key medications',
  'investigations',
  'follow-up / open items',
  'overall clinical story',
  'dated clinical timeline',
  'condition and investigation trends',
  'medication course',
  'recorded background',
  'monitoring considerations',
]);

function cleanSummaryLine(value) {
  return String(value || '')
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*\*\*(.*?)\*\*\s*$/, '$1')
    .replace(/^\s*__(.*?)__\s*$/, '$1')
    .replace(/\*\*/g, '')
    .trim();
}

function parseAiSummary(summary) {
  const sections = [];
  let current = null;
  const addSection = (title) => {
    current = { title, items: [] };
    sections.push(current);
  };

  for (const rawLine of String(summary || '').split(/\r?\n/)) {
    const line = cleanSummaryLine(rawLine);
    if (!line) continue;
    const heading = line.replace(/:$/, '').trim();
    if (SUMMARY_HEADINGS.has(heading.toLocaleLowerCase())) {
      addSection(heading);
      continue;
    }
    const bullet = line.replace(/^[-*•]\s+/, '').trim();
    if (!current) addSection('Summary');
    if (bullet !== line || !current.items.length) {
      current.items.push(bullet);
    } else {
      current.items[current.items.length - 1] = `${current.items.at(-1)} ${bullet}`.trim();
    }
  }
  return sections;
}

function AiSummary({ summary, only, exclude = [] }) {
  const sections = parseAiSummary(summary).filter((section) => (!only || only.includes(section.title.toLowerCase())) && !exclude.includes(section.title.toLowerCase()));
  if (!sections.length) return <Empty>No supported information was generated for this section.</Empty>;
  return <div className="ai-summary-text">{sections.map((section) => <section className={`ai-summary-section summary-${section.title.toLowerCase().replace(/[^a-z]+/g, '-')}`} key={section.title}>
    <h3>{section.title}</h3>
    <ul>{section.items.map((item, index) => <li key={`${section.title}-${index}`}>{item}</li>)}</ul>
  </section>)}</div>;
}

function EpisodeView({ record, dfn, aiState, onRegenerate }) {
  const patient = record.patient;
  const snapshot = episodeSnapshot(patient);
  const vitals = buildPatientProfile([{ patient }]).vitalReadings;
  const aiSummary = aiState?.summary || '';
  const aiLoading = aiState?.status === 'queued' || aiState?.status === 'loading';
  const aiError = aiState?.error || '';

  return <div className="view-stack">
    <div className="view-title-row episode-title-row">
      <div><div className="eyebrow">{patient.episode?.visitType || 'Recorded'} episode · {patient.episodeId || patient.episode?.id || 'ID not recorded'}</div><h1>{episodeLabel(patient.episode)}</h1></div>
      <span className="episode-reference">Episode {patient.episodeId || patient.episode?.id || 'ID not recorded'}</span>
    </div>
    <Card title={aiState?.provider === 'recorded' ? 'Recorded episode highlights (AI unavailable)' : 'AI episode summary'} action={<button type="button" onClick={onRegenerate} disabled={aiLoading}>{aiLoading ? 'Generating…' : 'Regenerate'}</button>}>
      {aiError && <div className="error-banner" role="alert">{aiError}</div>}
      <GenerationSource state={aiState} />
      {aiSummary
        ? <AiSummary summary={aiSummary} />
        : <p className="empty-state">{aiLoading ? 'Generating this episode summary from its recorded data…' : 'AI summary unavailable. Recorded episode facts are shown below.'}</p>}
    </Card>
    {!aiSummary && <EpisodeReport patient={patient} />}
    <LabResults records={[record]} />
    <EpisodeMedicationCard patient={patient} />
     <Card title="Vital-sign trends" eyebrow="Recorded measurements"><TrendCards readings={vitals} emptyMessage="No numeric vital measurements are recorded within this episode's date range. Measurements from other episodes are excluded." /></Card>
    <details className="episode-details">
      <summary>Detailed episode records · {snapshot.diagnosisCount} diagnoses · {snapshot.medicationCount} medication entries · {snapshot.noteCount} notes</summary>
      <div className="overview-grid episode-record-grid">
        <DiagnosisCard patient={patient} />
        <ProblemCard patient={patient} />
        <Card title="Presenting complaints" eyebrow="Episode record">
          {snapshot.complaints.length ? <ul className="clean-list">{(patient.complaints || []).map((complaint, index) => <li key={`${complaint.name}-${index}`}><strong>{complaint.name}</strong>{complaint.type && <span>{complaint.type}</span>}{complaint.remark && <p>{complaint.remark}</p>}{complaint.date && <small>{complaint.date}</small>}</li>)}</ul> : <Empty />}
        </Card>
        <EpisodeMedicationCard patient={patient} />
      <OrderCard title="Laboratory orders" items={patient.labOrders} labelKey="name" dateKey="orderDateTime" />
      <OrderCard title="Radiology orders" items={patient.radOrders} labelKey="procedure" dateKey="dateTime" />
      </div>
      <NotesCard notes={patient.notes} />
    </details>
  </div>;
}

export default function App() {
  const initialContext = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return { dfn: params.get('dfn') || '', episodeId: params.get('episodeId') || '' };
  }, []);
  const [dfnInput, setDfnInput] = useState(initialContext.dfn);
  const [loadedDfn, setLoadedDfn] = useState('');
  const [shell, setShell] = useState(null);
  const [records, setRecords] = useState([]);
  const [selectedEpisode, setSelectedEpisode] = useState(initialContext.episodeId || OVERVIEW);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState('');
  const [aiSummaries, setAiSummaries] = useState({});
  const [longitudinal, setLongitudinal] = useState({ status: 'idle' });
  const controllerRef = useRef(null);
  const aiRunRef = useRef(0);
  const aiQueueRef = useRef([]);
  const aiRequestedRef = useRef(new Set());
  const aiControllersRef = useRef(new Set());
  const aiActiveRef = useRef(0);
  const autoLoadRef = useRef(false);

  function episodeAiKey(dfn, episodeId) {
    return `${dfn}:${episodeId}`;
  }

  function pumpEpisodeSummaries() {
    while (aiActiveRef.current < 2 && aiQueueRef.current.length) {
      const job = aiQueueRef.current.shift();
      if (job.runId !== aiRunRef.current) continue;
      aiActiveRef.current += 1;
      const controller = new AbortController();
      aiControllersRef.current.add(controller);
      const isLongitudinal = job.kind === 'longitudinal';
      if (isLongitudinal) setLongitudinal({ status: 'loading' });
      else setAiSummaries((current) => ({ ...current, [job.episodeId]: { status: 'loading' } }));
      const request = isLongitudinal
        ? generateLongitudinalSummary(job.dfn, job.episodeIds, controller.signal, job.regenerate)
        : generateEpisodeSummary(job.dfn, job.episodeId, controller.signal, job.regenerate);
      request
        .then((result) => {
          if (job.runId === aiRunRef.current) {
            if (isLongitudinal) setLongitudinal({ ...result, status: 'ready' });
            else setAiSummaries((current) => ({ ...current, [job.episodeId]: { status: 'ready', summary: result.summary, model: result.model, provider: result.provider, summaryMode: result.summaryMode, fallback: result.fallback } }));
          }
        })
        .catch((summaryError) => {
          if (job.runId === aiRunRef.current && summaryError?.name !== 'AbortError') {
            const failure = { status: 'error', error: summaryError.message || 'AI summary could not be generated.' };
            if (isLongitudinal) setLongitudinal(failure);
            else setAiSummaries((current) => ({ ...current, [job.episodeId]: failure }));
          }
        })
        .finally(() => {
          aiControllersRef.current.delete(controller);
          if (job.runId !== aiRunRef.current) return;
          aiActiveRef.current -= 1;
          pumpEpisodeSummaries();
        });
    }
  }

  function queueEpisodeSummary(dfn, episodeId, regenerate = false) {
    const key = episodeAiKey(dfn, episodeId);
    if (aiRequestedRef.current.has(key)) return;
    aiRequestedRef.current.add(key);
    aiQueueRef.current.push({ dfn, episodeId, regenerate, runId: aiRunRef.current });
    setAiSummaries((current) => ({ ...current, [episodeId]: { status: 'queued' } }));
    pumpEpisodeSummaries();
  }

  function resetEpisodeSummaries() {
    aiRunRef.current += 1;
    aiQueueRef.current = [];
    aiRequestedRef.current.clear();
    aiControllersRef.current.forEach((controller) => controller.abort());
    aiControllersRef.current.clear();
    aiActiveRef.current = 0;
    setAiSummaries({});
    setLongitudinal({ status: 'idle' });
  }

  function createLongitudinalSummary(dfn, episodeIds, regenerate = false) {
    if (!episodeIds.length) return;
    aiQueueRef.current.unshift({ kind: 'longitudinal', dfn, episodeIds, regenerate, runId: aiRunRef.current });
    setLongitudinal({ status: 'queued' });
    pumpEpisodeSummaries();
  }

  function regenerateEpisodeSummary(dfn, episodeId) {
    aiRequestedRef.current.delete(episodeAiKey(dfn, episodeId));
    queueEpisodeSummary(dfn, episodeId, true);
  }

  useEffect(() => () => {
    controllerRef.current?.abort();
    aiRunRef.current += 1;
    aiQueueRef.current = [];
    aiControllersRef.current.forEach((controller) => controller.abort());
    aiControllersRef.current.clear();
  }, []);

  const successfulRecords = records.filter((record) => record.patient);
  const failedRecords = records.filter((record) => record.error);
  const profile = useMemo(() => buildPatientProfile(successfulRecords), [records]);
  const selectedRecord = selectedEpisode === OVERVIEW ? null : successfulRecords.find((record) => record.patient.episodeId === selectedEpisode);
  const selectedFailure = selectedEpisode === OVERVIEW ? null : failedRecords.find((record) => record.episode.id === selectedEpisode);

  async function loadPatient(event) {
    event.preventDefault();
    const dfn = dfnInput.trim();
    if (!dfn || loading) return;
    controllerRef.current?.abort();
    resetEpisodeSummaries();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError('');
    setShell(null);
    setRecords([]);
    const contextEpisodeId = dfn === initialContext.dfn ? initialContext.episodeId : '';
    setSelectedEpisode(contextEpisodeId || OVERVIEW);
    setLoadedDfn(dfn);
    setProgress({ done: 0, total: 0 });

    try {
      const patientShell = await fetchPatientShell(dfn, controller.signal, contextEpisodeId);
      if (controller.signal.aborted) return;
      const episodes = patientShell.episodes || [];
      setShell(patientShell);
      setSelectedEpisode(contextEpisodeId || OVERVIEW);
      if (!episodes.length) {
        setError('Patient found, but no episode records were returned for this DFN.');
        return;
      }
      setProgress({ done: 0, total: episodes.length });
      const results = Array(episodes.length);
      let cursor = 0;
      let completed = 0;
      const worker = async () => {
        while (true) {
          const index = cursor;
          cursor += 1;
          if (index >= episodes.length || controller.signal.aborted) return;
          const episode = episodes[index];
          try {
            const patient = await fetchEpisode(dfn, episode.id, controller.signal);
            if (controller.signal.aborted) return;
            results[index] = { episode, patient };
            queueEpisodeSummary(dfn, episode.id);
          } catch (episodeError) {
            if (episodeError?.name === 'AbortError') return;
            results[index] = { episode, error: episodeError.message || 'Episode could not be loaded.' };
          } finally {
            if (controller.signal.aborted) return;
            completed += 1;
            setRecords(results.filter(Boolean));
            setProgress({ done: completed, total: episodes.length });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, episodes.length) }, worker));
      if (controller.signal.aborted) return;
      setRecords(results.filter(Boolean));
      createLongitudinalSummary(dfn, results.filter((record) => record?.patient).map((record) => record.episode.id));
      if (!results.some((record) => record?.patient)) setError('None of the patient episodes could be loaded. Check the Sansys service and try again.');
    } catch (loadError) {
      if (loadError?.name !== 'AbortError') setError(loadError.message || 'Patient profile could not be loaded.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    if (!initialContext.dfn || autoLoadRef.current) return;
    const timer = window.setTimeout(() => {
      if (autoLoadRef.current) return;
      autoLoadRef.current = true;
      loadPatient({ preventDefault() {} });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialContext.dfn]);

  const navigationEpisodes = shell?.episodes || [];

  return <div className="app-shell">
    <header className="app-header">
      <span className="app-title">PATIENT EPISODE PROFILE</span>
    </header>

    <main className="page-frame" id="top">
      <section className={`welcome-row ${shell ? 'welcome-row-loaded' : ''}`}>
        <div>{shell
          ? <><div className="eyebrow">Patient record</div><div className="loaded-search-copy">Open a different patient</div></>
          : <><div className="eyebrow">Patient overview</div><h1>Patient episode profile</h1><p>Episode summaries and recorded clinical trends.</p></>}</div>
        <form className="patient-search" onSubmit={loadPatient}>
          <label htmlFor="patient-id">Patient ID / DFN</label>
          <div><input id="patient-id" value={dfnInput} onChange={(event) => setDfnInput(event.target.value)} placeholder="Enter patient identifier" autoComplete="off" /><button type="submit" disabled={loading || !dfnInput.trim()}>{loading ? 'Loading…' : 'Open profile'}</button></div>
        </form>
      </section>

      {error && <div className="error-banner" role="alert"><strong>Profile unavailable</strong><span>{error}</span></div>}
      {loading && <div className="loading-banner" role="status"><span className="loading-spinner" /><span>{shell ? `Loading episode records ${progress.done} of ${progress.total}…` : 'Finding patient and episode history…'}</span><div className="progress-track"><span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 8}%` }} /></div></div>}

      {shell && <>
        <PatientHeading patient={shell} dfn={loadedDfn} />
        <div className="profile-layout">
          <aside className="episode-sidebar" aria-label="Patient episode navigation">
            <div className="sidebar-heading"><div className="eyebrow">Patient record</div><strong>Navigate history</strong></div>
            <button type="button" className={`nav-item nav-overview ${selectedEpisode === OVERVIEW ? 'nav-selected' : ''}`} onClick={() => setSelectedEpisode(OVERVIEW)}>
              <span><strong>Patient overview</strong><small>Across all episodes</small></span>
            </button>
            <div className="episode-nav-heading"><span>Recorded episodes</span><span>{navigationEpisodes.length}</span></div>
            <div className="episode-nav-list">{navigationEpisodes.map((episode) => {
              const record = successfulRecords.find((item) => item.patient.episodeId === episode.id);
              const snapshot = record ? episodeSnapshot(record.patient) : null;
              const failure = failedRecords.find((item) => item.episode.id === episode.id);
              const aiState = aiSummaries[episode.id];
              const aiLabel = aiState?.status === 'ready' ? aiState.provider === 'recorded' ? 'Recorded facts ready' : 'AI summary ready' : aiState?.status === 'error' ? 'AI summary unavailable' : aiState ? 'AI summary generating' : '';
              return <button type="button" className={`nav-item episode-nav-item ${selectedEpisode === episode.id ? 'nav-selected' : ''}`} key={episode.id} onClick={() => setSelectedEpisode(episode.id)}>
                <span className="nav-timeline-mark" />
                <span><strong>{episode.startDate ? shortDate(episode.startDate) : episode.id}</strong><small>{episodeLabel(episode)}</small>{snapshot && <small>{snapshot.diagnoses[0] || 'Episode facts loaded'}</small>}{aiLabel && <small className={aiState.status === 'error' ? 'nav-error' : 'ai-nav-status'}>{aiLabel}</small>}{failure && <small className="nav-error">Could not load</small>}</span>
              </button>;
            })}</div>
          </aside>
          <section className="profile-content" aria-live="polite">
             {selectedEpisode === OVERVIEW ? <PatientOverview shell={shell} records={successfulRecords} profile={profile} failedRecords={failedRecords} onEpisode={setSelectedEpisode} longitudinal={longitudinal} onRegenerate={() => createLongitudinalSummary(loadedDfn, successfulRecords.map((record) => record.episode.id), true)} />
             : selectedRecord ? <EpisodeView record={selectedRecord} dfn={loadedDfn} aiState={aiSummaries[selectedRecord.patient.episodeId]} onRegenerate={() => regenerateEpisodeSummary(loadedDfn, selectedRecord.patient.episodeId)} />
                : selectedFailure ? <div className="error-banner episode-failure-view"><strong>Episode unavailable</strong><span>{selectedFailure.error}</span></div>
                : <div className="episode-pending"><span className="loading-spinner" /><strong>Loading episode summary…</strong><span>Episode records may take a short time to retrieve.</span></div>}
            <ProvenanceAppendix records={successfulRecords} />
          </section>
        </div>
      </>}

       {!shell && !loading && !error && <section className="welcome-card">
         <div><div className="eyebrow">Patient lookup</div><h2>Open the patient profile</h2><p>Enter a patient identifier to review episode summaries and recorded trends.</p></div>
      </section>}
    </main>
  </div>;
}
