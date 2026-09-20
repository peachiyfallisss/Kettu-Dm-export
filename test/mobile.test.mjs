import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

execFileSync(process.execPath, ['scripts/build.mjs']);
const bundle = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8');
const core = readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');
const mobile = readFileSync(new URL('../src/mobile.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');

function mock() {
  const writes = [], shares = [], commands = [], alerts = [];
  let owner = '42', removed = 0;
  const dm = { id: '999', type: 1, recipients: ['123'] };
  const stores = {
    ChannelStore: { getChannel: id => id === '999' ? dm : null, getPrivateChannels: () => ({ '999': dm, server: { id: '55', type: 0 } }) },
    UserStore: { getCurrentUser: () => ({ id: owner }), getUser: () => ({ username: 'Friend' }) },
    SelectedChannelStore: { getChannelId: () => '999' }
  };
  const file = { writeFile: async (...args) => { writes.push(args); return '/data/documents/' + args[1]; } };
  const share = { open: async options => { shares.push(options); return { success: true }; }, shareSingle() {} };
  const http = { get: async options => { http.calls.push(options); return { status: 200, body: [] }; }, post() {}, put() {}, patch() {}, del() {}, calls: [] };
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: init => [typeof init === 'function' ? init() : init, () => {}], useEffect() {}
  };
  const RN = { NativeModules: { DCDFileManager: file, RNShare: share }, Alert: { alert: (...args) => alerts.push(args) } };
  const vd = { metro: { common: { ReactNative: RN, React }, findByStoreName: name => stores[name],
    findByProps: (...keys) => [http, share, ...Object.values(stores)].find(obj => keys.every(k => k in obj)) },
    plugin: { storage: {} }, commands: { registerCommand: command => { commands.push(command); return () => removed++; } } };
  const ctx = { vendetta: vd, setTimeout, clearTimeout, setInterval, clearInterval, console };
  const context = vm.createContext(ctx);
  const adapter = vm.runInContext(core + '\n' + mobile + '\ncreateMobileAdapter(vendetta)', context);
  return { writes, shares, commands, alerts, stores, file, share, http, vd, context, adapter, switchAccount: id => { owner = id; }, removed: () => removed };
}

test('native adapter lists DMs, sends only GET history requests, and writes UTF-8 files', async () => {
  const m = mock(); m.adapter.ensureReady();
  const channels = m.adapter.listChannels(); assert.equal(channels.length, 1); assert.equal(channels[0].name, 'Friend');
  await m.adapter.request('999', '700', '42');
  assert.equal(m.http.calls[0].url, '/channels/999/messages');
  assert.equal(m.http.calls[0].query.limit, 100); assert.equal(m.http.calls[0].query.before, '700');
  const path = await m.adapter.write('DM_1.json', 'こんにちは 🦊', '42');
  assert.equal(m.writes[0][0], 'documents'); assert.equal(m.writes[0][2], 'こんにちは 🦊'); assert.equal(m.writes[0][3], 'utf8');
  await m.adapter.shareFiles([{ path, mime: 'application/json' }], '42');
  assert.ok(m.shares[0].urls[0].startsWith('file:///data/')); assert.equal(m.shares[0].failOnCancel, false);
});

test('account switch prevents history requests, file writes and shares', async () => {
  const m = mock(); m.switchAccount('43');
  await assert.rejects(m.adapter.request('999', undefined, '42'), /account changed/);
  await assert.rejects(m.adapter.write('test.txt', 'private', '42'), /account changed/);
  await assert.rejects(m.adapter.shareFiles([{ path: '/private/file' }], '42'), /account changed/);
  assert.equal(m.http.calls.length + m.writes.length + m.shares.length, 0);
});

test('missing native sharing fails preflight instead of fetching an unusable archive', () => {
  const m = mock(); delete m.share.open;
  assert.throws(() => m.adapter.ensureReady(), /share/);
  assert.equal(m.http.calls.length, 0);
});

test('path traversal cannot write outside the export directory', async () => {
  const m = mock();
  await assert.rejects(m.adapter.write('../escape.txt', 'x', '42'), /filename/);
  assert.equal(m.writes.length, 0);
});

test('built artifact follows Kettu eval contract; slash command returns no chat message', () => {
  const m = mock();
  // Match Kettu's vendetta=>{return <plugin.js>} evaluation exactly.
  const factory = vm.runInContext('vendetta=>{return ' + bundle + '}', m.context);
  const plugin = factory(m.vd);
  assert.equal(typeof plugin.settings, 'function');
  plugin.onLoad();
  assert.equal(m.commands[0].name, 'exportdm');
  const result = m.commands[0].execute([], { channel: { id: '999', type: 1, recipients: ['123'] } });
  assert.equal(result, undefined); assert.equal(m.alerts.length, 1);
  assert.equal(m.http.calls.length, 0); // No export before the user's local action.
  plugin.onUnload(); assert.equal(m.removed(), 1);
});

test('plugin marks process-interrupted jobs incomplete and rejects server channels', () => {
  const m = mock();
  m.vd.plugin.storage.exports = [{ id: 'old', owner: '42', status: 'running', complete: false }];
  const plugin = vm.runInContext(bundle, m.context); plugin.onLoad();
  assert.equal(m.vd.plugin.storage.exports[0].status, 'interrupted');
  assert.equal(m.commands[0].execute([], { channel: { id: '55', type: 0 } }), undefined);
  assert.equal(m.http.calls.length, 0); assert.match(m.alerts[0][1], /inside a DM/);
  plugin.onUnload();
});
