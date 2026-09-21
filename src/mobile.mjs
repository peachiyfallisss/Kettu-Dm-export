// SPDX-License-Identifier: GPL-3.0-or-later

export function createMobileAdapter(vd, environment = globalThis) {
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
    const required = ['account', 'channels', 'request', 'fileWrite'];
    const missing = required.filter(k => !caps[k]);
    if (missing.length) throw new Error(`This Discord/Kettu build is missing: ${missing.join(', ')}. No history was fetched. Check the compatibility details in this plugin's settings.`);
  };
  const sharingDiagnostics = () => {
    const interesting = /share|save|file|download|document|intent|chooser|export/i;
    const propertyNames = [
      'share', 'shareFile', 'shareFiles', 'shareSingle', 'openShareSheet', 'showShareSheet',
      'presentShareSheet', 'saveFile', 'saveToFiles', 'downloadFile', 'openFile', 'openDocument'
    ];
    const lines = [];
    const seen = new Set();
    for (const prop of propertyNames) {
      let module = null;
      try { module = metro.findByProps?.(prop); } catch { /* Probe next property. */ }
      if (!module) continue;
      let keys = [];
      try { keys = Object.keys(module).filter(key => interesting.test(key)).slice(0, 30); } catch { /* Some Metro exports are proxies. */ }
      const line = `Metro ${prop}: ${keys.length ? keys.join(', ') : 'module found; matching keys not enumerable'}`;
      if (!seen.has(line)) { seen.add(line); lines.push(line); }
    }
    const nativeNames = new Set();
    for (const source of [RN.NativeModules, environment.nativeModuleProxy]) {
      try {
        for (const name of Object.keys(source || {})) if (interesting.test(name)) nativeNames.add(name);
      } catch { /* Native proxy may not be enumerable. */ }
    }
    try {
      const loader = environment.__PYON_LOADER__;
      if (loader?.loaderName || loader?.loaderVersion) lines.unshift(`Loader: ${loader.loaderName || 'unknown'} ${loader.loaderVersion || ''}`.trim());
    } catch { /* Loader identity is optional. */ }
    lines.push(`Native module names: ${nativeNames.size ? [...nativeNames].slice(0, 50).join(', ') : 'none matching share/save/file patterns'}`);
    return lines.join('\n');
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
  return { RN, React: metro.common.React, listChannels, describeChannel, currentUserId, verifyOwner, request, write, shareFiles, capabilities, ensureReady, sharingDiagnostics };
}
