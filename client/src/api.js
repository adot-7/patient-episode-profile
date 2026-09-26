const API_BASE = `${import.meta.env.BASE_URL || '/'}api`;

async function get(path, signal) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { signal, headers: { Accept: 'application/json' } });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error('Cannot reach the clinical data service. Check the Sansys backend connection.');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || `Clinical data service returned ${response.status}.`);
  return body;
}

export function fetchPatientShell(dfn, signal) {
  return get(`/patients/${encodeURIComponent(dfn)}/shell`, signal);
}

export function fetchEpisode(dfn, episodeId, signal) {
  const query = new URLSearchParams({ episodeId, includeNoteDetails: 'true' });
  return get(`/patients/${encodeURIComponent(dfn)}?${query}`, signal);
}
