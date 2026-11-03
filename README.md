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

Set these variables on the server process, never in client code:

```sh
BHARATCODE_API_KEY=<server-only-key>
BHARATCODE_MODEL=qwen-3.8-27b
BHARATCODE_BASE_URL=https://bharatcode.ai/api/model/v1
BHARATCODE_TIMEOUT_MS=180000
```

The episode page's **Generate summary** action calls `POST /api/patients/:dfn/episode-summary`. The model receives bounded episode notes plus normalized diagnoses, problems, medications, investigations, allergies, complaints, and vitals. The result is a draft for clinician review; the app does not write it back to Sansys.
