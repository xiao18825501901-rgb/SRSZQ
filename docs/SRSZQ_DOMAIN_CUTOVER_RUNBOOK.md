# SRSZQ.NET production cutover runbook

Run this only after the user confirms all three prerequisites: `srszq.net` is registered, its real-name status is normal, and ICP filing is approved. Until then, certificate issuance, public DNS changes, Nginx enablement and Netlify custom domains remain blocked.

## 1. Create DNS records

Create the backend record at the authoritative DNS provider:

```text
api    A    47.114.34.175
```

In Netlify, add `srszq.net` and `www.srszq.net`, then use the exact apex and `www` targets shown in the Netlify UI at cutover time. Do not hard-code an old Netlify IP.

## 2. Verify public DNS

```bash
dig +short api.srszq.net A
nslookup api.srszq.net
```

Require the public A result to be `47.114.34.175`. Verify the apex and `www` records against Netlify's current instructions from at least two public resolvers.

## 3. Enable the backend Nginx server block

On the ECS:

```bash
cd /var/www/SRSZQ
install -m 644 ops/nginx/api.srszq.net.conf.template /etc/nginx/sites-available/api.srszq.net
ln -s /etc/nginx/sites-available/api.srszq.net /etc/nginx/sites-enabled/api.srszq.net
nginx -t
systemctl reload nginx
```

Keep `/etc/nginx/sites-enabled/srszq-api` as the IP fallback. If `nginx -t` fails, remove only the new symlink and restore the prior known-good configuration before reloading.

## 4. Issue the backend certificate

Only after DNS is correct and ICP is approved:

```bash
certbot --nginx -d api.srszq.net
```

Re-run `nginx -t`, confirm the Certbot renewal timer is enabled, and verify the generated HTTPS redirect/server blocks before closing the maintenance session.

## 5. Verify HTTPS

```bash
curl -fsS -D - https://api.srszq.net/ -o /dev/null
```

The root application route currently returns a JSON 404, so transport success and a valid certificate matter more than a 2xx status on `/`. Confirm the certificate hostname, chain and expiry.

## 6. Verify secure WebSocket

Connect to `wss://api.srszq.net/ws` and require an HTTP 101 upgrade followed by the expected unauthenticated rejection message. Verify through the public hostname, not only loopback.

## 7. Confirm Netlify variables

```text
VITE_API_URL=https://api.srszq.net
VITE_WS_URL=wss://api.srszq.net/ws
```

These values are already prepared. If changed, trigger a new production deployment and confirm them in the built JavaScript without exposing any secrets.

## 8. Activate frontend custom domains

In Netlify, require both `srszq.net` and `www.srszq.net` to show correct DNS and active managed TLS. Choose the canonical hostname and configure the other as a redirect in Netlify.

## 9. Run the full production gate

```bash
cd /var/www/SRSZQ
node scripts/smoke-production.mjs
pm2 status
systemctl is-active nginx pm2-root srszq-backup.timer
ss -ltnp
```

Then verify externally:

- `https://srszq.net` and `https://www.srszq.net` load with valid TLS.
- Registration, login and a real three-player WebSocket match work through the final hostnames.
- Browser console and network panel show no mixed content, CORS or WebSocket errors.
- A fresh verified database backup is created after cutover.

## Rollback

If backend hostname validation fails, disable only `/etc/nginx/sites-enabled/api.srszq.net`, validate Nginx, reload it, and retain the IP fallback. If the frontend cutover fails, keep `srszq.netlify.app` available and correct or remove only the new Netlify/DNS mappings. Do not modify the database and do not force-push Git history.
