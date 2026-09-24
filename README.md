# Patient Episode Profile

A separate, read-only application for reviewing a patient's longitudinal profile across Sansys inpatient episodes. It presents episode summaries, source-linked notes and records, medication/condition history, and vital-sign trends. It does not generate, edit, approve, or write back a clinical summary.

## Prerequisites

- Node.js 20 or later
- The Sansys discharge-summary API running at `http://localhost:3001` (or configure `SANSYS_BACKEND_URL`)

The API must include the opt-in `includeNoteDetails=true` support from the Sansys project. Default patient requests continue to defer note details.

## Run locally

```sh
npm install
npm test
npm run dev
```

Vite proxies `/api` to `SANSYS_BACKEND_URL` (defaults to `http://localhost:3001`). The application opens at the Vite URL, typically `http://localhost:5173`.

## Production

```sh
npm run build
PORT=3002 SANSYS_BACKEND_URL=http://localhost:3001 npm start
```

The included Express server serves the production UI and forwards read-only `GET`/`HEAD` `/api` requests to the configured Sansys service. It rejects API writes. The profile keeps data in browser memory only and does not persist patient information.

## Clinical presentation

- Use the side navigation to open the patient overview or any recorded inpatient episode.
- The overview consolidates exact recorded diagnoses/problems, medication records and status/course dates, and longitudinal vital trends.
- Episode pages show the recorded diagnosis, complaints, notes, medication orders, lab/radiology orders, and vitals.
- Lab and radiology entries are labelled as orders; this feed does not provide result interpretation.
- Each note and structured record can expose its source provenance.
- A persistent clinical-review notice explains that the profile is a navigation aid and does not replace the source chart or clinician verification.

The local profile repository is intentionally independent. Its API bridge consumes the existing Sansys service; deploy both behind the same authenticated clinical environment and route `/api` through the bridge.
