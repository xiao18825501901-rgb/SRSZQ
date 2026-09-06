# Netlify domain cutover status

## Current production frontend

- Site: `srszq`
- Site ID: `8ba9ce96-b7ec-409a-965c-10d6e2335bf2`
- Public URL: `https://srszq.netlify.app`
- Git branch: `main`
- Build command: `npm run build`
- Publish directory: `frontend/dist`
- Node: 24
- Verified deployment: `faf4b4ef75d90bc1236691e512e56267f98864b2`, state `ready`
- Verified public response: HTTPS 200

The production build is prepared with:

```text
VITE_API_URL=https://api.srszq.net
VITE_WS_URL=wss://api.srszq.net/ws
```

The Netlify environment variables and `netlify.toml` were updated, and the deployed JavaScript bundle was checked for both `.net` values.

`BACKEND_DOMAIN_NOT_YET_ACTIVE`: `api.srszq.net` is not registered, filed, resolved or serving TLS. The frontend can load at the Netlify URL, but production backend features cannot use the planned hostname yet.

No custom domain has been added. Do not add `srszq.net` or `www.srszq.net` until the user confirms domain registration and ICP approval.

## Cutover procedure

1. Confirm `srszq.net` registration, real-name state and ICP approval.
2. Open the Netlify domain-management page and add `srszq.net` and `www.srszq.net`.
3. Copy the exact DNS targets Netlify shows at that time. Do not reuse historical Netlify IP addresses.
4. Create the required records at the authoritative DNS provider.
5. Wait until Netlify reports both domains configured and its managed certificates are active.
6. Reconfirm the two `.net` build variables and trigger a production deploy only if their values changed.
7. Verify the apex, `www`, API and WebSocket paths from an external network.

If a cutover validation fails, leave `srszq.netlify.app` available, remove or correct only the new DNS/custom-domain records, and keep the backend IP fallback until diagnosis is complete.
