const choices = ['yes', 'no', 'abstain'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const totals = `COUNT(b.voter_id) AS total,
  COALESCE(SUM(b.choice = 'yes'), 0) AS yes,
  COALESCE(SUM(b.choice = 'no'), 0) AS no,
  COALESCE(SUM(b.choice = 'abstain'), 0) AS abstain`;

function json(data, status = 200, extra = {}) {
  return Response.json(data, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra,
  } });
}

// Deliberately public admin controls: this is a casual, trusted-group voting room.
// Same-origin checks prevent another website from silently operating this room.
export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '').replace('/api/vote', '') || '/';
  if (!env.VOTES) return json({ error: 'Voting is not configured yet.' }, 503);
  let voter = request.headers.get('Cookie')?.match(/(?:^|;\s*)vote_id=([^;]+)/)?.[1];
  const newVoter = !voter || !uuid.test(voter);
  if (newVoter) voter = crypto.randomUUID();
  const cookie = newVoter ? { 'Set-Cookie': `vote_id=${voter}; Path=/api/vote; HttpOnly; SameSite=Lax; Max-Age=31536000${url.protocol === 'https:' ? '; Secure' : ''}` } : {};
  // All reads come from primary, including immediately after closing or resetting.
  const db = env.VOTES.withSession ? env.VOTES.withSession('first-primary') : env.VOTES;
  try {
    if (request.method === 'GET' && (path === '/' || path === '/admin')) {
      const round = await db.prepare(`SELECT r.*, ${totals},
        (SELECT choice FROM ballots WHERE round_id = r.id AND voter_id = ?) AS my_vote
        FROM rounds r LEFT JOIN ballots b ON b.round_id = r.id
        WHERE r.active = 1 GROUP BY r.id`).bind(voter).first();
      if (round && (round.status === 'open' || (path !== '/admin' && !round.show_results))) {
        delete round.yes; delete round.no; delete round.abstain;
      }
      return json({ round }, 200, cookie);
    }
    if (request.method === 'GET' && path === '/history') {
      const before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(before) || before < 1) return json({ error: 'Invalid history cursor.' }, 400);
      const { results } = await db.prepare(`SELECT r.rowid AS cursor, r.*, ${totals} FROM rounds r
        LEFT JOIN ballots b ON b.round_id = r.id
        WHERE r.status = 'closed' AND r.rowid < ?
          AND r.closed_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
        GROUP BY r.id
        ORDER BY r.rowid DESC LIMIT 21`).bind(before).all();
      // Use a monotonically increasing rowid for stable pagination even with equal timestamps.
      const page = results.slice(0, 20);
      return json({ rounds: page, next: results.length > 20 ? page[19].cursor : null });
    }
    if (request.method !== 'POST') return json({ error: 'Not found.' }, 404);
    if (request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
      return json({ error: 'Please use the voting page to make changes.' }, 403);
    }
    if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({ error: 'Expected JSON.' }, 415);
    const raw = await request.text();
    if (raw.length > 4096) return json({ error: 'Message is too long.' }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: 'Invalid request.' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid request.' }, 400);
    if (path === '/start') {
      if (typeof body.question !== 'string' || body.question.length > 1000 || typeof body.showResults !== 'boolean') return json({ error: 'Use a message of 1,000 characters or fewer.' }, 400);
      const id = crypto.randomUUID();
      const result = await db.prepare(`INSERT INTO rounds(id, question, status, show_results)
        SELECT ?, ?, 'open', ? WHERE NOT EXISTS (SELECT 1 FROM rounds WHERE active = 1)`)
        .bind(id, body.question.trim(), Number(body.showResults)).run();
      if (!result.meta.changes) return json({ error: 'There is already a round. Reset it before starting another.' }, 409);
      return json({ ok: true, id }, 200, cookie);
    }
    if (!uuid.test(body.roundId || '')) return json({ error: 'This round is no longer available.' }, 409);
    let result;
    if (path === '/ballot') {
      if (!choices.includes(body.choice)) return json({ error: 'Choose Yes, No, or Abstain.' }, 400);
      // The open/active guard and vote write are one SQL statement: closing wins
      // over late requests, and an edit replaces rather than adds a ballot.
      result = await db.prepare(`INSERT INTO ballots(round_id, voter_id, choice)
        SELECT id, ?, ? FROM rounds WHERE id = ? AND active = 1 AND status = 'open'
        ON CONFLICT(round_id, voter_id) DO UPDATE SET choice = excluded.choice`)
        .bind(voter, body.choice, body.roundId).run();
    } else if (path === '/withdraw') {
      result = await db.prepare(`DELETE FROM ballots WHERE round_id = ? AND voter_id = ?
        AND EXISTS (SELECT 1 FROM rounds WHERE id = ballots.round_id AND active = 1 AND status = 'open')`)
        .bind(body.roundId, voter).run();
    } else if (path === '/end') {
      result = await db.prepare(`UPDATE rounds SET status = 'closed', closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND active = 1 AND status = 'open'`).bind(body.roundId).run();
    } else if (path === '/reset') {
      result = await db.prepare(`UPDATE rounds SET active = 0 WHERE id = ? AND active = 1 AND status = 'closed'`).bind(body.roundId).run();
    } else if (path === '/visibility') {
      if (typeof body.showResults !== 'boolean') return json({ error: 'Invalid setting.' }, 400);
      result = await db.prepare(`UPDATE rounds SET show_results = ? WHERE id = ? AND active = 1`)
        .bind(Number(body.showResults), body.roundId).run();
    } else return json({ error: 'Not found.' }, 404);
    if (!result.meta.changes) return json({ error: 'The round changed or voting has ended. Your page will update.' }, 409);
    return json({ ok: true }, 200, cookie);
  } catch (error) {
    console.error('Voting request failed', error);
    return json({ error: 'Could not reach voting. Please try again.' }, 503);
  }
}
