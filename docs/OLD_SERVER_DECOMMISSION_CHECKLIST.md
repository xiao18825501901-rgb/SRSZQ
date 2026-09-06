# Old Hangzhou ECS decommission checklist

Do not cancel `47.114.34.175` until every item is complete:

- [ ] Hong Kong production has remained healthy for 24–72 hours.
- [ ] No authoritative or recursive DNS answer points to `47.114.34.175`.
- [ ] A fresh, verified archival SQLite backup has been taken from the old server.
- [ ] Required configuration and operational evidence have been archived.
- [ ] Old `srszq-backend` PM2 process has been stopped.
- [ ] The user has explicitly approved ECS cancellation.

After the first production write on Hong Kong, never restore the old Hangzhou database over the Hong Kong database.
