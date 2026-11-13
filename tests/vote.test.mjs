import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { onRequest } from '../functions/api/vote/[[path]].js';

function room() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_votes.sql', import.meta.url), 'utf8'));
  const VOTES = { prepare(sql) {
    const statement = sqlite.prepare(sql);
    let args = [];
    const query = {
      bind(...values) { args = values; return query; },
      async first() { return statement.get(...args) || null; },
      async all() { return { results: statement.all(...args) }; },
      async run() { return { meta: { changes: statement.run(...args).changes } }; },
    };
    return query;
  } };
  const cookies = {};
  async function call(path = '', body, user = 'admin', origin = 'https://example.com') {
    const response = await onRequest({ env: { VOTES }, request: new Request(`https://example.com/api/vote${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookies[user] || '' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }) });
    if (response.headers.has('Set-Cookie')) cookies[user] = response.headers.get('Set-Cookie').split(';')[0];
    return { status: response.status, ...await response.json() };
  }
  return { call, sqlite, close: () => sqlite.close() };
}

test('complete round: independent phones, editable ballots, hidden results, closing and retained history', async () => {
  const { call, close } = room();
  try {
    assert.equal((await call()).round, null);
    const { id } = await call('/start', { question: 'Pizza?', showResults: false });
    assert.equal((await call('/start', { question: 'Duplicate', showResults: false })).status, 409);
    for (const [user, choice] of [['a','yes'], ['b','no'], ['c','abstain']]) {
      await call('', undefined, user);
      assert.equal((await call('/ballot', { roundId: id, choice }, user)).status, 200);
    }
    await call('/ballot', { roundId: id, choice: 'yes' }, 'b');
    await call('/ballot', { roundId: id, choice: 'yes' }, 'b');
    let state = (await call('/admin')).round;
    assert.equal(state.total, 3);
    assert.equal(state.yes, undefined);
    assert.equal((await call('', undefined, 'b')).round.my_vote, 'yes');
    assert.equal((await call('/reset', { roundId: id })).status, 409);
    await call('/end', { roundId: id });
    assert.equal((await call('/ballot', { roundId: id, choice: 'no' }, 'a')).status, 409);
    state = (await call('/admin')).round;
    assert.deepEqual([state.yes, state.no, state.abstain, state.total], [2, 0, 1, 3]);
    assert.equal((await call('', undefined, 'a')).round.yes, undefined);
    await call('/visibility', { roundId: id, showResults: true });
    assert.equal((await call('', undefined, 'a')).round.yes, 2);
    await call('/reset', { roundId: id });
    assert.equal((await call()).round, null);
    assert.equal((await call('/history')).rounds[0].yes, 2);
    const next = await call('/start', { question: '', showResults: false });
    assert.notEqual(next.id, id);
    assert.equal((await call('/end', { roundId: id })).status, 409);
    assert.equal((await call('/ballot', { roundId: id, choice: 'no' }, 'a')).status, 409);
    assert.equal((await call('', undefined, 'a')).round.my_vote, null);
    assert.equal((await call('/admin')).round.total, 0);
  } finally { close(); }
});

test('same-origin mutations, validation, empty rounds, stable history pagination', async () => {
  const { call, close } = room();
  try {
    assert.equal((await call('/start', { question: '', showResults: false }, 'x', 'https://elsewhere.com')).status, 403);
    assert.equal((await call('/start', { question: 'x'.repeat(1001), showResults: false })).status, 400);
    assert.equal((await call('/start', { question: '', showResults: 'false' })).status, 400);
    const ids = [];
    for (let i = 0; i < 23; i++) {
      const { id } = await call('/start', { question: `${i}`, showResults: true }); ids.push(id);
      assert.equal((await call('/ballot', { roundId: id, choice: 'maybe' })).status, 400);
      await call('/end', { roundId: id }); await call('/reset', { roundId: id });
    }
    const first = await call('/history');
    assert.equal(first.rounds.length, 20);
    assert.equal(first.rounds[0].total, 0);
    const second = await call(`/history?before=${first.next}`);
    assert.equal(second.rounds.length, 3);
    assert.equal(second.next, null);
    assert.deepEqual([...first.rounds, ...second.rounds].map(x => x.id), ids.reverse());
    assert.equal((await call('/history?before=nope')).status, 400);
  } finally { close(); }
});


test('history shows only rounds closed within the rolling past 24 hours', async () => {
  const { call, sqlite, close } = room();
  try {
    for (const age of [25, 24, 23]) {
      const { id } = await call('/start', { question: `${age} hours ago`, showResults: false });
      await call('/end', { roundId: id });
      await call('/reset', { roundId: id });
      sqlite.prepare("UPDATE rounds SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) WHERE id = ?").run(`-${age} hours`, id);
    }
    const history = await call('/history');
    assert.deepEqual(history.rounds.map(item => item.question), ['23 hours ago']);
    assert.equal(history.next, null);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM rounds').get().count, 3);
  } finally { close(); }
});

test('withdrawal removes only your open ballot and lowers the live count', async () => {
  const { call, close } = room();
  try {
    const { id } = await call('/start', { question: 'Withdraw test', showResults: false });
    await call('/ballot', { roundId: id, choice: 'yes' }, 'a');
    await call('/ballot', { roundId: id, choice: 'no' }, 'b');
    assert.equal((await call('/admin')).round.total, 2);
    assert.equal((await call('/withdraw', { roundId: id }, 'a')).status, 200);
    assert.equal((await call('/admin')).round.total, 1);
    assert.equal((await call('', undefined, 'a')).round.my_vote, null);
    assert.equal((await call('', undefined, 'b')).round.my_vote, 'no');
    assert.equal((await call('/withdraw', { roundId: id }, 'a')).status, 409);
    assert.equal((await call('/admin')).round.total, 1);
    await call('/ballot', { roundId: id, choice: 'abstain' }, 'a');
    assert.equal((await call('/admin')).round.total, 2);
    await call('/end', { roundId: id });
    assert.equal((await call('/withdraw', { roundId: id }, 'a')).status, 409);
    assert.equal((await call('/admin')).round.total, 2);
    assert.equal((await call('', undefined, 'a')).round.my_vote, 'abstain');
  } finally { close(); }
});
