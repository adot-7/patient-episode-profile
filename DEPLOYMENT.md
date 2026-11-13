# Deployment

The service is packaged as a small Docker image. It binds to `127.0.0.1:3002` on the host by default so a reverse proxy can place it behind the EHR's existing access controls.

## Render

The repository includes `render.yaml`. Create the service from the Render Blueprint flow:

```text
https://dashboard.render.com/blueprint/new?repo=https://github.com/adot-7/patient-episode-profile
```

After selecting the repository, enter `GEMINI_API_KEY` as a secret environment
variable. The Blueprint selects Gemini Flash-Lite and enables labelled,
source-derived facts when Gemini is unavailable or rejected by source checks.
It disables laptop-local Ollama fallback because the Render service cannot reach
the developer machine's loopback interface. No paid provider is used as a fallback.
Render then deploys commits pushed to `main` automatically. `/api/health` includes
the selected provider and `RENDER_GIT_COMMIT` revision for release verification.

## Docker Compose

On the host that can reach Sansys:

```sh
git clone git@github.com:adot-7/patient-episode-profile.git
cd patient-episode-profile
cp .env.example .env
```

Edit `.env` to use the Sansys address reachable from that host. Confirm the direct Sansys path before launching:

```sh
curl -m 15 -o /dev/null -w '%{http_code} %{time_total}s\n' \
  'http://182.70.249.137:5050/patientHome/load-demographics/<known-test-dfn>?userId=1'
```

Then build and start:

```sh
docker compose up -d --build
docker compose ps
docker compose logs -f patient-episode-profile
```

Check the service on the host:

```sh
curl -fsS http://127.0.0.1:3002/api/health
curl -fsS http://127.0.0.1:3002/api/health/sansys
```

The health endpoint returns connection status and timing, not patient details. To deploy a later commit, run `git pull --ff-only` followed by `docker compose up -d --build`.

## Mount under the EHR host

Set the app URL prefix in `.env` before the image is built:

```dotenv
APP_BASE_PATH=/patient-profile/
```

Rebuild with `docker compose up -d --build`. Configure the existing Nginx virtual host to preserve the `/patient-profile/` path when proxying to the local container:

```nginx
location /patient-profile/ {
    proxy_pass http://127.0.0.1:3002;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

This makes the app available at `https://<existing-ehr-host>/patient-profile/`; its API is namespaced under `/patient-profile/api`, so it does not collide with the discharge-summary API. Keep the route behind the same authenticated ingress used by the EHR. Do not expose port 3002 directly to the public internet.

When embedded from the EHR, pass both the patient DFN and current episode:
`/patient-profile/?dfn=<dfn>&episodeId=<episode-id>`. The explicit episode ID is used even when the Sansys discovery response only returns the placeholder visit.

## Without Docker

With Node.js 20 installed:

```sh
npm ci
cp .env.example .env
npm run build
npm start
```

For a persistent host service, run `node server/index.js` with the repo as its working directory and load the variables from `.env` or the service manager. Configure Nginx to proxy to `127.0.0.1:3002` as above.

## Runtime settings

Local Ollama requires a reachable, separately running Ollama instance with the configured model installed. For Docker, `127.0.0.1` refers to the app container, not the host: set `OLLAMA_BASE_URL` to an Ollama service URL reachable from the container. Render's small app service does not include a 7B local model; use a configured Gemini/cloud provider or a separately hosted inference service there.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3002` | Container/service listen port |
| `APP_BASE_PATH` | `/` | Public URL root; use `/patient-profile/` for an EHR subpath |
| `SANSYS_BASE_URL` | `http://182.70.249.137:5050` | Sansys read API base URL |
| `SANSYS_HEALTH_DFN` | empty | Optional known DFN used by the Sansys connectivity probe |
| `SANSYS_TIMEOUT_MS` | `30000` | Per-request Sansys timeout |
| `AI_PROVIDER` | `auto` in code; `gemini` on Render; `ollama` in local example | `ollama`, `gemini`, `bharatcode`, `anthropic`, or legacy `auto` fallback |
| `AI_CACHE_MS` | `300000` | In-memory successful-summary cache TTL; `0` disables caching |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Reachable local inference service |
| `OLLAMA_MODEL` | `qwen2.5:7b` | Installed local model |
| `OLLAMA_TIMEOUT_MS` | `300000` | Local generation timeout after a job starts |
| `OLLAMA_NUM_CTX` | `16384` | Local context window |
| `GEMINI_API_KEY` | empty | Server-only Gemini key; required in Gemini mode |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Configurable Gemini model; free-tier eligibility depends on Google project |
| `GEMINI_REASONING_EFFORT` | model-dependent | `minimal` for Flash-Lite, otherwise `low`; leave empty for defaults |
| `GEMINI_LOCAL_FALLBACK` | `false` | Use labelled local evidence if Gemini is unavailable or fails source checks; requires reachable Ollama |
| `GEMINI_FACTS_FALLBACK` | `true` in deployment examples | Serve labelled source-derived facts without AI generation when Gemini/local inference is unavailable |
| `GEMINI_TIMEOUT_MS` | `60000` | Gemini generation timeout |
| `BHARATCODE_API_KEY` | empty | Primary AI provider key; server-only |
| `BHARATCODE_MODEL` | `qwen-3.8-27b` | Primary BharatCode model |
| `BHARATCODE_BASE_URL` | `https://bharatcode.ai/api/model/v1` | Primary AI provider URL |
| `BHARATCODE_TIMEOUT_MS` | `180000` | Primary AI request timeout |
| `ANTHROPIC_API_KEY` | empty | Fallback AI provider key; server-only |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | Fallback model; keep this on Haiku |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Anthropic API URL |
| `ANTHROPIC_TIMEOUT_MS` | `60000` | Fallback AI request timeout |
| `PROFILE_BIND_ADDRESS` | `127.0.0.1` | Host address published by Compose |
| `PROFILE_HOST_PORT` | `3002` | Host-side port published by Compose |
