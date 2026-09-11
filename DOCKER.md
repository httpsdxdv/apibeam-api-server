# ApiBeam API Server - Docker

Build and run locally:

```bash
docker compose up -d --build
```

The server binds only to host loopback by default:

```text
http://127.0.0.1:3000
```

Environment variables:

- `APIBEAM_PORT` - host port, default `3000`.
- `APIBEAM_REQUEST_TIMEOUT_MS` - request timeout, default `180000`.
- `APIBEAM_MODELS` - comma-separated model IDs returned by local `/models`, default `gpt-5.6-sol,gpt-4o`.
- `CORS_ORIGINS` - optional comma-separated extra browser origins.

Health check:

```text
GET /app/health
```
