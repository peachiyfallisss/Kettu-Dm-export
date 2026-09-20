// SPDX-License-Identifier: GPL-3.0-or-later
// Mobile reimplementation inspired by Nightcord's TestCord ExportDM.

export const FORMATS = {
  html: 'text/html', txt: 'text/plain', json: 'application/json',
  csv: 'text/csv', md: 'text/markdown'
};

export class Cancelled extends Error {
  constructor() { super('Export cancelled'); this.name = 'Cancelled'; }
}

export function checkCancelled(control) {
  if (control?.cancelled) throw new Cancelled();
}

export async function cancellableWait(ms, control) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    checkCancelled(control);
    await new Promise(resolve => setTimeout(resolve, Math.min(200, end - Date.now())));
  }
  checkCancelled(control);
}

export function compareIds(a, b) {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

export function validId(id) { return typeof id === 'string' && /^\d{1,22}$/.test(id); }

function statusOf(error) {
  return Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? 0);
}

export async function requestPage(request, channelId, before, control, onStatus, wait = cancellableWait) {
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

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function safeUrl(value) {
  // Restrict generated clickable links/media; never emit javascript/data/file URLs.
  const s = String(value ?? '');
  return /^https?:\/\/[^\s<>"'\\]+$/i.test(s) ? s : '';
}

export function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export function authorName(m) { return m.author?.global_name || m.author?.username || m.author?.id || 'Unknown'; }

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

export function renderPart(messages, meta, format) {
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

export function safeFilename(name) {
  return String(name || 'DM').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 48) || 'DM';
}

// Writes bounded parts before requesting more history. No complete flag until
// Discord returns an empty page. Small nonempty pages still advance the cursor.
export async function exportConversation({ channel, format, request, write, control, onProgress = () => {}, wait = cancellableWait, partSize = 2000, partBytes = 4 * 1024 * 1024, runId }) {
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
