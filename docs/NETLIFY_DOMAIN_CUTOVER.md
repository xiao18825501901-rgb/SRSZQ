# Netlify production domain cutover

The fallback site remains https://srszq.netlify.app during migration.

Production build variables:

- VITE_API_URL=https://api.srszq.com
- VITE_WS_URL=wss://api.srszq.com/ws

Final custom domains are srszq.com and www.srszq.com. Add both in Netlify only after the Hong Kong ECS expiry gate passes. Read the current external-DNS instructions from Netlify and copy those exact apex and www records to JulyDNS. Set srszq.com as the primary domain and redirect www.srszq.com to it.

Do not remove the fallback until the 24-72 hour observation window has passed.
