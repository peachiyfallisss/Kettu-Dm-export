(() => {
"use strict";
// SPDX-License-Identifier: GPL-3.0-or-later
// Mobile reimplementation inspired by Nightcord's TestCord ExportDM.

const FORMATS = {
  html: 'text/html', txt: 'text/plain', json: 'application/json',
  csv: 'text/csv', md: 'text/markdown'
};

class Cancelled extends Error {
  constructor() { super('Export cancelled'); this.name = 'Cancelled'; }
}

function checkCancelled(control) {
  if (control?.cancelled) throw new Cancelled();
}

async function cancellableWait(ms, control) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    checkCancelled(control);
    await new Promise(resolve => setTimeout(resolve, Math.min(200, end - Date.now())));
  }
  checkCancelled(control);
}

function compareIds(a, b) {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function validId(id) { return typeof id === 'string' && /^\d{1,22}$/.test(id); }

function statusOf(error) {
  return Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? 0);
}

async function requestPage(request, channelId, before, control, onStatus, wait = cancellableWait) {
  for (let attempt = 0; ; attempt++) {
    checkCancelled(control);
    let response;
    try {
      response = await request(channelId, before);
    } catch (error) {
      checkCancelled(control);
      response = { status: statusOf(error), body: error?.body ?? error?.response?.body, headers: error?.headers };
      if (!response.status) throw new Error('Connection failed or timed out. Fetched messages have been kept; this export is incomplete.');
    }
    checkCancelled(control);
    const status = response.status ?? 200;
    if (status === 429 || status >= 500) {
      if (attempt >= 6) throw new Error(`Discord HTTP ${status}: retry limit reached. Export incomplete.`);
      const seconds = Number(response.body?.retry_after ?? response.headers?.['retry-after']);
      // Honor the full server delay; never cap Retry-After to retry early.
      const ms = status === 429 && Number.isFinite(seconds) && seconds > 0
        ? Math.ceil(seconds * 1000) + 500 : Math.min(30000, 1500 * 2 ** attempt);
      onStatus?.(`Waiting ${Math.ceil(ms / 1000)}s before retrying (HTTP ${status})…`);
      await wait(ms, control);
      continue;
    }
    if (status < 200 || status >= 300) {
      throw new Error(`Discord HTTP ${status}. ${status === 401 ? 'Sign in again.' : status === 403 || status === 404 ? 'This conversation is unavailable to the current account.' : 'Export incomplete.'}`);
    }
    if (!Array.isArray(response.body)) throw new Error('Unexpected Discord response. Export incomplete.');
    for (const m of response.body) {
      if (!validId(m?.id) || !m.author || (m.channel_id && m.channel_id !== channelId)) {
        throw new Error('Invalid message page. Export incomplete.');
      }
    }
    return response.body;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function safeUrl(value) {
  // Restrict generated clickable links/media; never emit javascript/data/file URLs.
  const s = String(value ?? '');
  return /^https?:\/\/[^\s<>"'\\]+$/i.test(s) ? s : '';
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function authorName(m) { return m.author?.global_name || m.author?.username || m.author?.id || 'Unknown'; }

function plainMessage(m) {
  const lines = [`[${m.timestamp || 'Unknown time'}] ${authorName(m)} (${m.author?.id || '?'})${m.edited_timestamp ? ' [edited ' + m.edited_timestamp + ']' : ''}${m.pinned ? ' [pinned]' : ''}`, m.content || ''];
  if (m.message_reference?.message_id) lines.push(`Reply to: ${m.message_reference.message_id}`);
  if (m.referenced_message) lines.push(`Quoted ${authorName(m.referenced_message)}: ${m.referenced_message.content || ''}`);
  for (const a of m.attachments || []) lines.push(`Attachment: ${a.filename || 'file'} — ${a.url || ''}`);
  for (const e of m.embeds || []) lines.push(`Embed: ${[e.title, e.description, e.url, e.image?.url].filter(Boolean).join('\n')}`);
  for (const s of m.sticker_items || []) lines.push(`Sticker: ${s.name} (${s.id})`);
  for (const r of m.reactions || []) lines.push(`Reaction: ${r.emoji?.name || r.emoji?.id || '?'} × ${r.count ?? 0}`);
  if (m.type) lines.push(`System/message type: ${m.type}`);
  if (m.poll) lines.push(`Poll: ${JSON.stringify(m.poll)}`);
  return lines.filter(x => x !== '').join('\n');
}

function renderPart(messages, meta, format) {
  if (!FORMATS[format]) throw new Error('Unsupported export format');
  const ordered = [...messages].sort((a, b) => compareIds(a.id, b.id));
  const heading = `${meta.channelName} — part ${meta.part}`;
  const note = 'Messages are oldest first within this part. Parts are numbered newest to oldest. See the index JSON for completion status. Attachments are remote links, not offline copies.';
  if (format === 'json') return JSON.stringify({ ...meta, note, messages: ordered }, null, 2);
  if (format === 'txt') return `${heading}\n${note}\n\n${ordered.map(plainMessage).join('\n\n')}\n`;
  // Keep user Markdown inert inside an adaptive fence, preserving literal text.
  if (format === 'md') {
    const text = ordered.map(plainMessage).join('\n\n');
    const longest = (text.match(/`+/g) || []).reduce((max, s) => Math.max(max, s.length), 2);
    const fence = '`'.repeat(longest + 1);
    return `# ${escapeHtml(heading)}\n\n${note}\n\n${fence}text\n${text}\n${fence}\n`;
  }
  if (format === 'csv') {
    const rows = [['id', 'timestamp', 'author_id', 'author', 'content', 'edited_timestamp', 'reply_to', 'attachments_json', 'embeds_json', 'stickers_json', 'reactions_json', 'type', 'pinned', 'poll_json']];
    for (const m of ordered) rows.push([m.id, m.timestamp, m.author?.id, authorName(m), m.content, m.edited_timestamp, m.message_reference?.message_id, JSON.stringify(m.attachments || []), JSON.stringify(m.embeds || []), JSON.stringify(m.sticker_items || []), JSON.stringify(m.reactions || []), m.type ?? 0, !!m.pinned, JSON.stringify(m.poll || null)]);
    return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
  const h = escapeHtml;
  const link = (url, label) => safeUrl(url) ? `<a href="${h(safeUrl(url))}" rel="noreferrer noopener">${h(label || url)}</a>` : h(label || 'Unavailable link');
  const articles = ordered.map(m => {
    const attachments = (m.attachments || []).map(a => {
      const url = h(safeUrl(a.url));
      let media = '';
      if (url && /^image\//.test(a.content_type || '')) media = `<img loading="lazy" src="${url}" alt="${h(a.filename)}">`;
      if (url && /^video\//.test(a.content_type || '')) media = `<video controls preload="none" src="${url}"></video>`;
      if (url && /^audio\//.test(a.content_type || '')) media = `<audio controls preload="none" src="${url}"></audio>`;
      return `<div class="attachment">${media}${link(a.url, a.filename)}</div>`;
    }).join('');
    const embeds = (m.embeds || []).map(e => `<blockquote><strong>${h(e.title)}</strong><div class="content">${h(e.description)}</div>${(e.fields || []).map(f => `<p><b>${h(f.name)}</b> ${h(f.value)}</p>`).join('')}${e.url ? link(e.url, e.url) : ''}</blockquote>`).join('');
    const reply = m.referenced_message ? `<blockquote>Reply to ${h(authorName(m.referenced_message))}<div class="content">${h(m.referenced_message.content)}</div></blockquote>` : m.message_reference?.message_id ? `<blockquote>Reply to ${h(m.message_reference.message_id)}</blockquote>` : '';
    return `<article id="m-${h(m.id)}"><header><b>${h(authorName(m))}</b> <time>${h(m.timestamp)}</time>${m.edited_timestamp ? ' <small>(edited)</small>' : ''}${m.pinned ? ' <small>(pinned)</small>' : ''}</header>${reply}<div class="content">${h(m.content)}</div>${attachments}${embeds}<footer>${h((m.sticker_items || []).map(s => 'Sticker: ' + s.name).join(' · '))} ${h((m.reactions || []).map(r => `${r.emoji?.name || r.emoji?.id || '?'} × ${r.count ?? 0}`).join(' · '))}</footer>${m.poll ? `<pre>${h(JSON.stringify(m.poll, null, 2))}</pre>` : ''}${m.type ? `<small>Message type: ${h(m.type)}</small>` : ''}</article>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http:; media-src https: http:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${h(heading)}</title><style>body{color:#e9e9f0;background:#171820;font:16px system-ui,sans-serif;max-width:960px;margin:auto;padding:20px;line-height:1.55}h1{font-size:26px}article{padding:16px 0;border-bottom:1px solid #343542}time,small,footer{color:#a8aabc;font-size:12px}.content,pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#b6c1ff;overflow-wrap:anywhere}blockquote{margin:10px 0;padding:8px 12px;border-left:3px solid #8d9bf1;background:#20222c}img,video{display:block;max-width:100%;max-height:480px;margin:10px 0}audio{max-width:100%}header{margin-bottom:8px}</style></head><body><h1>${h(heading)}</h1><p>${h(note)}</p><p>${ordered.length} messages · exported ${h(meta.exportedAt)}</p>${articles}</body></html>`;
}

function safeFilename(name) {
  return String(name || 'DM').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 48) || 'DM';
}

// Writes bounded parts before requesting more history. No complete flag until
// Discord returns an empty page. Small nonempty pages still advance the cursor.
async function exportConversation({ channel, format, request, write, control, onProgress = () => {}, wait = cancellableWait, partSize = 2000, partBytes = 4 * 1024 * 1024, runId }) {
  if (!validId(channel.id)) throw new Error('Invalid conversation ID');
  if (![1, 3].includes(channel.type)) throw new Error('Choose a DM or group DM');
  if (!FORMATS[format]) throw new Error('Unsupported export format');
  const started = new Date().toISOString();
  const prefix = `${safeFilename(channel.name)}_${channel.id}_${runId || started.replace(/[^0-9]/g, '')}`;
  const indexName = prefix + '_index.json';
  const summary = { schemaVersion: 1, channelId: channel.id, channelName: channel.name, exportedAt: started, format, complete: false, status: 'running', messageCount: 0, parts: [], partOrder: 'newest-to-oldest', messageOrder: 'oldest-to-newest within each part', media: 'Remote attachment links; binaries are not downloaded.' };
  let pending = [], bytes = 0, before;
  const writeIndex = () => write(indexName, JSON.stringify(summary, null, 2), 'application/json');
  const flush = async () => {
    if (!pending.length) return;
    const part = summary.parts.length + 1;
    const filename = `${prefix}_part-${String(part).padStart(4, '0')}.${format}`;
    const content = renderPart(pending, { channelId: channel.id, channelName: channel.name, part, exportedAt: started }, format);
    await write(filename, content, FORMATS[format]);
    const ids = pending.map(m => m.id).sort(compareIds);
    summary.parts.push({ filename, count: pending.length, oldestId: ids[0], newestId: ids[ids.length - 1] });
    summary.messageCount += pending.length;
    pending = []; bytes = 0;
    await writeIndex();
  };
  await writeIndex();
  try {
    for (;;) {
      const batch = await requestPage(request, channel.id, before, control, text => onProgress({ count: summary.messageCount + pending.length, text }), wait);
      if (!batch.length) break;
      const sorted = [...new Map(batch.map(m => [m.id, m])).values()].sort((a, b) => compareIds(b.id, a.id));
      const fresh = sorted.filter(m => !before || compareIds(m.id, before) < 0);
      if (!fresh.length) throw new Error('Discord repeated a page without older messages. Export incomplete.');
      for (const m of fresh) {
        checkCancelled(control);
        pending.push(m); bytes += JSON.stringify(m).length * 2;
        if (pending.length >= partSize || bytes >= partBytes) await flush();
      }
      before = fresh[fresh.length - 1].id;
      summary.nextBefore = before;
      onProgress({ count: summary.messageCount + pending.length, text: 'Fetching older messages…' });
      await wait(1000, control);
    }
    checkCancelled(control);
    await flush();
    summary.complete = true; summary.status = 'complete';
    delete summary.nextBefore;
    summary.finishedAt = new Date().toISOString();
    await writeIndex();
    return { summary, indexName };
  } catch (error) {
    summary.complete = false;
    summary.status = error instanceof Cancelled ? 'cancelled' : 'failed';
    summary.error = error instanceof Error ? error.message : 'Export failed';
    try { await flush(); await writeIndex(); } catch { summary.error += ' Some files could not be saved.'; }
    onProgress({ count: summary.messageCount, text: summary.error });
    return { summary, indexName };
  }
}

// SPDX-License-Identifier: GPL-3.0-or-later

function createMobileAdapter(vd, environment = globalThis) {
  const metro = vd.metro;
  const RN = metro.common.ReactNative;
  const getProps = (...keys) => { try { return metro.findByProps(...keys); } catch { return null; } };
  const getStore = name => { try { return metro.findByStoreName(name); } catch { return null; } };
  const channels = getStore('ChannelStore') || getProps('getChannel', 'getDMFromUserId');
  const users = getStore('UserStore') || getProps('getCurrentUser', 'getUser');
  const native = (...names) => {
    for (const name of names) {
      try { const m = environment.__turboModuleProxy?.(name); if (m) return m; } catch { /* Try the legacy bridge. */ }
      try { const m = environment.nativeModuleProxy?.[name] || RN.NativeModules?.[name]; if (m) return m; } catch { /* Try next known name. */ }
    }
    return null;
  };
  const file = native('NativeFileModule', 'RTNFileManager', 'DCDFileManager');
  const shareModule = getProps('open', 'shareSingle') || native('RNShare');
  const http = getProps('get', 'post', 'put', 'patch', 'del');
  const currentUserId = () => users?.getCurrentUser?.()?.id;
  const verifyOwner = owner => {
    if (!owner || currentUserId() !== owner) throw new Error('The Discord account changed. Return to the original account before exporting or sharing these files.');
  };
  const nameChannel = c => {
    if (c.name) return c.name;
    return (c.recipients || []).map(id => {
      const u = users?.getUser?.(typeof id === 'string' ? id : id.id);
      return u?.globalName || u?.global_name || u?.username || (typeof id === 'string' ? id : id.id);
    }).join(', ') || 'DM';
  };
  const describeChannel = c => c && [1, 3].includes(c.type) ? { id: c.id, type: c.type, name: nameChannel(c) } : null;
  const listChannels = () => {
    const found = new Map();
    const add = value => {
      if (!value) return;
      if (typeof value === 'string') { add(channels?.getChannel?.(value)); return; }
      if (value.channel) { add(value.channel); return; }
      const c = describeChannel(value);
      if (c && validId(c.id)) found.set(c.id, c);
    };
    // Different Discord builds expose objects, ID arrays or sorted wrappers.
    for (const [store, name] of [[channels, 'getPrivateChannels'], [channels, 'getSortedPrivateChannels'], [getStore('PrivateChannelSortStore'), 'getPrivateChannelIds']]) {
      try {
        const raw = store?.[name]?.();
        for (const v of Array.isArray(raw) ? raw : Object.values(raw || {})) add(v);
      } catch { /* Another shape may be supported. */ }
    }
    const selected = getStore('SelectedChannelStore') || metro.common.channels;
    try { add(selected?.getChannelId?.()); } catch { /* No selected channel. */ }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  const capabilities = () => ({
    account: !!currentUserId(), channels: !!channels,
    request: typeof http?.get === 'function',
    fileWrite: typeof file?.writeFile === 'function',
    share: typeof shareModule?.open === 'function'
  });
  const ensureReady = () => {
    const caps = capabilities();
    const missing = Object.keys(caps).filter(k => !caps[k]);
    if (missing.length) throw new Error(`This Discord/Kettu build is missing: ${missing.join(', ')}. No history was fetched. Check the compatibility details in this plugin's settings.`);
  };
  const request = async (channelId, before, owner) => {
    verifyOwner(owner);
    let timer;
    try {
      // Uses Discord's authenticated client. No token extraction or persistence.
      const response = await Promise.race([
        http.get({ url: `/channels/${channelId}/messages`, query: { limit: 100, ...(before ? { before } : {}) }, retries: 0 }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Request timed out')), 45000); })
      ]);
      verifyOwner(owner);
      return { status: response.status ?? 200, body: response.body, headers: response.headers };
    } finally { clearTimeout(timer); }
  };
  const write = async (filename, content, owner) => {
    verifyOwner(owner);
    if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) throw new Error('Invalid output filename');
    const relative = `kettu-dm-export/${owner}/${filename}`;
    const written = await file.writeFile('documents', relative, content, 'utf8');
    verifyOwner(owner);
    let path = typeof written === 'string' ? written : '';
    if (!path) {
      const root = file.getConstants?.().DocumentsDirPath || file.DocumentsDirPath;
      if (!root) throw new Error('Discord wrote the file but did not return its location.');
      path = root.replace(/\/$/, '') + '/' + relative;
    }
    if (!/^(\/|file:\/\/|content:\/\/)/.test(path)) throw new Error('Discord returned an unsupported file location.');
    return path;
  };
  const shareFiles = async (files, owner) => {
    verifyOwner(owner);
    if (!shareModule?.open) throw new Error('File sharing is unavailable on this Discord build.');
    const urls = files.map(f => {
      if (!/^(\/|file:\/\/|content:\/\/)/.test(f.path || '')) throw new Error('Invalid saved file path');
      return /^(file|content):\/\//.test(f.path) ? f.path : 'file://' + f.path;
    });
    if (!urls.length) throw new Error('There are no saved files to share.');
    // RNShare owns the Android FileProvider and native chooser; ReactNative.Share
    // cannot attach files on Android and must not be used as a false fallback.
    return shareModule.open({ urls, type: files.length === 1 ? files[0].mime : '*/*',
      title: 'Save DM export', failOnCancel: false, useInternalStorage: true });
  };
  return { RN, React: metro.common.React, listChannels, describeChannel, currentUserId, verifyOwner, request, write, shareFiles, capabilities, ensureReady };
}

// SPDX-License-Identifier: GPL-3.0-or-later

function createPlugin(vd) {
  const adapter = createMobileAdapter(vd);
  const { React, RN } = adapter;
  const h = React.createElement;
  const { View, Text, TouchableOpacity, TextInput, FlatList, Alert } = RN;
  const storage = vd.plugin.storage;
  let alive = true, control = null;
  let settingsPrefill = null;
  let state = { busy: false, count: 0, text: 'Choose one or more conversations.', current: '', records: [] };
  const listeners = new Set(), cleanups = [];
  const publish = patch => { state = { ...state, ...patch }; if (alive) for (const notify of listeners) notify(state); };
  const readRecords = () => (Array.isArray(storage.exports) ? storage.exports : []).filter(r => r.owner === adapter.currentUserId());
  const errorAlert = e => { if (alive) Alert.alert('DM Export', e instanceof Error ? e.message : 'Something went wrong.'); };
  const toast = text => { try { vd.ui?.toasts?.showToast?.(text); } catch { /* Toasts are optional. */ } };
  const includeChannel = (list, channel) => channel && !list.some(c => c.id === channel.id) ? [channel, ...list] : list;
  const saveRecord = record => {
    const old = Array.isArray(storage.exports) ? storage.exports : [];
    storage.exports = [record, ...old.filter(r => r.id !== record.id)];
    publish({ records: readRecords() });
  };
  async function startExport(chosen, format) {
    const completedRecords = [];
    if (state.busy) { Alert.alert('DM Export', 'An export is already running.'); return completedRecords; }
    if (!chosen.length) return completedRecords;
    const snapshot = chosen.map(c => ({ ...c }));
    try { adapter.ensureReady(); } catch (e) { errorAlert(e); return completedRecords; }
    const owner = adapter.currentUserId();
    control = { cancelled: false };
    const jobControl = control;
    publish({ busy: true, count: 0, text: 'Starting…' });
    let completed = 0, stopped = false;
    try {
      for (let i = 0; i < snapshot.length; i++) {
        checkCancelled(jobControl);
        if (!alive) break;
        adapter.verifyOwner(owner);
        const channel = snapshot[i];
        const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const record = { id, owner, channelName: channel.name, channelId: channel.id, format, status: 'running', complete: false, count: 0, files: [], createdAt: new Date().toISOString() };
        publish({ current: `[${i + 1}/${snapshot.length}] ${channel.name}`, count: 0 });
        const result = await exportConversation({ channel, format, control: jobControl, runId: id,
          request: (cid, before) => { if (!alive) throw new Cancelled(); return adapter.request(cid, before, owner); },
          write: async (filename, content, mime) => {
            if (!alive) throw new Cancelled();
            const path = await adapter.write(filename, content, owner);
            if (!alive) throw new Cancelled();
            if (filename.endsWith('_index.json')) {
              const index = JSON.parse(content);
              Object.assign(record, { count: index.messageCount, status: index.status, complete: index.complete, error: index.error });
            }
            const output = { filename, path, mime };
            const existing = record.files.findIndex(f => f.filename === filename);
            if (existing < 0) record.files.push(output); else record.files[existing] = output;
            saveRecord({ ...record, files: [...record.files] });
          },
          onProgress: progress => publish({ count: progress.count, text: progress.text })
        });
        Object.assign(record, { status: result.summary.status, complete: result.summary.complete, count: result.summary.messageCount, error: result.summary.error });
        if (alive && adapter.currentUserId() === owner) saveRecord(record);
        if (!result.summary.complete) { stopped = true; publish({ text: result.summary.error || 'Export incomplete.' }); break; }
        completedRecords.push({ ...record, files: [...record.files] });
        completed++;
      }
      if (alive && !stopped) publish({ text: `${completed} conversation${completed === 1 ? '' : 's'} complete. Use Save / share below to keep the files outside Discord.` });
    } catch (e) { publish({ text: e instanceof Error ? e.message : 'Export stopped.' }); }
    finally { control = null; publish({ busy: false }); }
    return completedRecords;
  }
  async function share(record, file) {
    try { await adapter.shareFiles(file ? [file] : record.files, record.owner); }
    catch (e) { errorAlert(e); }
  }
  const styles = {
    page: { flex: 1, backgroundColor: '#171820' },
    pad: { padding: 16 },
    title: { fontSize: 24, fontWeight: '700', color: '#f4f4fa', marginBottom: 8 },
    text: { color: '#dddfea', fontSize: 15, lineHeight: 22 },
    muted: { color: '#aeb1c6', fontSize: 13, lineHeight: 20, marginTop: 6 },
    input: { color: '#f4f4fa', backgroundColor: '#262834', borderRadius: 8, padding: 12, marginTop: 12, fontSize: 16 },
    button: { backgroundColor: '#4954b8', borderRadius: 8, padding: 12, marginTop: 8, marginRight: 8, minHeight: 44 },
    buttonText: { color: '#fff', fontWeight: '600', fontSize: 14 },
    row: { flexDirection: 'row', flexWrap: 'wrap' },
    channel: { marginHorizontal: 16, marginBottom: 6, padding: 12, borderRadius: 8, backgroundColor: '#262834', minHeight: 50 },
    card: { padding: 14, backgroundColor: '#242633', borderRadius: 10, marginTop: 12 },
    heading: { color: '#f4f4fa', fontSize: 18, fontWeight: '700', marginTop: 16 },
  };
  function button(label, onPress, disabled = false, key = label) {
    return h(TouchableOpacity, { key, accessibilityRole: 'button', accessibilityLabel: label,
      accessibilityState: { disabled }, disabled, onPress,
      style: [styles.button, disabled ? { opacity: 0.45 } : null] }, h(Text, { style: styles.buttonText }, label));
  }
  function Settings() {
    const [live, setLive] = React.useState({ ...state, records: readRecords() });
    const [prefill] = React.useState(() => { const value = settingsPrefill; settingsPrefill = null; return value; });
    const [list, setList] = React.useState(() => includeChannel(adapter.listChannels(), prefill));
    const [query, setQuery] = React.useState('');
    const [selected, setSelected] = React.useState(() => new Set(prefill ? [prefill.id] : []));
    const [format, setFormat] = React.useState(FORMATS[storage.format] ? storage.format : 'html');
    const [expanded, setExpanded] = React.useState(null);
    React.useEffect(() => {
      listeners.add(setLive);
      const timer = setInterval(() => {
        // Hide another account's export list immediately after an account switch.
        if (live.records?.some(r => r.owner !== adapter.currentUserId())) setLive({ ...state, records: readRecords() });
      }, 1000);
      return () => { clearInterval(timer); listeners.delete(setLive); };
    }, [live.records]);
    const filtered = list.filter(c => (c.name + ' ' + c.id).toLowerCase().includes(query.toLowerCase()));
    const chosen = list.filter(c => selected.has(c.id));
    const refresh = () => { setList(adapter.listChannels()); setSelected(new Set()); setLive({ ...state, records: readRecords() }); };
    const toggle = id => setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    const header = h(View, { style: styles.pad },
      h(Text, { style: styles.title }, 'DM Export'),
      h(Text, { style: styles.text }, 'Save the full available history of your DMs and group DMs.'),
      h(Text, { style: styles.muted }, 'Media stays linked to Discord. Keep the app open during export. Long histories are split into parts of up to 2,000 messages (or about 4 MB of raw data).'),
      h(View, { style: styles.row }, ...Object.keys(FORMATS).map(f => button(`${f === format ? '✓ ' : ''}${f.toUpperCase()}`, () => { setFormat(f); storage.format = f; }, live.busy))),
      h(TextInput, { style: styles.input, placeholder: 'Search conversations', placeholderTextColor: '#aeb1c6', accessibilityLabel: 'Search conversations', value: query, onChangeText: setQuery, autoCapitalize: 'none' }),
      h(View, { style: styles.row }, button('Refresh list', refresh, live.busy), button('Select shown', () => setSelected(new Set([...selected, ...filtered.map(c => c.id)])), live.busy), button('Clear', () => setSelected(new Set()), live.busy)),
      h(Text, { style: styles.muted }, 'Missing a DM? Open it once, return here, then refresh. Only conversations known to your client appear.'),
      button(`Export selected (${chosen.length})`, () => { void startExport(chosen, format); }, live.busy || !chosen.length),
      live.busy ? button('Cancel export', () => { if (control) control.cancelled = true; publish({ text: 'Cancelling… keeping already fetched messages.' }); }) : null,
      h(View, { style: styles.card, accessibilityLiveRegion: 'polite' }, h(Text, { style: styles.text }, live.current), h(Text, { style: styles.text }, live.text), h(Text, { style: styles.muted }, `${live.count.toLocaleString()} messages fetched`)),
      h(Text, { style: styles.heading }, 'Conversations')
    );
    const footer = h(View, { style: styles.pad },
      h(Text, { style: styles.heading }, 'Saved exports'),
      h(Text, { style: styles.muted }, 'Saved inside Discord until you use Save / share. Select a Files or storage app to retain a copy. Part 0001 contains the newest messages; each part reads oldest first. The index JSON records whether the whole conversation finished.'),
      ...live.records.filter(r => r.owner === adapter.currentUserId()).map(record => h(View, { key: record.id, style: styles.card },
        h(Text, { style: styles.text }, record.channelName),
        h(Text, { style: styles.muted }, `${record.complete ? 'Complete' : 'INCOMPLETE (' + record.status + ')'} · ${record.count.toLocaleString()} messages · ${record.format.toUpperCase()}`),
        record.error ? h(Text, { style: styles.muted }, record.error) : null,
        button('Save / share files', () => { void share(record); }, live.busy || !record.files.length, record.id + '-share'),
        button(expanded === record.id ? 'Hide files' : `Individual files (${record.files.length})`, () => setExpanded(expanded === record.id ? null : record.id), false, record.id + '-expand'),
        ...(expanded === record.id ? record.files.map(file => button(file.filename, () => { void share(record, file); }, live.busy, file.filename)) : [])
      )),
      button('Compatibility details', () => Alert.alert('Compatibility', Object.entries(adapter.capabilities()).map(([key, value]) => `${key}: ${value ? 'available' : 'missing'}`).join('\n') + '\n\nVersion 0.2.0 — requires on-device verification.')),
      h(Text, { style: styles.muted }, 'Based on the idea of Nightcord / TestCord ExportDM. This version never uploads your exports or sends messages to a conversation. JSON retains the original API message fields; other formats are readable views. Previously deleted messages cannot be recovered.')
    );
    return h(FlatList, { style: styles.page, data: filtered, keyExtractor: item => item.id,
      keyboardShouldPersistTaps: 'handled', ListHeaderComponent: header, ListFooterComponent: footer,
      initialNumToRender: 20, windowSize: 5,
      ListEmptyComponent: h(Text, { style: [styles.muted, styles.pad] }, 'No matching DMs. Open a DM and refresh the list.'),
      renderItem: ({ item }) => h(TouchableOpacity, { disabled: live.busy, accessibilityRole: 'checkbox',
        accessibilityState: { checked: selected.has(item.id), disabled: live.busy },
        onPress: () => toggle(item.id), style: [styles.channel, selected.has(item.id) ? { borderColor: '#aab4ff', borderWidth: 1 } : null] },
      h(Text, { style: styles.text }, `${selected.has(item.id) ? '✓ ' : ''}${item.name}`),
      h(Text, { style: styles.muted }, item.type === 3 ? 'Group DM' : 'Direct message'))
    });
  }
  function openSettings(channel) {
    settingsPrefill = channel ? { ...channel } : null;
    try {
      const rootNavigation = vd.metro?.findByProps?.('getRootNavigationRef')?.getRootNavigationRef?.();
      if (typeof rootNavigation?.navigate === 'function') {
        rootNavigation.navigate('PUPU_CUSTOM_PAGE', { title: 'DM Export', render: Settings });
        return true;
      }
    } catch { /* Fall through to a safe error instead of crashing Discord. */ }
    settingsPrefill = null;
    Alert.alert('DM Export', 'This Kettu build did not expose the settings navigator. Open Kettu → Plugins → DM Export → Configure manually.');
    return false;
  }

  return {
    settings: Settings,
    onLoad() {
      alive = true;
      // Previous in-progress jobs cannot resume after process termination.
      if (Array.isArray(storage.exports)) storage.exports = storage.exports.map(r => r.status === 'running' ? { ...r, status: 'interrupted', complete: false } : r);
      publish({ records: readRecords() });
      try {
        cleanups.push(vd.commands.registerCommand({
          name: 'exportdm',
          description: 'Open DM Export for this chat, or export it immediately.',
          options: [
            { name: 'action', description: 'What to do. Defaults to opening the menu.', type: 3, required: false,
              choices: [{ name: 'Open menu', value: 'menu' }, { name: 'Export now', value: 'export' }] },
            { name: 'format', description: 'Export format. Setting this also implies Export now.', type: 3, required: false,
              choices: Object.keys(FORMATS).map(value => ({ name: value.toUpperCase(), value })) },
            { name: 'share', description: 'Open the Save/Share chooser when a direct export finishes. Defaults to true.', type: 5, required: false }
          ],
          execute(args, ctx) {
            const channel = adapter.describeChannel(ctx.channel);
            if (!channel) { Alert.alert('DM Export', 'Run this command inside a DM or group DM.'); return; }
            const values = Object.fromEntries((args || []).filter(Boolean).map(arg => [arg.name, arg.value]));
            const impliedExport = values.format != null || values.share != null;
            const action = String(values.action || (impliedExport ? 'export' : 'menu')).toLowerCase();
            if (action === 'menu') { openSettings(channel); return; }
            if (action !== 'export') { Alert.alert('DM Export', 'Action must be menu or export.'); return; }
            const format = String(values.format || (FORMATS[storage.format] ? storage.format : 'html')).toLowerCase();
            if (!FORMATS[format]) { Alert.alert('DM Export', 'Format must be html, txt, json, csv, or md.'); return; }
            const shouldShare = values.share !== false;
            toast(`Exporting ${channel.name} as ${format.toUpperCase()}…`);
            void startExport([channel], format).then(async records => {
              const record = records[0];
              if (!record?.complete) { toast('DM export did not complete. Open DM Export settings for details.'); return; }
              toast(`DM export complete: ${record.count.toLocaleString()} messages.`);
              if (shouldShare) await share(record);
            }).catch(errorAlert);
            // MUST return undefined: Kettu sends object return values as messages.
          }
        }));
      } catch { /* The complete UI remains usable if slash-command APIs change. */ }
    },
    onUnload() {
      alive = false;
      if (control) control.cancelled = true;
      for (const cleanup of cleanups.splice(0)) if (typeof cleanup === 'function') cleanup();
      listeners.clear();
    }
  };
}

return createPlugin(vendetta);
})()
