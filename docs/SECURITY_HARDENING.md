# SRSZQ production security status

Verified on 2026-09-06 after a controlled ECS reboot.

## Implemented controls

| Control | Verified state |
|---|---|
| API listener | `127.0.0.1:8080` only |
| WebSocket listener | `127.0.0.1:8081` only |
| Public OS listeners | SSH 22 and Nginx HTTP 80; no listener on 443 yet |
| SSH password authentication | Disabled |
| PM2 recovery | `pm2-root` enabled and active; reboot test passed |
| Nginx recovery | Enabled and active; reboot test passed |
| Database | Integrity `ok`; root-owned mode `0600` |
| Nginx headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` |
| PM2 log rotation | Daily, seven rotations, compression, copy-truncate |
| Nginx log rotation | Ubuntu native policy present |
| Dependency audit | 0 vulnerabilities at release commit `faf4b4e` |
| Repository secret scan | 144 tracked files and 22 commits scanned; no high-confidence secrets found |

The versioned IP fallback Nginx configuration and active server file have the same SHA-256: `056f68d948b7b5098ddc44d0a3120cdde0aa52cd695285694243af2e1a672884`.

## Pending controls

`MANUAL_HARDENING_PENDING`:

- SSH permits root login by public key. Create and test a separate sudo administrator account before changing `PermitRootLogin`; keep a second verified session open during the change to prevent lockout.
- Fail2ban is not active. Configure it only after confirming the administrator access plan and allowlisting any required management source.
- API CORS uses an explicit production allowlist for `srszq.com`, `www.srszq.com`, and the temporary Netlify fallback. Changes must pass the full integration suite before deployment.
- Alibaba Cloud security-group rules were not changed in this work. Confirm in the Alibaba console that 8080 and 8081 have no inbound rules and that 22/80/443 are limited according to the operating policy.
- TLS/HSTS can be enabled after the ECS expiry gate and public DNS validation pass. Hong Kong production does not require the mainland ICP workflow.
- Backups need an encrypted off-server copy before the database has irreplaceable user data.

## Verification commands

```bash
ss -ltnp
sshd -T | grep -E '^(passwordauthentication|permitrootlogin|pubkeyauthentication) '
nginx -t
curl -sSI http://127.0.0.1/
pm2 status
systemctl is-enabled pm2-root nginx srszq-backup.timer
systemctl is-active pm2-root nginx srszq-backup.timer
logrotate --debug /etc/logrotate.d/srszq-pm2
npm audit --audit-level=high
node scripts/smoke-production.mjs
```

Do not bind API or WebSocket services to `0.0.0.0`. Do not enable HSTS before HTTPS is working on the final hostname.
