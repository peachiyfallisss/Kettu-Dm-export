// SPDX-License-Identifier: GPL-3.0-or-later

export function createPlugin(vd) {
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
      button('Compatibility details', () => Alert.alert('Compatibility', Object.entries(adapter.capabilities()).map(([key, value]) => `${key}: ${value ? 'available' : 'missing'}`).join('\n') + '\n\nVersion 0.2.1 — requires on-device verification.')),
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
      const showCustomAlert = vd.ui?.alerts?.showCustomAlert;
      if (typeof showCustomAlert === 'function') {
        showCustomAlert(Settings, {});
        return true;
      }
    } catch { /* Fall through to a safe error instead of crashing Discord. */ }
    settingsPrefill = null;
    Alert.alert('DM Export', 'This Kettu build did not expose the custom plugin UI. Open Kettu → Plugins → DM Export → Configure manually.');
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
