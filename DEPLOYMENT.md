# Deployment

The service is packaged as a small Docker image. It binds to `127.0.0.1:3002` on the host by default so a reverse proxy can place it behind the EHR's existing access controls.

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
  'http://182.70.249.137:5050/patientHome/load-demographics/PAT123456?userId=1'
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

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3002` | Container/service listen port |
| `APP_BASE_PATH` | `/` | Public URL root; use `/patient-profile/` for an EHR subpath |
| `SANSYS_BASE_URL` | `http://182.70.249.137:5050` | Sansys read API base URL |
| `SANSYS_TIMEOUT_MS` | `30000` | Per-request Sansys timeout |
| `PROFILE_BIND_ADDRESS` | `127.0.0.1` | Host address published by Compose |
| `PROFILE_HOST_PORT` | `3002` | Host-side port published by Compose |
