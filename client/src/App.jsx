import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchEpisode, fetchPatientShell } from './api.js';
import { buildPatientProfile, episodeSnapshot, shortDate } from './profileData.js';
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

function SourceDetails({ facts }) {
  const sources = uniqueProvenance(facts);
  if (!sources.length) return null;
  return <details className="source-details">
    <summary>View source record{sources.length === 1 ? '' : 's'} ({sources.length})</summary>
    <ul>{sources.map((source, index) => <li key={`${source.endpoint}-${source.path}-${index}`}>
      <strong>{source.noteTitle || source.endpoint || 'Clinical record'}</strong>
      {source.noteDate && <span> · {source.noteDate}</span>}
      {source.path && <code>{source.path}</code>}
      {source.episodeId && <span>Episode {source.episodeId}</span>}
    </li>)}</ul>
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

function ClinicalReviewNotice({ failedCount }) {
  return <aside className="review-notice" aria-label="Clinical review notice">
    <span className="notice-symbol" aria-hidden="true">!</span>
    <div>
      <strong>Clinical review required</strong>
      <p>This read-only profile consolidates recorded Sansys data to help orient the receiving team. It does not replace review of the original chart. Verify diagnoses, medication status and course, note-sourced facts, and vital trends before clinical decisions. Lab/radiology entries are orders; result values may not be available here.{failedCount > 0 && ` ${failedCount} episode${failedCount === 1 ? '' : 's'} could not be loaded; see the episode list for details.`}</p>
    </div>
  </aside>;
}

function StatStrip({ records, profile }) {
  const notes = records.reduce((total, record) => total + (record.patient?.notes?.length || 0), 0);
  const medOrders = records.reduce((total, record) => total + (record.patient?.medications?.length || 0), 0);
  return <div className="stat-strip">
    <div><strong>{records.length}</strong><span>Episodes loaded</span></div>
    <div><strong>{profile.conditions.length}</strong><span>Distinct conditions</span></div>
    <div><strong>{medOrders}</strong><span>Medication records</span></div>
    <div><strong>{notes}</strong><span>Clinical notes</span></div>
  </div>;
}

function PatientOverview({ shell, records, profile, failedRecords, onEpisode }) {
  const conditions = profile.conditions;
  const allergies = profile.allergies.length ? profile.allergies : (shell?.allergies?.items || []);
  const episodePatients = records.map((record) => record.patient);
  return <div className="view-stack">
    <div className="view-title-row">
      <div><div className="eyebrow">Longitudinal summary</div><h1>Patient overview</h1><p>A cross-episode view of recorded history and clinical trends.</p></div>
      <span className="record-count">{records.length} episode{records.length === 1 ? '' : 's'} in view</span>
    </div>
    <StatStrip records={records} profile={profile} />
    <div className="overview-grid">
      <Card title="Conditions across episodes" eyebrow="Recorded diagnoses & problems" className="span-two">
        {conditions.length ? <div className="condition-list">{conditions.map((condition) => <article className="condition-row" key={`${condition.kind}-${condition.label}`}>
          <div className="condition-main"><strong>{condition.label}</strong><div className="condition-meta"><span>{condition.kind}</span>{condition.primary && <StatusPill tone="blue">Primary diagnosis</StatusPill>}{condition.statuses.map((status) => <StatusPill key={status}>{status}</StatusPill>)}</div></div>
          <div className="condition-episodes">{condition.episodes.map((episode) => <button type="button" className="text-link" key={episode.id} onClick={() => onEpisode(episode.id)}>{episode.date || episode.id}</button>)}</div>
          <SourceDetails facts={[condition]} />
        </article>)}</div> : <Empty />}
      </Card>
      <Card title="Allergies" eyebrow="Patient safety" className="allergy-card">
        {allergies.length ? <div className="allergy-list">{allergies.map((allergy, index) => <article className="allergy-row" key={`${allergy.allergy}-${index}`}>
          <strong>{allergy.allergy}</strong>
          <span>{[allergy.reaction, allergy.symptoms].filter(Boolean).join(' · ') || 'Reaction details not recorded'}</span>
          {allergy.date && <small>Recorded {allergy.date}</small>}
          <SourceDetails facts={[allergy]} />
        </article>)}</div> : <Empty>{shell?.allergies?.status || 'No allergy item is recorded.'}</Empty>}
        <div className="caution-inline">Confirm allergy status in the active chart before prescribing.</div>
      </Card>
      <Card title="Medication history" eyebrow="Across loaded episodes" className="span-two">
        {profile.medications.length ? <div className="table-wrap"><table className="clinical-table">
          <thead><tr><th>Medication</th><th>Route / schedule</th><th>Recorded status</th><th>Recorded course</th><th>Episodes</th></tr></thead>
          <tbody>{profile.medications.map((medication) => <tr key={`${medication.name}-${medication.route}`}>
            <td><strong>{medication.name}</strong><SourceDetails facts={[medication]} /></td>
            <td>{[medication.route, ...medication.schedules].filter(Boolean).join(' · ') || 'Not recorded'}</td>
            <td>{medication.statuses.length ? medication.statuses.map((status) => <StatusPill key={status}>{status}</StatusPill>) : 'Not recorded'}</td>
            <td>{`Start: ${medication.starts.join(', ') || 'not recorded'} · Stop: ${medication.stops.join(', ') || 'not recorded'}`}</td>
            <td><div className="episode-chip-list">{medication.episodes.map((episode) => <button type="button" className="text-link" key={episode.id} onClick={() => onEpisode(episode.id)}>{episode.date || episode.id}</button>)}</div></td>
          </tr>)}</tbody>
        </table></div> : <Empty />}
        <p className="card-footnote">Medication records are consolidated by recorded name and route; this does not establish current use.</p>
      </Card>
      <Card title="Vital-sign trends" eyebrow="Recorded measurements" className="span-two">
        <TrendCards readings={profile.vitalReadings} />
      </Card>
      <Card title="Episode timeline" eyebrow="Select an encounter">
        {episodePatients.length ? <div className="timeline-list">{records.map((record) => {
          const patient = record.patient;
          const snapshot = episodeSnapshot(patient);
          return <button type="button" className="timeline-card" key={patient.episodeId} onClick={() => onEpisode(patient.episodeId)}>
            <span className="timeline-point" />
            <span className="timeline-date">{shortDate(patient.episode?.startDate || patient.demographics?.admitDate)}</span>
            <strong>{episodeLabel(patient.episode)}</strong>
            <span>{snapshot.diagnoses.slice(0, 2).join(' · ') || 'No diagnosis recorded'}</span>
            <small>{snapshot.noteCount} notes · {snapshot.medicationCount} medication records</small>
          </button>;
        })}</div> : <Empty />}
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
      <SourceDetails facts={[diagnosis]} />
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
      {medication.needsVerification && <div className="provisional-tag">Note-sourced · verify against the medication order</div>}
      <SourceDetails facts={[medication]} />
    </article>)}</div> : <Empty />}
  </Card>;
}

function OrderCard({ title, eyebrow, items, labelKey, dateKey }) {
  return <Card title={title} eyebrow={eyebrow}>
    {items?.length ? <div className="fact-list">{items.map((item, index) => <article className="fact-row" key={`${item[labelKey]}-${index}`}>
      <div className="fact-row-top"><strong>{item[labelKey]}</strong><StatusPill>{item.status}</StatusPill></div>
      <span>{[item.section, item.imagingType].filter(Boolean).join(' · ') || 'Order record'}</span>
      {item[dateKey] && <small>{item[dateKey]}</small>}
      <SourceDetails facts={[item]} />
    </article>)}</div> : <Empty />}
    <p className="card-footnote">Order records only. Result values and interpretation may not be available.</p>
  </Card>;
}

function NotesCard({ notes }) {
  return <Card title="Clinical notes" eyebrow="Source context" className="span-two">
    {notes?.length ? <div className="note-timeline">{notes.map((note, index) => <details className="note-entry" key={`${note.noteIen}-${index}`}>
      <summary><span className="note-dot" /><span className="note-title"><strong>{note.title || 'Clinical note'}</strong><small>{note.author || 'Author not recorded'} · {note.dateOfEntry || 'Date not recorded'}</small></span><StatusPill>{note.status}</StatusPill></summary>
      <div className="note-body">
        {note.content?.length ? <div className="note-content">{note.content.map((line, lineIndex) => <p key={lineIndex}>{line}</p>)}</div> : <Empty>No narrative content was returned for this note.</Empty>}
        <SourceDetails facts={[note]} />
      </div>
    </details>)}</div> : <Empty />}
  </Card>;
}

function ProblemCard({ patient }) {
  const problems = patient.problems || [];
  return <Card title="Problem list" eyebrow="Recorded conditions">
    {problems.length ? <div className="fact-list">{problems.map((problem, index) => <article className="fact-row" key={`${problem.problem}-${index}`}>
      <div className="fact-row-top"><strong>{problem.problem}</strong><StatusPill tone={String(problem.status).toLowerCase() === 'active' ? 'green' : 'neutral'}>{problem.status}</StatusPill></div>
      {problem.dateOnset && <small>Onset recorded: {problem.dateOnset}</small>}
      <SourceDetails facts={[problem]} />
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
      <StatusPill tone="blue">Episode summary</StatusPill>
    </div>
    <div className="episode-stat-strip">
      <div><strong>{snapshot.diagnosisCount}</strong><span>Diagnoses</span></div>
      <div><strong>{snapshot.noteCount}</strong><span>Notes</span></div>
      <div><strong>{snapshot.medicationCount}</strong><span>Medication records</span></div>
      <div><strong>{snapshot.labOrderCount + snapshot.radiologyOrderCount}</strong><span>Test / imaging orders</span></div>
    </div>
    <div className="overview-grid">
      <DiagnosisCard patient={patient} />
      <ProblemCard patient={patient} />
      <Card title="Presenting complaints" eyebrow="Episode context">
        {snapshot.complaints.length ? <ul className="clean-list">{(patient.complaints || []).map((complaint, index) => <li key={`${complaint.name}-${index}`}><strong>{complaint.name}</strong>{complaint.type && <span>{complaint.type}</span>}{complaint.remark && <p>{complaint.remark}</p>}{complaint.date && <small>{complaint.date}</small>}<SourceDetails facts={[complaint]} /></li>)}</ul> : <Empty />}
      </Card>
      <Card title="Vital-sign trends" eyebrow="Recorded measurements" className="span-two"><TrendCards readings={vitals} /></Card>
      <EpisodeMedicationCard patient={patient} />
      <OrderCard title="Laboratory orders" eyebrow="Orders · not results" items={patient.labOrders} labelKey="name" dateKey="orderDateTime" />
      <OrderCard title="Radiology orders" eyebrow="Orders · not interpretations" items={patient.radOrders} labelKey="procedure" dateKey="dateTime" />
      <NotesCard notes={patient.notes} />
    </div>
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
  const noteSourcedCount = successfulRecords.reduce((count, record) => count + (record.patient.notes || []).filter((note) => note.needsVerification).length, 0);

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand-mark" href="#top" aria-label="Patient Episode Profile home"><span className="brand-cross">+</span><span>Clinical overview</span></a>
      <div className="topbar-right"><span className="read-only-marker"><span /> READ ONLY</span><span className="topbar-product">PATIENT EPISODE PROFILE</span></div>
    </header>

    <main className="page-frame" id="top">
      <section className="welcome-row">
        <div><div className="eyebrow">Longitudinal care workspace</div><h1>See the whole patient story.</h1><p>One clear view of the patient's recorded history across inpatient episodes.</p></div>
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
        <ClinicalReviewNotice failedCount={failedRecords.length} />
        <div className="profile-layout">
          <aside className="episode-sidebar" aria-label="Patient episode navigation">
            <div className="sidebar-heading"><div className="eyebrow">Patient record</div><strong>Navigate history</strong></div>
            <button type="button" className={`nav-item nav-overview ${selectedEpisode === OVERVIEW ? 'nav-selected' : ''}`} onClick={() => setSelectedEpisode(OVERVIEW)}>
              <span className="nav-icon">◫</span><span><strong>Patient overview</strong><small>Across all episodes</small></span>
            </button>
            <div className="episode-nav-heading"><span>Inpatient episodes</span><span>{navigationEpisodes.length}</span></div>
            <div className="episode-nav-list">{navigationEpisodes.map((episode) => {
              const record = successfulRecords.find((item) => item.patient.episodeId === episode.id);
              const snapshot = record ? episodeSnapshot(record.patient) : null;
              const failure = failedRecords.find((item) => item.episode.id === episode.id);
              return <button type="button" className={`nav-item episode-nav-item ${selectedEpisode === episode.id ? 'nav-selected' : ''}`} key={episode.id} onClick={() => setSelectedEpisode(episode.id)}>
                <span className="nav-timeline-mark" />
                <span><strong>{shortDate(episode.startDate) || episode.id}</strong><small>{episodeLabel(episode)}</small>{snapshot && <small>{snapshot.diagnoses[0] || 'Episode summary'}</small>}{failure && <small className="nav-error">Could not load</small>}</span>
              </button>;
            })}</div>
            <div className="sidebar-footer"><span className="sidebar-lock">▣</span> Data is viewed, not edited</div>
          </aside>
          <section className="profile-content" aria-live="polite">
            {selectedEpisode === OVERVIEW ? <PatientOverview shell={shell} records={successfulRecords} profile={profile} failedRecords={failedRecords} onEpisode={setSelectedEpisode} />
              : selectedRecord ? <EpisodeView record={selectedRecord} />
                : selectedFailure ? <div className="error-banner episode-failure-view"><strong>Episode unavailable</strong><span>{selectedFailure.error}</span></div>
                : <div className="episode-pending"><span className="loading-spinner" /><strong>Loading episode summary…</strong><span>Episode records may take a short time to retrieve.</span></div>}
            {noteSourcedCount > 0 && <p className="provenance-footer">{noteSourcedCount} note{noteSourcedCount === 1 ? '' : 's'} include note-sourced clinical content. Open source records and verify against the original chart.</p>}
          </section>
        </div>
      </>}

      {!shell && !loading && !error && <section className="welcome-card">
        <div className="welcome-illustration" aria-hidden="true"><span className="illustration-ring" /><span className="illustration-cross">+</span><span className="illustration-line line-one" /><span className="illustration-line line-two" /></div>
        <div><div className="eyebrow">A clearer handover starts here</div><h2>Bring every episode into view.</h2><p>Open a patient record to explore the episode timeline, clinical notes, medication history, diagnoses, and recorded vital trends together.</p><ul><li>Choose an episode from the side navigation</li><li>Review longitudinal history on the patient overview</li><li>Open source records when you need the detail</li></ul></div>
      </section>}
      <footer className="app-footer"><span>Patient Episode Profile</span><span>Read-only clinical reference · Source data remains in Sansys</span></footer>
    </main>
  </div>;
}
