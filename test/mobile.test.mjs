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
  const writes = [], reads = [], shares = [], saves = [], nativeSaves = [], commands = [], alerts = [], customAlerts = [], toasts = [];
  let closedAlerts = 0;
  let owner = '42', removed = 0;
  const dm = { id: '999', type: 1, recipients: ['123'] };
  const stores = {
    ChannelStore: { getChannel: id => id === '999' ? dm : null, getPrivateChannels: () => ({ '999': dm, server: { id: '55', type: 0 } }) },
    UserStore: { getCurrentUser: () => ({ id: owner }), getUser: () => ({ username: 'Friend' }) },
    SelectedChannelStore: { getChannelId: () => '999' }
  };
  const file = {
    writeFile: async (...args) => { writes.push(args); return '/data/documents/' + args[1]; },
    readFile: async (...args) => { reads.push(args); return 'Hello 🦊'; }
  };
  const share = { open: async options => { shares.push(options); return { success: true }; }, shareSingle() {} };
  const saveDialog = {
    canSaveImage() { return true; },
    saveFile: async (...args) => { saves.push(args); return '/storage/emulated/0/Download/' + args[1]; }
  };
  const discordNative = {
    fileManager: {
      saveWithDialog: async (...args) => {
        nativeSaves.push(args);
        return { canceledByUser: false, directory: '/storage/emulated/0/Download' };
      }
    }
  };
  const http = { get: async options => { http.calls.push(options); return { status: 200, body: [] }; }, post() {}, put() {}, patch() {}, del() {}, calls: [] };
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: init => [typeof init === 'function' ? init() : init, () => {}], useEffect() {}
  };
  const RN = { NativeModules: { DCDFileManager: file, RNShare: share }, Alert: { alert: (...args) => alerts.push(args) },
    View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', TextInput: 'TextInput', FlatList: 'FlatList' };
  const alertManager = { openLazy() {}, close: () => { closedAlerts++; } };
  const navigation = { pushLazy() {} };
  const discordNativeModule = { fileManager: discordNative.fileManager };
  const vd = { metro: { common: { ReactNative: RN, React, navigation }, findByStoreName: name => stores[name],
    findByProps: (...keys) => [http, share, saveDialog, alertManager, discordNativeModule, ...Object.values(stores)].find(obj => keys.every(k => k in obj)) },
    plugin: { storage: {} }, commands: { registerCommand: command => { commands.push(command); return () => removed++; } },
    ui: {
      toasts: { showToast: text => toasts.push(text) },
      alerts: { showCustomAlert: (component, props) => customAlerts.push({ component, props }) }
    } };
  const ctx = { vendetta: vd, setTimeout, clearTimeout, setInterval, clearInterval, console, TextEncoder, Uint8Array, window: { DiscordNative: discordNative } };
  const context = vm.createContext(ctx);
  const adapter = vm.runInContext(core + '\n' + mobile + '\ncreateMobileAdapter(vendetta)', context);
  return { writes, reads, shares, saves, nativeSaves, commands, alerts, customAlerts, toasts, stores, file, share, saveDialog, discordNative, http, vd, context, adapter, switchAccount: id => { owner = id; }, removed: () => removed, closedAlerts: () => closedAlerts };
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

test('window.DiscordNative saveWithDialog fallback receives UTF-8 bytes when RNShare is missing', async () => {
  const m = mock(); delete m.share.open;
  assert.doesNotThrow(() => m.adapter.ensureReady());
  assert.equal(m.adapter.capabilities().share, true);
  assert.equal(m.adapter.shareBackend(), 'discord-native-dialog');
  await m.adapter.shareFiles([{ filename: 'DM.json', path: '/data/documents/DM.json', mime: 'application/json' }], '42');
  assert.equal(m.reads.length, 1);
  assert.equal(m.reads[0][1], 'utf8');
  assert.equal(m.nativeSaves.length, 1);
  assert.ok(m.nativeSaves[0][0] instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(m.nativeSaves[0][0]), 'Hello 🦊');
  assert.equal(m.nativeSaves[0][1], 'DM.json');
  const diagnostic = m.adapter.sharingDiagnostics();
  assert.match(diagnostic, /DiscordNative\.fileManager: saveWithDialog/);
  assert.doesNotMatch(diagnostic, /Friend|999|42/);
  assert.equal(m.http.calls.length, 0);
});

test('export preflight still works when no external save backend exists', () => {
  const m = mock(); delete m.share.open; delete m.discordNative.fileManager.saveWithDialog;
  assert.doesNotThrow(() => m.adapter.ensureReady());
  assert.equal(m.adapter.capabilities().share, false);
  assert.equal(m.adapter.shareBackend(), 'none');
});

test('path traversal cannot write outside the export directory', async () => {
  const m = mock();
  await assert.rejects(m.adapter.write('../escape.txt', 'x', '42'), /filename/);
  assert.equal(m.writes.length, 0);
});

test('built artifact follows Kettu eval contract; /exportdm opens settings with the current DM selected', () => {
  const m = mock();
  // Match Kettu's vendetta=>{return <plugin.js>} evaluation exactly.
  const factory = vm.runInContext('vendetta=>{return ' + bundle + '}', m.context);
  const plugin = factory(m.vd);
  assert.equal(typeof plugin.settings, 'function');
  plugin.onLoad();
  assert.equal(m.commands[0].name, 'exportdm');
  assert.equal(m.commands[0].options[0].name, 'action');
  const result = m.commands[0].execute([], { channel: { id: '999', type: 1, recipients: ['123'] } });
  assert.equal(result, undefined);
  assert.equal(m.alerts.length, 0);
  assert.equal(m.http.calls.length, 0);
  assert.equal(m.customAlerts.length, 1);
  assert.equal(m.customAlerts[0].props.modal, true);
  const page = m.customAlerts[0].component(m.customAlerts[0].props);
  assert.equal(page.props.data[0].id, '999');
  const row = page.props.renderItem({ item: page.props.data[0] });
  assert.equal(row.props.accessibilityState.checked, true);
  const header = page.props.ListHeaderComponent;
  const topRow = header.children[0];
  const closeButton = topRow.children.find(child => child?.props?.accessibilityLabel === 'Close');
  assert.ok(closeButton);
  closeButton.props.onPress();
  assert.equal(m.closedAlerts(), 1);
  plugin.onUnload(); assert.equal(m.removed(), 1);
});

test('/exportdm can export and share the current DM without opening settings', async () => {
  const m = mock();
  const plugin = vm.runInContext(bundle, m.context);
  plugin.onLoad();
  const result = m.commands[0].execute([
    { name: 'action', value: 'export' },
    { name: 'format', value: 'json' }
  ], { channel: { id: '999', type: 1, recipients: ['123'] } });
  assert.equal(result, undefined);
  for (let i = 0; i < 20 && m.shares.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(m.customAlerts.length, 0);
  assert.equal(m.http.calls.length, 1);
  assert.equal(m.http.calls[0].url, '/channels/999/messages');
  assert.ok(m.writes.length >= 2);
  assert.equal(m.shares.length, 1);
  assert.equal(m.shares[0].urls.length, 1);
  assert.ok(m.toasts.some(text => /complete/i.test(text)));
  plugin.onUnload();
});

test('/exportdm direct export uses DiscordNative Save As when RNShare is unavailable', async () => {
  const m = mock(); delete m.share.open;
  const plugin = vm.runInContext(bundle, m.context);
  plugin.onLoad();
  m.commands[0].execute([
    { name: 'format', value: 'json' }
  ], { channel: { id: '999', type: 1, recipients: ['123'] } });
  for (let i = 0; i < 40 && m.nativeSaves.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(m.http.calls.length, 1);
  assert.ok(m.writes.length >= 2);
  assert.equal(m.shares.length, 0);
  assert.ok(m.nativeSaves.length >= 1);
  assert.ok(m.nativeSaves.every(call => call[0] instanceof Uint8Array));
  plugin.onUnload();
});

test('/exportdm direct export respects share:false', async () => {
  const m = mock();
  const plugin = vm.runInContext(bundle, m.context);
  plugin.onLoad();
  m.commands[0].execute([
    { name: 'format', value: 'txt' },
    { name: 'share', value: false }
  ], { channel: { id: '999', type: 1, recipients: ['123'] } });
  for (let i = 0; i < 20 && m.http.calls.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  for (let i = 0; i < 20 && !m.toasts.some(text => /complete/i.test(text)); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(m.http.calls.length, 1);
  assert.equal(m.shares.length, 0);
  plugin.onUnload();
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
