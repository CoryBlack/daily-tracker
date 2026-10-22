// ---------- GitHub sync ----------
// data.json in a private repo is the durable copy; the browser keeps a full local copy so
// the app opens instantly and works offline. Syncing never replaces one copy with the
// other wholesale — it merges record by record (see mergeData), so a stale device, a
// failed request or two devices editing at once can't erase anything.
//
// Invariant: after every successful sync, the local copy contains everything that was in
// data.json at `lastSha`. That makes the fast path safe: a push can write the local copy
// directly with lastSha, and if anyone else has written since, GitHub rejects it (409) and
// we fall back to fetch → merge → write.

class SyncError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64DecodeUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// opts: {
//   settings() → { ghUser, ghRepo, ghBranch, ghToken }
//   getData() → current local data      applyRemote(data, sha, rev) → merge into local + persist
//   getSha()                            status(kind, text)
//   isDirty() → unsynced local edits?   getRev() → counter bumped on every local edit
//   fetch, wait(ms) (injectable for tests)
// }
function createSync(opts) {
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  const wait = opts.wait || (ms => new Promise(r => setTimeout(r, ms)));
  const DATA_PATH = 'data.json';
  let running = null;
  let again = false;
  let debounce = null;

  const configured = s => !!(s.ghUser && s.ghRepo && s.ghToken);

  function headers(s, json) {
    const h = { 'Authorization': `Bearer ${s.ghToken}`, 'Accept': 'application/vnd.github+json' };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  const repoUrl = s => `https://api.github.com/repos/${encodeURIComponent(s.ghUser)}/${encodeURIComponent(s.ghRepo)}`;

  async function request(s, url, init = {}) {
    let res;
    try {
      res = await doFetch(url, { cache: 'no-store', ...init, headers: headers(s, !!init.body) });
    } catch (e) {
      throw new SyncError('Offline — changes saved on this device', 'offline');
    }
    if (res.status === 401) throw new SyncError('GitHub rejected the token — check Settings', 'auth');
    return res;
  }

  // → { sha, data } or { sha: null, data: null } when data.json doesn't exist yet.
  async function fetchRemote(s) {
    const branch = s.ghBranch || 'main';
    const res = await request(s, `${repoUrl(s)}/contents/${DATA_PATH}?ref=${encodeURIComponent(branch)}&_=${Date.now()}`);
    if (res.status === 404) {
      // A 404 also means "repo missing or token can't see it" — only treat it as "file not
      // created yet" when the repo itself is reachable.
      const repo = await request(s, `${repoUrl(s)}?_=${Date.now()}`);
      if (!repo.ok) throw new SyncError('Data repo not found, or the token can’t access it', 'config');
      return { sha: null, data: null };
    }
    if (!res.ok) throw new SyncError(`GitHub read failed (${res.status})`, 'http');
    const meta = await res.json();
    let b64 = meta.content;
    if (meta.encoding !== 'base64' || !b64) {
      // Files over 1 MB come back with no inline content. Fetch the blob instead — an
      // empty response must never be mistaken for empty data.
      const blobRes = await request(s, `${repoUrl(s)}/git/blobs/${meta.sha}`);
      if (!blobRes.ok) throw new SyncError(`GitHub read failed (${blobRes.status})`, 'http');
      b64 = (await blobRes.json()).content;
    }
    let data;
    try {
      data = JSON.parse(b64DecodeUtf8(b64 || ''));
    } catch (e) {
      throw new SyncError('data.json on GitHub isn’t valid JSON — left untouched', 'corrupt');
    }
    try {
      data = migrate(data);
    } catch (e) {
      if (e instanceof NewerSchemaError) throw new SyncError(e.message, 'newer');
      throw new SyncError(`data.json on GitHub looks malformed (${e.message}) — left untouched`, 'corrupt');
    }
    return { sha: meta.sha, data };
  }

  // → { sha } on success, { conflict: true } if the file changed since `sha`.
  async function writeRemote(s, data, sha) {
    const body = {
      message: `Update daily data — ${nowIso()}`,
      content: b64EncodeUtf8(JSON.stringify(data, null, 2) + '\n'),
      branch: s.ghBranch || 'main'
    };
    if (sha) body.sha = sha;
    const res = await request(s, `${repoUrl(s)}/contents/${DATA_PATH}`, { method: 'PUT', body: JSON.stringify(body) });
    if (res.status === 409 || res.status === 422) return { conflict: true };
    if (!res.ok) throw new SyncError(`GitHub write failed (${res.status})`, 'http');
    return { sha: (await res.json()).content.sha };
  }

  async function syncOnce({ pull }) {
    const s = opts.settings();
    if (!configured(s)) { opts.status('off', 'Not connected'); return; }
    if (!pull && opts.isDirty && !opts.isDirty()) return; // nothing to push
    const rev = opts.getRev ? opts.getRev() : 0;
    opts.status('busy', pull ? 'Syncing…' : 'Saving…');

    // Fast path: nothing to learn from GitHub, just write what we have on top of lastSha.
    const lastSha = opts.getSha();
    if (!pull && lastSha) {
      const local = opts.getData();
      let res = { conflict: true };
      try {
        res = await writeRemote(s, local, lastSha);
      } catch (e) {
        if (e.kind !== 'http') throw e; // anything odd: fall back to the careful path below
      }
      if (!res.conflict) { opts.applyRemote(local, res.sha, rev); opts.status('ok', 'Synced'); return; }
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await wait(600 * attempt);
      const remote = await fetchRemote(s);
      const local = opts.getData();
      const merged = remote.data ? mergeData(local, remote.data) : migrate(local);
      if (remote.data) assertNoLoss(remote.data, merged);
      if (remote.data && !hasChangesOver(merged, remote.data)) {
        opts.applyRemote(merged, remote.sha, rev);
        opts.status('ok', 'Synced');
        return;
      }
      const res = await writeRemote(s, merged, remote.sha);
      if (res.conflict) continue;
      opts.applyRemote(merged, res.sha, rev);
      opts.status('ok', 'Synced');
      return;
    }
    throw new SyncError('GitHub kept changing during sync — will retry', 'conflict');
  }

  // Single-flight: requests made while a sync is running coalesce into one more run.
  async function run(pull) {
    if (running) { again = (again === true || pull) ? true : 'push'; return running; }
    running = (async () => {
      try {
        await syncOnce({ pull });
      } catch (e) {
        const msg = e instanceof SyncError ? e.message : `Sync error: ${e.message}`;
        opts.status(e.kind === 'offline' ? 'offline' : 'error', msg);
        if (!(e instanceof SyncError)) console.warn(e);
      }
    })();
    await running;
    running = null;
    if (again) {
      const next = again === true;
      again = false;
      await run(next);
    }
  }

  return {
    pull: () => run(true),
    push: () => run(false),
    // Batch rapid edits (e.g. ticking several boxes) into one commit.
    schedule(ms = 800) {
      clearTimeout(debounce);
      debounce = setTimeout(() => run(false), ms);
    },
    flush() { clearTimeout(debounce); return run(false); }
  };
}
