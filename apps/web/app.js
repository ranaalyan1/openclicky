/* OpenClicky panel logic — SSE-driven chat + click-to-approve HITL cards. */

const els = {
  status: document.getElementById('status'),
  dot: document.querySelector('.dot'),
  chat: document.getElementById('chat'),
  approvals: document.getElementById('approvals'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  collapse: document.getElementById('btn-collapse'),
  pin: document.getElementById('btn-pin'),
  voice: document.getElementById('btn-voice'),
  audio: document.getElementById('btn-audio'),
  settings: document.getElementById('btn-settings'),
  setup: document.getElementById('setup'),
  setBase: document.getElementById('set-base'),
  setKey: document.getElementById('set-key'),
  setModel: document.getElementById('set-model'),
  setSearch: document.getElementById('set-search'),
  setSave: document.getElementById('set-save'),
  setTest: document.getElementById('set-test'),
  setStatus: document.getElementById('set-status'),
  setError: document.getElementById('set-error'),
};

function addMsg(kind, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + kind;
  div.textContent = text;
  els.chat.appendChild(div);
  els.chat.scrollTop = els.chat.scrollHeight;
  return div;
}

let typingEl = null;
function setTyping(on) {
  if (on && !typingEl) {
    typingEl = document.createElement('div');
    typingEl.className = 'msg assistant typing';
    typingEl.innerHTML = '<i></i><i></i><i></i>';
    els.chat.appendChild(typingEl);
    els.chat.scrollTop = els.chat.scrollHeight;
  } else if (!on && typingEl) {
    typingEl.remove();
    typingEl = null;
  }
}

function setStatus(text, live) {
  els.status.textContent = text;
  els.dot.classList.toggle('live', !!live);
}

function approvalCard(req) {
  const card = document.createElement('div');
  card.className = 'approval';
  card.dataset.requestId = req.requestId;

  const title = document.createElement('div');
  title.className = 'a-title';
  title.textContent = 'Approve: ' + (req.summary || req.commandId);

  const args = document.createElement('div');
  args.className = 'a-args';
  for (const a of req.argSummaries || []) {
    const row = document.createElement('div');
    row.textContent = `${a.name} = ${a.preview}`;
    args.appendChild(row);
  }
  if (!req.argSummaries?.length) args.textContent = '(no arguments)';

  const actions = document.createElement('div');
  actions.className = 'a-actions';

  const mk = (label, cls, body) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = cls;
    b.onclick = () => decide(req, body, card);
    actions.appendChild(b);
  };
  mk('Yes', 'yes', { approved: true, scope: 'once' });
  mk('Always', 'always', { approved: true, scope: 'always' });
  mk('No', 'no', { approved: false, scope: 'once' });

  card.append(title, args, actions);
  els.approvals.appendChild(card);
}

async function decide(req, body, card) {
  card.remove();
  addMsg('action', `${req.summary} — ${body.approved ? 'approved' : 'declined'}`);
  try {
    await fetch(`/api/approvals/${req.requestId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    addMsg('action fail', 'approval delivery failed: ' + err.message);
  }
}

async function send() {
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = '';
  els.input.style.height = 'auto';
  addMsg('user', text);
  els.send.disabled = true;
  setTyping(true);
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    // SSE already streams the assistant reply; only show the REST copy when
    // the event channel is down (otherwise messages would appear twice).
    if (data.reply && es.readyState !== EventSource.OPEN) addMsg('assistant', data.reply);
    else if (data.error) addMsg('action fail', data.error);
  } catch (err) {
    addMsg('action fail', 'request failed: ' + err.message);
  } finally {
    setTyping(false);
    els.send.disabled = false;
    els.input.focus();
  }
}

els.send.onclick = send;
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
els.input.addEventListener('input', () => {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 110) + 'px';
});

els.collapse.onclick = () => document.body.classList.toggle('collapsed');

// Pin actually controls always-on-top when running inside the Electron
// overlay (window.openclickyShell is injected by its preload); in a plain
// browser tab it is just a visual state.
els.pin.onclick = () => {
  const pinned = els.pin.classList.toggle('pinned');
  window.openclickyShell?.pin?.(pinned);
};

// --- first-run onboarding + settings gear ---
function openSetup(prefill) {
  els.setError.textContent = '';
  els.setStatus.textContent = '';
  if (prefill) {
    els.setBase.value = prefill.baseUrl || 'https://api.openai.com/v1';
    els.setModel.value = prefill.model || 'gpt-4o-mini';
    els.setKey.value = '';
    els.setKey.placeholder = prefill.hasKey ? 'Saved (' + prefill.keyPreview + ') — type to change' : 'sk-…';
    els.setSearch.value = '';
    els.setSearch.placeholder = prefill.hasSearchKey
      ? 'Saved (' + prefill.searchKeyPreview + ') — type to change'
      : 'BSA… (blank = keyless DuckDuckGo)';
  }
  els.setup.classList.remove('hidden');
  els.setKey.focus();
}

function setStatus(lines) {
  els.setStatus.textContent = '';
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = line.ok === undefined ? '' : line.ok ? 'good' : 'bad';
    div.textContent = (line.ok === undefined ? '' : line.ok ? '✓ ' : '✗ ') + line.text;
    els.setStatus.appendChild(div);
  }
}

// Ask the server to ping both keys with exactly what is typed in the card.
els.setTest.onclick = async () => {
  els.setError.textContent = '';
  els.setStatus.textContent = '';
  els.setTest.disabled = true;
  try {
    const res = await fetch('/api/settings/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: els.setBase.value.trim(),
        model: els.setModel.value.trim(),
        ...(els.setKey.value.trim() ? { apiKey: els.setKey.value.trim() } : {}),
        ...(els.setSearch.value.trim() ? { searchApiKey: els.setSearch.value.trim() } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      els.setError.textContent = data.error || ('test failed (' + res.status + ')');
      return;
    }
    const lines = [];
    if (data.model) lines.push({ ok: data.model.ok, text: 'key 1 · model — ' + data.model.detail });
    else if (!els.setKey.value.trim()) lines.push({ ok: false, text: 'key 1 · model — type a key to test it' });
    if (data.search) lines.push({ ok: data.search.ok, text: 'key 2 · search — ' + data.search.detail });
    if (!lines.length) lines.push({ text: 'nothing to test yet' });
    setStatus(lines);
  } catch (err) {
    els.setError.textContent = 'test failed: ' + err.message;
  } finally {
    els.setTest.disabled = false;
  }
};

els.settings.onclick = async () => {
  try {
    const res = await fetch('/api/settings');
    openSetup(await res.json());
  } catch {
    openSetup();
  }
};

els.setSave.onclick = async () => {
  els.setError.textContent = '';
  els.setSave.disabled = true;
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: els.setBase.value.trim(),
        model: els.setModel.value.trim(),
        ...(els.setKey.value.trim() ? { apiKey: els.setKey.value.trim() } : {}),
        ...(els.setSearch.value.trim() ? { searchApiKey: els.setSearch.value.trim() } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      els.setError.textContent = data.error || ('save failed (' + res.status + ')');
    } else {
      els.setup.classList.add('hidden');
      addMsg(
        'assistant',
        'Connected to ' + data.model + ' at ' + data.baseUrl +
          (data.hasSearchKey ? ' with Brave Search.' : ' (search: keyless DuckDuckGo — add key 2 in settings any time).') +
          ' What should I do first?',
      );
    }
  } catch (err) {
    els.setError.textContent = 'save failed: ' + err.message;
  } finally {
    els.setSave.disabled = false;
  }
};

// On load: no key → onboarding card instead of a dead chat.
(async () => {
  try {
    const res = await fetch('/api/settings');
    const s = await res.json();
    if (!s.hasKey) openSetup(s);
  } catch {
    /* settings API older server — fine, chat errors will say why */
  }
})();

// --- SSE wiring ---
const es = new EventSource('/api/events');
es.addEventListener('hello', () => setStatus('ready', true));
es.addEventListener('capabilities', () => setStatus('ready', true));
es.addEventListener('assistant', (e) => {
  const { content } = JSON.parse(e.data);
  if (content) {
    addMsg('assistant', content);
    if (ttsOn) speak(content);
  }
});
es.addEventListener('result', (e) => {
  const { ok, summary } = JSON.parse(e.data);
  addMsg('action ' + (ok ? 'ok' : 'fail'), (ok ? '✓ ' : '✗ ') + summary);
});
es.addEventListener('approval', (e) => {
  approvalCard(JSON.parse(e.data));
});
es.addEventListener('approval:resolved', (e) => {
  const { requestId } = JSON.parse(e.data);
  document.querySelector(`[data-request-id="${requestId}"]`)?.remove();
});
es.onerror = () => setStatus('disconnected', false);

// --- voice: mic in (/api/voice), speaker out (/api/speak) ---
let ttsOn = false;
let mediaRecorder = null;
let audioChunks = [];

els.audio.onclick = () => {
  ttsOn = !ttsOn;
  els.audio.textContent = ttsOn ? '🔊' : '🔇';
};

async function speak(text) {
  try {
    const res = await fetch('/api/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    new Audio(URL.createObjectURL(blob)).play();
  } catch {
    /* voice out is best-effort */
  }
}

els.voice.onclick = async () => {
  try {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.onstop = async () => {
      els.voice.textContent = '🎤';
      stream.getTracks().forEach((t) => t.stop());
      const mime = mediaRecorder.mimeType || 'audio/webm';
      const blob = new Blob(audioChunks, { type: mime });
      addMsg('user', '🎤 …');
      try {
        const res = await fetch('/api/voice', { method: 'POST', headers: { 'content-type': mime }, body: blob });
        const data = await res.json();
        if (data.text) addMsg('user', '“' + data.text + '”');
        if (data.error) addMsg('action fail', data.error);
        if (data.reply && es.readyState !== EventSource.OPEN) addMsg('assistant', data.reply);
      } catch (err) {
        addMsg('action fail', 'voice request failed: ' + err.message);
      }
    };
    els.voice.textContent = '🔴';
    mediaRecorder.start();
  } catch (err) {
    addMsg('action fail', 'microphone unavailable: ' + err.message);
  }
};

addMsg('assistant', 'OpenClicky is starting. Ask me to do something on your PC, the web, or a connected device.');
