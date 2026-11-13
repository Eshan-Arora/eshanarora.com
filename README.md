# eshanarora.com

Static Astro site hosted on Cloudflare Pages.

## Voting

- `/vote`: phone-friendly Yes / No / Abstain ballots. Change vote withdraws the recorded ballot and lowers the count before showing the choices; closed rounds cannot be changed.
- `/vote/admin`: public controls, QR code, live participation, results, and history.
- Optional text describes the current question. Results are shown to voters after closing only when enabled.
- Reset archives the closed round; it does not delete history. The admin shows only rounds finished in the past 24 hours. Only one round can be active.
- Admin is intentionally unauthenticated. Anyone can start/end/reset rounds, view history, or change result visibility. Hidden results are a presentation choice, not a privacy boundary.
- A first-party HTTP-only cookie remembers a browser. It is not one-person-one-vote enforcement.
- Phones poll once a second while visible. Votes and closing are guarded atomically in SQL; old tabs cannot vote in a new round.
- Only `/api/vote` paths invoke Pages Functions. The rest of the site remains static.

### Local development

Install dependencies with `npm ci`, then run:

```sh
npm run dev
```

This initializes local D1, builds the site, and serves the site and voting API on
all network interfaces at port 8788. It watches frontend source files, rebuilds
on edits, and reloads connected pages. Functions reload through Wrangler.

Open the printed network URL on a phone connected to the same Wi-Fi. Use the
Mac’s network address, not `localhost`, on the phone. The development QR code
and join link point at that network URL. Keep this process and the Mac running.
Some guest networks isolate devices; those networks will block phone access.
Restart the dev command if the Mac’s network address changes.

Local voting data persists in `.wrangler/`, separate from production D1.
`npm run vote:dev` is an alias. `npm run dev:astro` provides the plain Astro
frontend server without the voting API. Set `PORT` to choose another dev port.
Ordinary production builds keep the QR code pointed at eshanarora.com.

Run voting lifecycle tests:

```sh
npm run test:vote
```

### Cloudflare setup

The `VOTES` binding in `wrangler.jsonc` connects the Pages Functions to D1.
Production uses `eshanarora-votes`; preview deployments use the separate
`eshanarora-votes-preview` database through `env.preview`. Both are in the personal
Cloudflare account. No application secrets or database passwords are needed.
Apply migrations before deploying schema changes:

```sh
npx wrangler d1 migrations apply VOTES --remote
```

```sh
npm run build &&
npx wrangler pages deploy dist --project-name eshanarora-com
```

For the preview database, use `npx wrangler d1 migrations apply VOTES --remote --env preview`.
The existing Pages GitHub integration deploys `main` to production and other branches to previews.
Keep the migration files in source control; schema changes are applied explicitly.
