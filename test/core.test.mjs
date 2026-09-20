import test from 'node:test';
import assert from 'node:assert/strict';
import { exportConversation, renderPart, requestPage, csvCell, compareIds, safeUrl, Cancelled } from '../src/core.mjs';

const channel = { id: '999', type: 1, name: 'Peach & friend' };
const msg = id => ({ id: String(id), channel_id: '999', author: { id: '42', username: 'friend' }, timestamp: '2026-09-20T16:30:00Z', content: `Message ${id}`, attachments: [], embeds: [] });
const noWait = async () => {};
function harness(overrides = {}) {
  const files = new Map();
  const args = { channel, format: 'json', control: { cancelled: false }, request: async () => ({ body: [] }), write: async (name, content) => files.set(name, content), wait: noWait, runId: 'test', ...overrides };
  return { files, args, run: () => exportConversation(args) };
}

test('exports full history, paginates short pages, deduplicates and preserves snowflake precision', async () => {
  const pages = [
    ['10000000000000000004', '10000000000000000003', '10000000000000000003'],
    ['10000000000000000003', '10000000000000000002'],
    ['10000000000000000001'], []
  ];
  const cursors = [];
  const x = harness({ partSize: 2, request: async (_id, before) => { cursors.push(before); return { body: pages.shift().map(msg) }; } });
  const result = await x.run();
  assert.equal(result.summary.complete, true);
  assert.equal(result.summary.messageCount, 4);
  assert.deepEqual(cursors, [undefined, '10000000000000000003', '10000000000000000002', '10000000000000000001']);
  assert.deepEqual(result.summary.parts.map(p => p.count), [2, 2]);
  const ids = result.summary.parts.flatMap(p => JSON.parse(x.files.get(p.filename)).messages.map(m => m.id));
  assert.deepEqual(ids, ['10000000000000000003', '10000000000000000004', '10000000000000000001', '10000000000000000002']);
  assert.equal(JSON.parse(x.files.get(result.indexName)).complete, true);
});

test('rate limiting honors Retry-After and retries the same page', async () => {
  const waits = []; let calls = 0;
  const page = await requestPage(async () => ++calls === 1 ? { status: 429, body: { retry_after: 67.25 } } : { status: 200, body: [msg(3)] }, '999', undefined, {}, () => {}, async ms => waits.push(ms));
  assert.deepEqual(waits, [67750]); assert.equal(page.length, 1);
});

test('thrown HTTP rate-limit response retries; retry count is bounded', async () => {
  let calls = 0;
  await assert.rejects(requestPage(async () => { calls++; throw { status: 429, body: { retry_after: 1 } }; }, '999', undefined, {}, () => {}, noWait), /retry limit/);
  assert.equal(calls, 7);
});

test('HTTP 403 preserves fetched messages and explicitly marks incomplete', async () => {
  let calls = 0;
  const x = harness({ request: async () => ++calls === 1 ? { body: [msg(5), msg(4)] } : { status: 403, body: {} } });
  const r = await x.run();
  assert.equal(r.summary.complete, false); assert.equal(r.summary.status, 'failed');
  assert.equal(r.summary.messageCount, 2);
  assert.match(JSON.parse(x.files.get(r.indexName)).error, /403/);
});

test('cancellation keeps fetched messages without reporting success', async () => {
  const control = { cancelled: false };
  const x = harness({ control, request: async () => ({ body: [msg(9)] }), wait: async () => { control.cancelled = true; throw new Cancelled(); } });
  const r = await x.run();
  assert.equal(r.summary.status, 'cancelled'); assert.equal(r.summary.complete, false); assert.equal(r.summary.messageCount, 1);
});

test('repeated page terminates with an incomplete export instead of looping', async () => {
  const x = harness({ request: async () => ({ body: [msg(10)] }) });
  const r = await x.run();
  assert.equal(r.summary.status, 'failed'); assert.match(r.summary.error, /repeated a page/); assert.equal(r.summary.messageCount, 1);
});

test('malformed responses and wrong-channel messages cannot become successful exports', async () => {
  for (const body of [{ messages: [] }, [{ ...msg(10), channel_id: '1000' }], [{ id: 123 }]]) {
    const x = harness({ request: async () => ({ body }) });
    assert.equal((await x.run()).summary.complete, false);
  }
});

test('large history is written in bounded parts; all 4501 messages are retained', async () => {
  let next = 4501, largestWrite = 0;
  const x = harness({ request: async () => { const batch = []; while (next > 0 && batch.length < 100) batch.push(msg(next--)); return { body: batch }; } });
  const r = await x.run();
  for (const part of r.summary.parts) largestWrite = Math.max(largestWrite, JSON.parse(x.files.get(part.filename)).messages.length);
  assert.equal(r.summary.messageCount, 4501); assert.equal(r.summary.parts.length, 3); assert.equal(largestWrite, 2000);
});

test('byte threshold also splits unusually large messages', async () => {
  let calls = 0;
  const x = harness({ partBytes: 100, request: async () => ({ body: calls++ ? [] : [msg(2), msg(1)] }) });
  assert.equal((await x.run()).summary.parts.length, 2);
});

test('write failures never report a complete export', async () => {
  let calls = 0;
  const x = harness({ request: async () => ({ body: calls++ ? [] : [msg(2)] }), write: async name => { if (name.includes('_part-')) throw new Error('Disk full'); } });
  const r = await x.run(); assert.equal(r.summary.complete, false); assert.match(r.summary.error, /Disk full/);
});

test('HTML escapes author, content, filenames, replies, title and dangerous links', () => {
  const m = msg(1); m.content = '<script>alert(1)</script>'; m.author.username = '"><img src=x onerror=alert(1)>';
  m.attachments = [{ url: 'javascript:alert(1)', filename: '<iframe>', content_type: 'image/png' }];
  m.referenced_message = { ...msg(2), content: '<svg onload=x>' };
  const html = renderPart([m], { channelName: '</title><script>bad</script>', part: 1, exportedAt: 'now' }, 'html');
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes('default-src'));
  assert.equal(safeUrl('https://example.com/a?x=1&b=2'), 'https://example.com/a?x=1&b=2');
  assert.equal(safeUrl('data:text/html,evil'), '');
});

test('CSV quoting and formula escaping cover whitespace-prefix injection', () => {
  assert.equal(csvCell('=SUM(A1)'), '"\'=SUM(A1)"');
  assert.equal(csvCell(' \t@bad'), '"\' \t@bad"');
  assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"');
});

test('JSON retains Unicode, full replies, polls, components and raw metadata', () => {
  const m = { ...msg(1), content: 'こんにちは 🦊', components: [{ type: 1 }], poll: { question: { text: 'Which?' } }, referenced_message: { ...msg(2), content: 'x'.repeat(300) } };
  const out = JSON.parse(renderPart([m], { channelName: '日本語', part: 1 }, 'json'));
  assert.deepEqual(out.messages[0], m);
});

test('Markdown fences cannot be escaped by message text', () => {
  const out = renderPart([{ ...msg(1), content: '```\n<script>\n````' }], { channelName: 'Friend', part: 1 }, 'md');
  assert.ok(out.includes('`````text')); assert.ok(out.endsWith('`````\n'));
});

test('snowflakes sort exactly without numeric precision loss', () => {
  assert.ok(compareIds('9999999999999999999', '10000000000000000000') < 0);
  assert.ok(compareIds('10000000000000000001', '10000000000000000002') < 0);
});
