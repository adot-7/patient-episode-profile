import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchEpisode, fetchPatientShell } from './api.js';
import { buildPatientProfile, episodeSnapshot, episodeSummary, longitudinalSummary, shortDate } from './profileData.js';
import VitalsChart from './VitalsChart.jsx';

const OVERVIEW = '__overview__';

function displayName(patient) {
  const demographics = patient?.demographics || {};
  return [demographics.firstName, demographics.lastName].filter(Boolean).join(' ') || 'Patient profile';
}

function episodeLabel(episode) {
  const label = String(episode?.label || episode?.name || episode?.id || 'Inpatient episode');
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
    <summary>Source provenance · {notes.length} clinical notes · {endpoints.length} endpoint groups</summary>
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

function TrendCards({ readings }) {
  const metrics = ['Systolic blood pressure', 'Diastolic blood pressure', 'Pulse', 'Temperature', 'Oxygen saturation', 'Respiratory rate', 'Weight'];
  const present = metrics.filter((metric) => readings.some((reading) => reading.name === metric));
  if (!present.length) return <Empty>No numeric vital trends are available for these episodes.</Empty>;
  return <div className="vitals-grid">{present.map((metric) => <VitalsChart key={metric} readings={readings} metric={metric} />)}</div>;
}

function PatientHeading({ patient, dfn }) {
  const demographics = patient?.demographics || {};
  return <div className="patient-heading">
    <div className="avatar-mark" aria-hidden="true">{displayName(patient).split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join('').toUpperCase()}</div>
    <div className="patient-heading-main">
      <div className="patient-name-row"><h1>{displayName(patient)}</h1><StatusPill tone="green">Read only</StatusPill></div>
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

function ClinicalReviewNotice({ failedCount, provisionalMedicationCount }) {
  return <aside className="review-notice" aria-label="Clinical review notice">
    <span className="notice-symbol" aria-hidden="true">!</span>
    <div>
      <strong>Use this summary to orient—not replace—review of the original chart.</strong>
      <p>Confirm diagnoses, medication status, and recorded trends before decisions. Test entries are orders; results may not be present. {provisionalMedicationCount > 0 && `${provisionalMedicationCount} medication record${provisionalMedicationCount === 1 ? ' is' : 's are'} documented in notes without a matching order; verify before prescribing. `}{failedCount > 0 && `${failedCount} episode${failedCount === 1 ? '' : 's'} could not be loaded; details are listed below. `}Source details are at the end of this profile.</p>
    </div>
  </aside>;
}

function PatientOverview({ shell, records, profile, failedRecords, onEpisode }) {
  const conditions = profile.conditions;
  const allergies = profile.allergies.length ? profile.allergies : (shell?.allergies?.items || []);
  const summaryFacts = longitudinalSummary(records, profile);
  const medications = [...profile.medications].sort((left, right) => (
    Number(right.statuses.some((status) => status.toLowerCase() === 'active'))
      - Number(left.statuses.some((status) => status.toLowerCase() === 'active'))
    || left.name.localeCompare(right.name)
  ));
  const visibleConditions = conditions.slice(0, 8);
  const visibleMedications = medications.slice(0, 10);
  return <div className="view-stack">
    <div className="view-title-row">
      <div><div className="eyebrow">Longitudinal patient record</div><h1>Patient overview</h1><p>{records.length} inpatient episode{records.length === 1 ? '' : 's'} · compiled from recorded Sansys entries</p></div>
    </div>
    <div className="overview-brief-grid">
      <section className="clinical-summary-brief">
        <h2>Longitudinal summary</h2>
        <dl>{summaryFacts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>
      </section>
      <section className="allergy-brief" aria-label="Recorded allergies">
        <h2>Allergies</h2>
        {allergies.length
          ? <ul>{allergies.map((allergy, index) => <li key={`${allergy.allergy}-${index}`}><strong>{allergy.allergy}</strong>{allergy.reaction && ` · ${allergy.reaction}`}{allergy.symptoms && ` · ${allergy.symptoms}`}</li>)}</ul>
          : <p>{shell?.allergies?.status || 'No allergy items returned.'}</p>}
        <small>Confirm in the active chart before prescribing.</small>
      </section>
    </div>
    <Card title="Episode timeline" eyebrow="Select an episode to open its summary" className="span-two timeline-summary-card">
      {records.length ? <div className="timeline-list">{records.map((record) => {
        const patient = record.patient;
        const snapshot = episodeSnapshot(patient);
        const primary = patient.diagnoses?.find((diagnosis) => diagnosis.isPrimary)?.diagnosis || snapshot.diagnoses[0];
        return <button type="button" className="timeline-card" key={patient.episodeId} onClick={() => onEpisode(patient.episodeId)}>
          <span className="timeline-point" />
          <span className="timeline-date">{patient.episode?.startDate ? shortDate(patient.episode.startDate) : 'Date not recorded'}</span>
          <strong>{episodeLabel(patient.episode)}</strong>
          <span>{primary || 'No diagnosis recorded'}{snapshot.complaints.length ? ` · ${snapshot.complaints.slice(0, 2).join('; ')}` : ''}</span>
        </button>;
      })}</div> : <Empty />}
    </Card>
    <Card title="Vital-sign trends" eyebrow="Measurements across loaded episodes" className="span-two">
      <TrendCards readings={profile.vitalReadings} />
    </Card>
    <div className="overview-grid">
      <Card title="Conditions recorded" eyebrow="Diagnoses and problem list">
        {visibleConditions.length ? <div className="condition-list">{visibleConditions.map((condition) => <article className="condition-row" key={`${condition.kind}-${condition.label}`}>
          <div className="condition-main"><strong>{condition.label}</strong><div className="condition-meta"><span>{condition.kind}</span>{condition.primary && <StatusPill tone="blue">Primary</StatusPill>}{condition.statuses.map((status) => <StatusPill key={status}>{status}</StatusPill>)}</div></div>
          <div className="condition-episodes">{condition.episodes.map((episode) => <button type="button" className="text-link" key={episode.id} onClick={() => onEpisode(episode.id)}>{episode.date || episode.id}</button>)}</div>
        </article>)}</div> : <Empty />}
        {conditions.length > visibleConditions.length && <details className="more-records"><summary>Show {conditions.length - visibleConditions.length} more recorded conditions</summary><div className="condition-list">{conditions.slice(visibleConditions.length).map((condition) => <article className="condition-row" key={`${condition.kind}-${condition.label}`}><div className="condition-main"><strong>{condition.label}</strong><div className="condition-meta"><span>{condition.kind}</span>{condition.statuses.map((status) => <StatusPill key={status}>{status}</StatusPill>)}</div></div><div className="condition-episodes">{condition.episodes.map((episode) => <button type="button" className="text-link" key={episode.id} onClick={() => onEpisode(episode.id)}>{episode.date || episode.id}</button>)}</div></article>)}</div></details>}
      </Card>
      <Card title="Medication history" eyebrow="Grouped by medication and route">
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
        <p className="card-footnote">Historical medication records do not establish current use.</p>
      </Card>
      {failedRecords.length > 0 && <Card title="Episodes not loaded" eyebrow="Data availability" className="span-two">
        {failedRecords.map((record) => <div className="load-failure" key={record.episode.id}><strong>{episodeLabel(record.episode)}</strong><span>{record.error}</span></div>)}
      </Card>}
    </div>
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
  const medications = patient.medications || [];
  return <Card title="Medication records" eyebrow="Orders recorded for episode">
    {medications.length ? <div className="fact-list">{medications.map((medication, index) => <article className="fact-row" key={`${medication.medication}-${index}`}>
      <div className="fact-row-top"><strong>{medication.medication}</strong><StatusPill tone={String(medication.status).toLowerCase() === 'active' ? 'green' : 'neutral'}>{medication.status}</StatusPill></div>
      <span>{[medication.schedule, medication.scheduleType, medication.route].filter(Boolean).join(' · ') || 'Schedule / route not recorded'}</span>
      <small>{medication.startDate || 'Start not recorded'} → {medication.stopDate || 'Stop date not recorded'}</small>
    </article>)}</div> : <Empty />}
  </Card>;
}

function OrderCard({ title, eyebrow, items, labelKey, dateKey }) {
  return <Card title={title} eyebrow={eyebrow}>
    {items?.length ? <div className="fact-list">{items.map((item, index) => <article className="fact-row" key={`${item[labelKey]}-${index}`}>
      <div className="fact-row-top"><strong>{item[labelKey]}</strong><StatusPill>{item.status}</StatusPill></div>
      <span>{[item.section, item.imagingType].filter(Boolean).join(' · ') || 'Order record'}</span>
      {item[dateKey] && <small>{item[dateKey]}</small>}
    </article>)}</div> : <Empty />}
    <p className="card-footnote">Order records only. Result values and interpretation may not be available.</p>
  </Card>;
}

function NotesCard({ notes }) {
  return <details className="note-index span-two">
    <summary>Clinical notes · {notes?.length || 0} available</summary>
    {notes?.length ? <div className="note-timeline">{notes.map((note, index) => <details className="note-entry" key={`${note.noteIen}-${index}`}>
      <summary><span className="note-title"><strong>{note.title || 'Clinical note'}</strong><small>{note.author || 'Author not recorded'} · {note.dateOfEntry || 'Date not recorded'} · {note.status || 'Status not recorded'}</small></span></summary>
      <div className="note-body">{note.content?.length ? <div className="note-content">{note.content.map((line, lineIndex) => <p key={lineIndex}>{line}</p>)}</div> : <p className="empty-state">No narrative content was returned for this note.</p>}</div>
    </details>)}</div> : <p className="empty-state">No notes were returned for this episode.</p>}
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

function EpisodeView({ record }) {
  const patient = record.patient;
  const snapshot = episodeSnapshot(patient);
  const vitals = buildPatientProfile([{ patient }]).vitalReadings;
  return <div className="view-stack">
    <div className="view-title-row episode-title-row">
      <div><div className="eyebrow">Inpatient episode · {patient.episodeId || patient.episode?.id || 'ID not recorded'}</div><h1>{episodeLabel(patient.episode)}</h1><p>{patient.episode?.label || shortDate(patient.episode?.startDate)}{patient.episode?.dateTo ? ` · through ${patient.episode.dateTo}` : ''}</p></div>
      <span className="episode-reference">Episode {patient.episodeId || patient.episode?.id || 'ID not recorded'}</span>
    </div>
    <div className="episode-brief">
      <strong>Episode summary</strong>
      <p>{episodeSummary(patient)}</p>
      <div className="episode-brief-meta"><span>Admission: {patient.demographics?.admitDate || patient.episode?.startDate || 'Not recorded'}</span><span>Ward: {patient.demographics?.ward || 'Not recorded'}</span><span>Primary physician: {patient.demographics?.primaryPhysician || 'Not recorded'}</span></div>
    </div>
    <Card title="Vital-sign trends" eyebrow="Recorded measurements"><TrendCards readings={vitals} /></Card>
    <div className="overview-grid episode-record-grid">
      <DiagnosisCard patient={patient} />
      <ProblemCard patient={patient} />
      <Card title="Presenting complaints" eyebrow="Episode record">
        {snapshot.complaints.length ? <ul className="clean-list">{(patient.complaints || []).map((complaint, index) => <li key={`${complaint.name}-${index}`}><strong>{complaint.name}</strong>{complaint.type && <span>{complaint.type}</span>}{complaint.remark && <p>{complaint.remark}</p>}{complaint.date && <small>{complaint.date}</small>}</li>)}</ul> : <Empty />}
      </Card>
      <EpisodeMedicationCard patient={patient} />
      <OrderCard title="Laboratory orders" eyebrow="Orders · not results" items={patient.labOrders} labelKey="name" dateKey="orderDateTime" />
      <OrderCard title="Radiology orders" eyebrow="Orders · not interpretations" items={patient.radOrders} labelKey="procedure" dateKey="dateTime" />
    </div>
    <NotesCard notes={patient.notes} />
  </div>;
}

export default function App() {
  const [dfnInput, setDfnInput] = useState('');
  const [loadedDfn, setLoadedDfn] = useState('');
  const [shell, setShell] = useState(null);
  const [records, setRecords] = useState([]);
  const [selectedEpisode, setSelectedEpisode] = useState(OVERVIEW);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState('');
  const controllerRef = useRef(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

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
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError('');
    setShell(null);
    setRecords([]);
    setSelectedEpisode(OVERVIEW);
    setLoadedDfn(dfn);
    setProgress({ done: 0, total: 0 });

    try {
      const patientShell = await fetchPatientShell(dfn, controller.signal);
      if (controller.signal.aborted) return;
      const episodes = patientShell.episodes || [];
      setShell(patientShell);
      if (!episodes.length) {
        setError('No inpatient episodes were returned for this patient.');
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
            results[index] = { episode, patient };
          } catch (episodeError) {
            if (episodeError?.name === 'AbortError') return;
            results[index] = { episode, error: episodeError.message || 'Episode could not be loaded.' };
          } finally {
            completed += 1;
            setProgress({ done: completed, total: episodes.length });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, episodes.length) }, worker));
      if (controller.signal.aborted) return;
      setRecords(results.filter(Boolean));
      if (!results.some((record) => record?.patient)) setError('None of the patient episodes could be loaded. Check the Sansys service and try again.');
    } catch (loadError) {
      if (loadError?.name !== 'AbortError') setError(loadError.message || 'Patient profile could not be loaded.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  const navigationEpisodes = shell?.episodes || [];
  const provisionalMedicationCount = successfulRecords.reduce((count, record) => (
    count + (record.patient.medications || []).filter((medication) => medication.needsVerification).length
  ), 0);

  return <div className="app-shell">
    <header className="app-header">
      <span className="app-title">IPD · PATIENT EPISODE PROFILE</span>
      <span className="app-sub">LONGITUDINAL CLINICAL VIEW · READ ONLY</span>
    </header>

    <main className="page-frame" id="top">
      <section className={`welcome-row ${shell ? 'welcome-row-loaded' : ''}`}>
        <div>{shell
          ? <><div className="eyebrow">Patient record</div><div className="loaded-search-copy">Open a different patient</div></>
          : <><div className="eyebrow">Read-only clinical workspace</div><h1>Patient episode profile</h1><p>Review the recorded patient history across inpatient episodes.</p></>}</div>
        <form className="patient-search" onSubmit={loadPatient}>
          <label htmlFor="patient-id">Patient ID / DFN</label>
          <div><input id="patient-id" value={dfnInput} onChange={(event) => setDfnInput(event.target.value)} placeholder="Enter patient identifier" autoComplete="off" /><button type="submit" disabled={loading || !dfnInput.trim()}>{loading ? 'Loading…' : 'Open profile'}</button></div>
          <small>Read-only · no changes are written to the source chart</small>
        </form>
      </section>

      {error && <div className="error-banner" role="alert"><strong>Profile unavailable</strong><span>{error}</span></div>}
      {loading && <div className="loading-banner" role="status"><span className="loading-spinner" /><span>{shell ? `Loading episode records ${progress.done} of ${progress.total}…` : 'Finding patient and episode history…'}</span><div className="progress-track"><span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 8}%` }} /></div></div>}

      {shell && <>
        <PatientHeading patient={shell} dfn={loadedDfn} />
        <ClinicalReviewNotice failedCount={failedRecords.length} provisionalMedicationCount={provisionalMedicationCount} />
        <div className="profile-layout">
          <aside className="episode-sidebar" aria-label="Patient episode navigation">
            <div className="sidebar-heading"><div className="eyebrow">Patient record</div><strong>Navigate history</strong></div>
            <button type="button" className={`nav-item nav-overview ${selectedEpisode === OVERVIEW ? 'nav-selected' : ''}`} onClick={() => setSelectedEpisode(OVERVIEW)}>
              <span><strong>Patient overview</strong><small>Across all episodes</small></span>
            </button>
            <div className="episode-nav-heading"><span>Inpatient episodes</span><span>{navigationEpisodes.length}</span></div>
            <div className="episode-nav-list">{navigationEpisodes.map((episode) => {
              const record = successfulRecords.find((item) => item.patient.episodeId === episode.id);
              const snapshot = record ? episodeSnapshot(record.patient) : null;
              const failure = failedRecords.find((item) => item.episode.id === episode.id);
              return <button type="button" className={`nav-item episode-nav-item ${selectedEpisode === episode.id ? 'nav-selected' : ''}`} key={episode.id} onClick={() => setSelectedEpisode(episode.id)}>
                <span className="nav-timeline-mark" />
                <span><strong>{episode.startDate ? shortDate(episode.startDate) : episode.id}</strong><small>{episodeLabel(episode)}</small>{snapshot && <small>{snapshot.diagnoses[0] || 'Episode summary'}</small>}{failure && <small className="nav-error">Could not load</small>}</span>
              </button>;
            })}</div>
            <div className="sidebar-footer">Read only · Data remains in Sansys</div>
          </aside>
          <section className="profile-content" aria-live="polite">
            {selectedEpisode === OVERVIEW ? <PatientOverview shell={shell} records={successfulRecords} profile={profile} failedRecords={failedRecords} onEpisode={setSelectedEpisode} />
              : selectedRecord ? <EpisodeView record={selectedRecord} />
                : selectedFailure ? <div className="error-banner episode-failure-view"><strong>Episode unavailable</strong><span>{selectedFailure.error}</span></div>
                : <div className="episode-pending"><span className="loading-spinner" /><strong>Loading episode summary…</strong><span>Episode records may take a short time to retrieve.</span></div>}
            <ProvenanceAppendix records={successfulRecords} />
          </section>
        </div>
      </>}

      {!shell && !loading && !error && <section className="welcome-card">
        <div><div className="eyebrow">Patient lookup</div><h2>Open a patient record</h2><p>Enter a patient identifier above to view a concise longitudinal summary, select an inpatient episode, and review recorded trends.</p></div>
      </section>}
      <footer className="app-footer"><span>Patient Episode Profile</span><span>Read-only clinical reference · Source data remains in Sansys</span></footer>
    </main>
  </div>;
}
