# Patient Episode Profile

A read-only, episode-by-episode patient overview for clinicians. The overview puts a short factual synthesis, episode timeline, medication history, allergies, and vital trends first. Each episode can also produce a bounded AI draft for clinician review. The app does not edit, approve, or write back clinical data.

## Prerequisites

- Node.js 20 or later
- Network access to the Sansys read API (defaults to `http://182.70.249.137:5050`)

This application talks directly to Sansys through its own server adapter. It does not require the discharge-summary application to be running. Each episode can also request an AI-generated factual summary from the server; the API key never reaches the browser.

## Run locally

```sh
npm install
npm run dev
```

Copy `.env.example` to `.env` first if the Sansys endpoint, URL base path, or local port differs from the defaults. The single development command starts both the profile API and Vite; open the Vite URL, typically `http://localhost:5173`.

Run checks with:

```sh
npm test
```

`GET /api/health` checks the local server; `GET /api/health/sansys` checks the configured Sansys service without returning patient details.

## Production

```sh
npm run build
npm start
```

The included Express server serves the production UI and reads Sansys directly. Set `PORT`, `APP_BASE_PATH`, `SANSYS_BASE_URL`, and `SANSYS_TIMEOUT_MS` in `.env` as needed. The profile keeps data in browser memory and a short-lived in-process cache only; it does not persist patient information or call write endpoints.

## Deploy

Container deployment files are included. See [DEPLOYMENT.md](./DEPLOYMENT.md) for Docker Compose, same-host URL-prefix mounting, and Oracle/Nginx instructions.

## Clinical presentation

- Use the side navigation to open the patient overview or any recorded episode.
- The first screen prioritizes the longitudinal summary, allergy record, episode timeline, vital trends, and grouped medication courses.
- Episode pages put a concise episode brief and vitals before diagnoses, problems, medication records, and investigation orders.
- Lab and radiology entries are labelled as orders; this feed does not provide result interpretation.
- Long clinical-note text is tucked into a collapsed note index; provenance is in a separate collapsed appendix at the end.
- A clinical-review notice explains that this record summary does not replace source-chart verification.

The application has its own read-only Sansys adapter and does not require the discharge-summary server.

Open the app with `?dfn=<patient-id>` to prefill a patient from an EHR link, for example `?dfn=081070175`. Pass `&episodeId=<episode-id>` when the EHR already knows the selected episode, for example `?dfn=081070175&episodeId=1-19337733`. The app does not contain a patient-specific default.

## AI episode summaries

### Local, no API credits

Install/run Ollama and pull `qwen2.5:7b`. For local Node development, set:

```dotenv
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:7b
OLLAMA_TIMEOUT_MS=300000
OLLAMA_NUM_CTX=16384
AI_CACHE_MS=300000
```

Local mode never calls BharatCode, Anthropic, or Gemini, even if their keys are present. It serializes inference and uses bounded input. Because the tested small local models invented clinical claims when asked for free-form prose, local mode asks the model to select evidence IDs, then renders the exact dated source excerpts. Unsupported selections are rejected. This is an AI-selected extractive draft, not the same narrative synthesis as cloud mode, and it is labelled accordingly in the UI.

Successful summaries are cached in memory for five minutes (maximum 32 entries), with concurrent identical requests deduplicated. A source/provider change invalidates the cache key; **Regenerate** bypasses completed cached responses. No summaries or API keys are persisted by the cache.

### Gemini free-tier option

Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/api-keys) and use an eligible free-tier project. Then set:

```dotenv
AI_PROVIDER=gemini
GEMINI_API_KEY=<server-only-key>
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_TIMEOUT_MS=60000
```

Gemini mode uses structured cloud narrative synthesis and never falls through to a paid Anthropic/BharatCode account. Google controls project quotas, model eligibility, and billing; selecting Gemini does not itself guarantee the project is free. Google's [pricing](https://ai.google.dev/gemini-api/docs/pricing) lists free-tier content as used to improve its products. Use synthetic or de-identified demo records on that tier. View actual project limits in [AI Studio](https://aistudio.google.com/rate-limit).

Thinking effort defaults to `minimal` for Flash-Lite and `low` for other Gemini models; `GEMINI_REASONING_EFFORT` can override it. Models can reject unsupported effort levels even when they appear in the available-model list.

Source checks reject known date/status contradictions, invented laboratory values, mismatched complaint remarks, and vital dates borrowed from order dates. Gemini gets at most one correction attempt for invalid output; quota/authentication failures are not retried. These checks cover specific failure patterns, not arbitrary clinical semantics. With `GEMINI_LOCAL_FALLBACK=true` and a reachable Ollama instance, outages or repeatedly rejected narratives produce a clearly labelled local evidence-selection response instead. The flag defaults to `false` for deployments without local inference.

The Render blueprint instead sets `GEMINI_FACTS_FALLBACK=true`: cloud outages or rejected summaries return dated recorded-source highlights with `provider: "recorded"` and `summaryMode: "recorded-facts"`. They are explicitly labelled as not AI-generated. This fallback does not contact Ollama or any paid AI provider, and source records remain read-only.

### Reproducible live checks

`npm test` uses fixtures and does not call live AI providers. The optional `test/liveModels.js` audit can capture a source snapshot, compare explicit providers against the same data, and exercise separate, labelled platelet/history fixtures:

```sh
node test/liveModels.js --provider=capture --dfn=<test-patient-id> --out=/tmp/opencode/model-source.json
node test/liveModels.js --provider=gemini --source=/tmp/opencode/model-source.json --out=/tmp/opencode/gemini-audit.json
node test/liveModels.js --provider=ollama --source=/tmp/opencode/model-source.json --out=/tmp/opencode/local-audit.json
```

Audit files contain clinical source data/output and are written with owner-only permissions. Keep them outside the repository. `--case=<regex>` limits live cases; `--review=<prior-report>` reruns checks on saved outputs without new generation. Audits test the named provider alone by default; `--fallback=true` includes the application fallback and identifies it through response metadata.

### Existing cloud providers

`AI_PROVIDER=auto` preserves the original BharatCode → Anthropic fallback. `AI_PROVIDER=bharatcode` or `AI_PROVIDER=anthropic` selects only that provider. There is no automatic cloud fallback from local mode.

Set these variables on the server process, never in client code:

During local development, `.env` values override inherited shell values so edited API keys take effect after restarting the server. With `NODE_ENV=production`, hosted environment variables retain precedence.

```sh
BHARATCODE_API_KEY=<server-only-key>
BHARATCODE_MODEL=qwen-3.8-27b
BHARATCODE_BASE_URL=https://bharatcode.ai/api/model/v1
BHARATCODE_TIMEOUT_MS=180000
ANTHROPIC_API_KEY=<server-only-fallback-key>
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_TIMEOUT_MS=60000
```

The episode page's AI summary action calls `POST /api/patients/:dfn/episode-summary`. In `auto` mode, BharatCode is tried first; if it is missing or fails, the server uses Anthropic Haiku when `ANTHROPIC_API_KEY` is configured. The model receives bounded episode notes plus normalized diagnoses, problems, medications, investigations, allergies, complaints, and vitals. The result is a draft for clinician review; the app does not write it back to Sansys.

AI responses must contain all six expected sections. Anthropic requests use constrained JSON output with fixed short item slots. Truncated or malformed responses are rejected instead of being displayed as complete summaries. Provider billing failures are reported separately from authentication errors. Prompt serialization omits repetitive provenance metadata while retaining clinical facts and dates; full provenance remains in the source view.

The patient overview generates a separate cross-episode synthesis through `POST /api/patients/:dfn/longitudinal-summary`. The server fetches the selected episode records itself, orders the evidence chronologically, and bounds the input (up to 30 episodes, with sampled note details). The overview displays the connected clinical story, dated timeline, investigation trends, medication course, and evidence-linked monitoring considerations. These considerations are not a validated predictive risk model; missing inputs and partial episode coverage remain visible.

Social and family history are extracted only from explicitly labelled, non-empty clinical-note answers, with note date/title and episode attribution. Missing history is shown as undocumented in the retrieved details.

Laboratory result values, units, reference ranges, flags and result timestamps are preserved when included in order or note data. Exact numeric, dated results can be graphed by test and unit; order timestamps are never substituted for result timestamps. The clinical-focus filter highlights haematology, glucose, renal or liver results without assigning a diagnosis. The current PAT123456 `/lab/list` feed supplies order metadata and `isResult` flags but no actual values. A working Sansys result/report endpoint is still required to retrieve those missing reports; a result flag alone cannot produce a platelet trend.
