type Choice = 'yes' | 'no' | 'abstain';
type Round = { id: string; question: string; status: 'open' | 'closed'; show_results: number; total: number; my_vote: Choice | null; yes?: number; no?: number; abstain?: number; closed_at: string };
const labels = { yes: 'Yes', no: 'No', abstain: 'Abstain' };
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const admin = document.querySelector<HTMLElement>('.vote-page')?.dataset.admin === 'true';
let round: Round | null = null;
let busy = false;
let showSaveIndicator = false;
let refreshing = false;
let connected = false;
let generation = 0;
let historyKey = '';
let nextHistory: number | null = null;
let historyBusy = false;

function text(id: string, value: string) { if (element(id)?.textContent !== value) element(id).textContent = value; }
function show(id: string, visible: boolean) { if (element(id)) element(id).hidden = !visible; }
function error(message = '') { text('error', message); show('error', !!message); }
async function api(path: string, body?: object) {
  const response = await fetch(`/api/vote${path}`, {
    method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin',
    signal: AbortSignal.timeout(8000),
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not save. Please try again.');
  return data;
}
function results(target: HTMLElement, item: Round) {
  const signature = `${item.id}:${item.yes}:${item.no}:${item.abstain}`;
  if (target.dataset.signature === signature) return;
  target.dataset.signature = signature;
  target.replaceChildren();
  for (const choice of Object.keys(labels) as Choice[]) {
    const row = document.createElement('div'); row.className = 'result-row';
    const label = document.createElement('span'); label.textContent = labels[choice];
    const count = document.createElement('strong'); count.textContent = String(item[choice] ?? 0);
    row.append(label, count); target.append(row);
  }
}
function render() {
  const open = round?.status === 'open';
  if (!admin) {
    text('phase', 'Voting ended');
    show('phase', !!round && !open);
  }
  const visibleResults = !!round && !open && round.yes !== undefined;
  show('results', visibleResults);
  if (visibleResults) results(element('results'), round!);
  if (admin) {
    document.querySelectorAll<HTMLElement>('.history-entry').forEach(entry => {
      if (Date.now() - Date.parse(entry.dataset.closedAt!) >= 24 * 60 * 60 * 1000) {
        entry.remove();
        if (!element('history-list').children.length) text('history-list', 'No votes in the past 24 hours.');
      }
    });
    show('start-form', !round); show('active-round', !!round);
    if (round) {
      text('question', round.question);
      show('question', !!round.question);
      text('count', `${round.total} ${round.total === 1 ? 'vote' : 'votes'} received`);
      if (!busy) element<HTMLInputElement>('visibility').checked = !!round.show_results;
      show('end', !!open); show('reset', !open);
    }
  } else {
    const confirmed = !!round?.my_vote;
    show('prompt', !confirmed || !open);
    text('question', round ? round.question : 'Waiting for a vote...');
    show('question', !round || !!round.question);
    show('choices', !!open && !confirmed);
    show('confirmation', confirmed);
    show('recorded-question', confirmed && !!open && !!round?.question);
    if (confirmed) {
      text('recorded-question', round!.question);
      text('recorded-choice', labels[round!.my_vote!]);
    }
    show('change-vote', !!open);
    element<HTMLButtonElement>('change-vote').disabled = busy || !connected;
    show('saving', showSaveIndicator && !confirmed);
    element('choices').setAttribute('aria-busy', String(busy));
    document.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach(button => {
      button.disabled = busy || !connected || !open;
    });
  }
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('#start, #end, #reset, #visibility').forEach(control => { control.disabled = busy || !connected; });
}
async function history(append = false) {
  if (historyBusy) return;
  historyBusy = true;
  element<HTMLButtonElement>('more-history').disabled = true;
  try {
    const data = await api(`/history${append && nextHistory !== null ? `?before=${nextHistory}` : ''}`);
    const list = element('history-list');
    if (!append) list.replaceChildren();
    for (const item of data.rounds as Round[]) {
      const entry = document.createElement('article'); entry.className = 'history-entry'; entry.dataset.closedAt = item.closed_at;
      const title = document.createElement('h3'); title.textContent = item.question || 'Untitled vote';
      const date = document.createElement('p'); date.className = 'small'; date.textContent = new Date(item.closed_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const description = document.createElement('div'); description.className = 'history-description';
      description.append(title, date);
      const counts = document.createElement('dl'); counts.className = 'history-counts';
      for (const [key, label] of [...Object.entries(labels), ['total', 'Total']]) {
        const cell = document.createElement('div');
        const term = document.createElement('dt'); term.textContent = label;
        const value = document.createElement('dd'); value.textContent = String(item[key as 'total' | Choice] ?? 0);
        cell.append(term, value); counts.append(cell);
      }
      entry.append(description, counts); list.append(entry);
    }
    if (!list.children.length) { const empty = document.createElement('p'); empty.className = 'small'; empty.textContent = 'No votes in the past 24 hours.'; list.append(empty); }
    nextHistory = data.next; show('more-history', nextHistory !== null);
  } catch {
    historyKey = ''; // Retry on the next refresh without erasing already loaded history.
    if (element('history-list').textContent === 'Loading history…') text('history-list', 'Could not load history. Retrying…');
  } finally { historyBusy = false; element<HTMLButtonElement>('more-history').disabled = false; }
}
async function refresh() {
  if (refreshing || busy || document.hidden) return;
  refreshing = true;
  const requestGeneration = generation;
  try {
    const data = await api(admin ? '/admin' : '');
    if (requestGeneration !== generation) return;
    round = data.round; connected = true;
    show('connection', false);
    render();
    if (admin) {
      const key = `${round?.id ?? 'waiting'}:${round?.status ?? ''}`;
      if (key !== historyKey) { historyKey = key; void history(); }
    }
  } catch {
    if (requestGeneration !== generation) return;
    connected = false; render();
    text('connection', 'Reconnecting…'); show('connection', true);
  } finally { refreshing = false; }
}
async function mutate(path: string, body: Record<string, unknown>) {
  if (busy || !connected) return;
  busy = true; generation++; error(); render();
  const savingTimer = path === '/ballot' ? setTimeout(() => {
    showSaveIndicator = true; render();
  }, 1000) : undefined;
  try {
    await api(path, body);
    if (path === '/ballot' && round?.id === body.roundId) {
      round.my_vote = body.choice as Choice;
      render();
      element('confirmation').focus();
    }
    if (path === '/withdraw' && round?.id === body.roundId) {
      round.my_vote = null;
      round.total = Math.max(0, round.total - 1);
      render();
      element('choices').focus();
    }
    if (path === '/start') element<HTMLTextAreaElement>('question-input').value = '';
  } catch (cause) {
    error(cause instanceof Error && cause.name !== 'TimeoutError' ? cause.message : 'Could not confirm the save. Check your vote when the connection returns.');
  } finally {
    clearTimeout(savingTimer);
    showSaveIndicator = false;
    busy = false;
    if (!admin) render();
    // A previous poll may still be in flight. It is discarded by generation;
    // the interval will refresh once it finishes.
    await refresh();
  }
}
if (admin) {
  const topic = element<HTMLTextAreaElement>('question-input');
  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (document.activeElement === topic && !target?.closest('#question-input, label[for="question-input"]')) topic.blur();
  });
  const qrDialog = element<HTMLDialogElement>('qr-dialog');
  element('expand-qr').addEventListener('click', () => qrDialog.showModal());
  qrDialog.addEventListener('click', event => {
    const bounds = qrDialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom) qrDialog.close();
  });
  element('start-form').addEventListener('submit', event => {
    event.preventDefault();
    void mutate('/start', { question: element<HTMLTextAreaElement>('question-input').value, showResults: element<HTMLInputElement>('visibility').checked });
  });
  element('end').addEventListener('click', () => void mutate('/end', { roundId: round?.id }));
  element('reset').addEventListener('click', () => void mutate('/reset', { roundId: round?.id }));
  element('visibility').addEventListener('change', () => {
    if (round) void mutate('/visibility', { roundId: round.id, showResults: element<HTMLInputElement>('visibility').checked });
  });
  element('more-history').addEventListener('click', () => void history(true));
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || qrDialog.open) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (event.key === 'Escape' && target === element('question-input')) {
      event.preventDefault();
      element<HTMLElement>('vote-controls').focus();
      return;
    }
    const typing = target?.closest('textarea, input:not([type="checkbox"]):not([type="radio"]), [contenteditable]:not([contenteditable="false"])');
    if (event.key === 'Enter' && !event.shiftKey && connected && !busy) {
      // Preserve native Enter on links/buttons and editable content other than Topic.
      if (target?.closest('button, a, input, select, summary, [contenteditable]')) return;
      event.preventDefault();
      if (!round) element<HTMLFormElement>('start-form').requestSubmit();
      else element<HTMLButtonElement>(round.status === 'open' ? 'end' : 'reset').click();
    } else if (!typing && !event.shiftKey && event.key.toLowerCase() === 't' && !round) {
      event.preventDefault();
      element<HTMLTextAreaElement>('question-input').focus();
    } else if (!typing && !event.shiftKey && event.key.toLowerCase() === 's') {
      const visibility = element<HTMLInputElement>('visibility');
      if (!visibility.disabled) { event.preventDefault(); visibility.click(); }
    }
  });
} else {
  element('change-vote').addEventListener('click', () => {
    void mutate('/withdraw', { roundId: round?.id });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach(button => button.addEventListener('click', () => {
    void mutate('/ballot', { roundId: round?.id, choice: button.dataset.choice });
  }));
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
window.addEventListener('online', () => void refresh());
void refresh();
setInterval(() => void refresh(), 1000);
