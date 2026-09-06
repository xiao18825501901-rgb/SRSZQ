# SRSZQ.com Hong Kong production cutover

This runbook applies to the shared Hong Kong ECS at `8.210.58.22`. Caddy already owns public ports 80 and 443 for other services, so it remains the public TLS edge. SRSZQ Nginx listens only on `127.0.0.1:9080` and proxies API and WebSocket traffic to `127.0.0.1:8080` and `127.0.0.1:8081`.

## Preconditions

- The ECS expiry has been confirmed as safely beyond the observation period. If it is still near `2026-09-13 23:59:59`, stop with `BLOCKED_BY_SERVER_EXPIRY`.
- `/var/www/SRSZQ` is clean, on `main`, and matches the green GitHub CI commit.
- The migrated database passes `PRAGMA integrity_check` and matches the old-server table counts.
- Local API, WS, Nginx Host-header checks, PM2 boot recovery, and backup restore tests pass.

## Backend DNS and TLS

1. Add `api.srszq.com A 8.210.58.22` at the authoritative JulyDNS zone.
2. Require multiple public resolvers to return `8.210.58.22`.
3. Append `ops/caddy/api.srszq.com.caddy` to the existing Caddyfile, validate it, back up the current file, and reload Caddy.
4. Require a valid public certificate, HTTP-to-HTTPS redirect, API response, and WSS connection.

Caddy manages this certificate because it already terminates TLS on the shared host. Certbot is installed for compatibility but must not be made to take ports 80 or 443 from Caddy.

## Frontend

The Netlify production build uses `https://api.srszq.com` and `wss://api.srszq.com/ws`. Keep `https://srszq.netlify.app` available during rollback. Add `srszq.com` and `www.srszq.com` in Netlify, read the current external-DNS instructions from Netlify, and enter those exact records at JulyDNS. Set `srszq.com` as primary and require `www.srszq.com` to redirect to it.

## Acceptance and rollback

Run `scripts/smoke-hk-production.sh`, the authenticated persistence smoke, and the browser E2E suite. If backend cutover fails, remove only the new Caddy block or correct the `api` record. If frontend cutover fails, retain the Netlify fallback while correcting its custom-domain records. Keep the old Hangzhou ECS for 24–72 hours, but once Hong Kong receives new writes, its database is the only source of truth.
