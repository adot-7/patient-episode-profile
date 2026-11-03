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

export function fetchPatientShell(dfn, signal, episodeId) {
  const query = episodeId ? `?episodeId=${encodeURIComponent(episodeId)}` : '';
  return get(`/patients/${encodeURIComponent(dfn)}/shell${query}`, signal);
}

export function fetchEpisode(dfn, episodeId, signal) {
  const query = new URLSearchParams({ episodeId, includeNoteDetails: 'false' });
  return get(`/patients/${encodeURIComponent(dfn)}?${query}`, signal);
}

export async function generateEpisodeSummary(dfn, episodeId, signal) {
  let response;
  try {
    response = await fetch(`${API_BASE}/patients/${encodeURIComponent(dfn)}/episode-summary`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeId }),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error('Cannot reach the AI summary service.');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || `AI summary service returned ${response.status}.`);
  return body;
}
