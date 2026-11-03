const MODEL = process.env.BHARATCODE_MODEL || process.env.OPENAI_MODEL || 'qwen-3.8-27b';
const BASE_URL = (process.env.BHARATCODE_BASE_URL || process.env.OPENAI_BASE_URL || 'https://bharatcode.ai/api/model/v1').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.BHARATCODE_TIMEOUT_MS || 180000);
const MAX_NOTE_CHARS = 8000;
const MAX_NOTE_TOTAL_CHARS = 60000;

function boundedNotes(notes) {
  let remaining = MAX_NOTE_TOTAL_CHARS;
  return (Array.isArray(notes) ? notes : []).map((note) => {
    if (remaining <= 0) return null;
    const content = Array.isArray(note?.content) ? note.content.join('\n') : String(note?.content || '');
    const clipped = content.slice(0, Math.min(MAX_NOTE_CHARS, remaining));
    remaining -= clipped.length;
    return {
      title: note?.title || '',
      dateOfEntry: note?.dateOfEntry || '',
      author: note?.author || '',
      content: clipped,
    };
  }).filter(Boolean);
}

function promptFor(patient) {
  const source = {
    episode: patient.episode,
    demographics: {
      age: patient.demographics?.age,
      sex: patient.demographics?.sex,
    },
    diagnoses: patient.diagnoses,
    problems: patient.problems,
    complaints: patient.complaints,
    allergies: patient.allergies,
    medications: patient.medications,
    labOrders: patient.labOrders,
    radOrders: patient.radOrders,
    vitals: patient.vitals,
    notes: boundedNotes(patient.notes),
  };

  return [
    'Generate a concise factual clinical overview of this inpatient episode for a clinician, no more than 500 words.',
    'Use only the recorded data below. Do not infer diagnoses, outcomes, improvement, causality, or treatment rationale.',
    'Organize the response under: Presentation, Hospital Course, Diagnoses and Problems, Key Medications, Investigations, and Follow-up / Open Items.',
    'Use no more than 3 short bullets per heading. Summarize medication courses and clinically important changes instead of listing every order.',
    'Copy recorded clinical wording exactly. Never expand abbreviations, identify organisms, correct drug names, or add a parenthetical interpretation. If a record says "CONS", write "CONS"; do not guess what it means. Never use "likely", "probably", or similar speculation.',
    'If a category has no supporting data, say "Not recorded". Preserve uncertainty and distinguish note content from structured orders.',
    'Return plain text with short headings and bullets. Do not include patient identifiers beyond the episode facts provided.',
    'Recorded episode data:',
    JSON.stringify(source, null, 2),
  ].join('\n\n');
}

export async function generateEpisodeSummary(patient) {
  const apiKey = process.env.BHARATCODE_API_KEY || process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
  if (!apiKey) throw Object.assign(new Error('AI summary is not configured: set BHARATCODE_API_KEY on the server.'), { status: 503 });

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You are a careful clinical documentation assistant. Never fabricate clinical facts.' },
        { role: 'user', content: promptFor(patient) },
      ],
      max_tokens: 1024,
      temperature: 0.1,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(`AI summary provider returned HTTP ${response.status}: ${detail}`);
    error.status = response.status >= 500 ? 502 : response.status;
    throw error;
  }

  const body = await response.json();
  const summary = body.choices?.[0]?.message?.content?.trim();
  if (!summary) throw Object.assign(new Error('AI summary provider returned no summary.'), { status: 502 });
  return { summary, model: MODEL };
}
