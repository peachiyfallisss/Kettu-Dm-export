# DM Export for Kettu

A mobile reimplementation of the full-history DM export feature in [Nightcord / TestCord's ExportDM](https://github.com/TestcordDev/TestCord/tree/main/src/testcordplugins/exportDM), using Kettu's Vendetta-compatible plugin loader.

**Version 0.2.2 — experimental.** Automated tests pass, but this build has not been run inside a physical Android/iOS Discord client. Discord changes its internal modules frequently. The plugin checks for the necessary APIs before fetching messages and reports missing capabilities in its settings.

## What it does

- Exports one or several selected DMs and group DMs, including older messages that are not loaded on screen.
- Offers HTML, TXT, JSON, CSV, and Markdown. JSON retains the complete message objects returned by Discord, including full reply data, attachments, embeds, reactions, stickers, polls and other metadata.
- Fetches history in pages of 100, with a one-second pause between pages, bounded retries, and server-directed rate-limit waits.
- Shows progress, allows cancellation, and keeps fetched data when a later request fails.
- Writes native files locally. When Kettu exposes a compatible native share module, **Save / share files** opens the phone's chooser. Missing sharing no longer blocks the export itself.
- Uses Discord's existing authenticated HTTP client. You never paste a Discord token, and the plugin never extracts, stores, or logs one.
- Registers a local `/exportdm` shortcut. It does not send an export, bot reply, status message, or command text to the conversation.

## Install while keeping this repository private

Kettu requests a plugin's `manifest.json` and `index.js` without GitHub authentication. A private GitHub raw URL therefore cannot be used as a normal install link. Do not put a GitHub access token in that URL. The included temporary server exposes only the two plugin files over your local network; your repository stays private.

1. Download this private repository's ZIP while signed in to GitHub and extract it, or clone it with your own authenticated Git setup.
2. On a computer with **Node.js 20 or newer**, open a terminal in the extracted `kettu-dm-export` folder. No dependency installation is needed. Run:

   ```sh
   npm run serve
   ```

   The committed `dist/` folder is already built. If you edit the source, run `npm run build` first.
3. Put the computer and phone on the same trusted Wi-Fi. In Kettu, open **Settings → Plugins → Add plugin** and paste the full **On the same Wi-Fi** URL printed by the terminal, including its final slash. Do not use this as Kettu's custom bundle URL.
4. Enable **DM Export for Kettu**. In its plugin information menu, choose **Disable updates**, because the temporary installation server will be stopped.
5. Stop the server with **Ctrl+C**. Kettu stores the installed plugin locally, so it does not need the server to run exports.
6. Open the plugin's **Configure** page to select conversations and export. Alternatively run `/exportdm` inside a DM, then return to Configure to save the resulting files.

If you already have Node.js running on the phone itself, the same server also prints a `127.0.0.1` URL for that case. Do not use `127.0.0.1` on the phone when the server runs on a different computer.

For later updates, run `npm run build` and `npm run serve`, save your existing exports outside Discord, then reinstall from the newly printed URL. The server generates a new random path each time; do not expect an old install URL to work after restarting it. No public hosting or GitHub Pages is required.

## Slash command

Run `/exportdm` inside a DM or group DM. With no options, it opens DM Export in a Kettu modal with the current conversation already selected. The modal includes its own **Close** button, and Android Back is handled when available.

For a menu-free export, choose **Export now** in the `action` option. `format` can be HTML, TXT, JSON, CSV, or Markdown; if omitted, the most recently selected format is used. Direct exports open the phone's Save / Share chooser when Kettu exposes a compatible native share module. If sharing is unavailable, the export still completes and remains in Kettu/Discord app storage. Set `share` to false to skip the chooser deliberately. Supplying `format` or `share` also implies a direct export.

The command never posts anything into the conversation. Keep Discord in the foreground while a direct export runs. Progress is still recorded in the plugin's saved exports list, so an incomplete export can be inspected later from Configure.

## Using the exports

1. Open **Configure**, select conversations, pick a format and tap **Export selected**.
2. Keep Discord in the foreground and the phone awake while it fetches. If a conversation is missing, open that DM once and refresh the list.
3. After export, tap **Save / share files** under the saved export. If your destination cannot accept several files, use **Individual files** to save them one at a time.
4. Keep the `_index.json` file together with every part. It records the message count and completion status. **Only `complete: true` means the exporter reached the end of available history.**

Long conversations are divided into parts of at most 2,000 messages, or approximately 4 MiB of raw message data, whichever is reached first. This keeps memory use bounded instead of holding an entire multi-year conversation in phone RAM. A single unusually large message can exceed the byte threshold; it is kept intact. Part `0001` contains the newest messages. Each part is sorted oldest first; to read the whole history chronologically, start with the highest-numbered part and work down to `0001`.

An empty conversation produces only an index. Cancellation, lost access, malformed responses, repeated pages, or exhausted retries produce an incomplete index instead of a false success. If the app is killed, any saved index remains incomplete and the plugin marks its saved job interrupted at next load. There is no automatic resume yet; start a new export to try again. Saves are account-scoped, and switching accounts stops further requests and prevents sharing another account's saved entries.

Exports stay in Discord's application documents directory until you save/share them elsewhere. Clearing Discord's app data or uninstalling the app may remove them. Removing plugin data can also remove the list used to access saved exports; save important files outside the app first.

## Limits

- This exports currently accessible history. It cannot recover previously deleted messages, inaccessible DMs, or old edit versions. It does not connect to desktop message-logger databases.
- Media is represented by Discord attachment links. The files are **not offline media backups**; links may expire. HTML can load remote images/videos when opened with network access.
- HTML/TXT/Markdown/CSV are readable views; JSON is the most faithful format. HTML displays user text safely rather than rendering arbitrary embedded HTML or scripts.
- History is read over time, not as an atomic snapshot. Messages added after the first page, or edited/deleted while the export runs, may not be reflected consistently.
- The plugin requires Kettu's native file manager for export. Native file sharing is optional: if a compatible RNShare-style module is absent, history can still be exported, but the files remain in Discord/Kettu app storage until a compatible export/share path is available. React Native's text-only sharing API is not treated as a file fallback.
- Full on-device compatibility and the native Files chooser still need verification on your actual Kettu/Discord version.

## Troubleshooting

- **Private GitHub URL does not install:** use the local server instructions above.
- **Cannot reach the install server:** confirm both devices are on the same Wi-Fi, the terminal remains open, the URL is complete, and your computer allows this Node server on the private network. Guest Wi-Fi may isolate devices. Stop after installation.
- **Missing conversations:** open the desired DM, return to Configure, and refresh. This does not enumerate hidden or inaccessible channels.
- **Missing capabilities:** open **Compatibility details** and report the missing field(s), plus your Kettu version and Discord build. Do not include tokens or private message contents.
- **Interrupted/failed export:** files already saved remain available. Inspect the index and start a fresh export if you need the full history.
- **Native chooser dismisses:** the files remain saved. Tap Save / share again or try one file at a time.

## Development and tests

```sh
npm test
npm run build
npm run serve
```

No third-party build or test dependencies are required. `scripts/build.mjs` produces the exact single-expression bundle expected by Kettu's plugin evaluator and adds a SHA-256 content hash to `dist/manifest.json`.

The tests cover full-history pagination, exact snowflake ordering, overlapping/repeated pages, bounded output parts, Retry-After handling, cancellation, failed writes, malformed/wrong-channel data, HTML escaping, CSV formula protection, raw JSON fidelity, Unicode, native bridge calls, account switching, unsupported native modules, and the local command/lifecycle contract. They use mocked Discord/native modules and do not establish on-device compatibility.

## Credits and source references

- Feature inspiration: [Nightcord / TestCord ExportDM](https://github.com/TestcordDev/TestCord/blob/main/src/testcordplugins/exportDM/index.tsx), credited upstream to Nightcord; GPL-3.0-or-later. This mobile implementation replaces desktop UI, token handling, browser downloads, and message-logger integration.
- [Kettu plugin evaluation and install contract](https://github.com/C0C0B01/Kettu/blob/e345bb14d357093ec3ba37b660030fd466a654c3/src/core/vendetta/plugins.ts).
- [Kettu Vendetta compatibility API](https://github.com/C0C0B01/Kettu/blob/e345bb14d357093ec3ba37b660030fd466a654c3/src/core/vendetta/api.tsx).
- [Kettu native file-manager types](https://github.com/C0C0B01/Kettu/blob/e345bb14d357093ec3ba37b660030fd466a654c3/src/lib/api/native/modules/types.ts).
- [Kettu command execution behavior](https://github.com/C0C0B01/Kettu/blob/e345bb14d357093ec3ba37b660030fd466a654c3/src/lib/api/commands/index.ts).
- [React Native Share native contract](https://github.com/react-native-share/react-native-share/blob/main/src/codegenSpec/NativeRNShare.ts).

Licensed under **GPL-3.0-or-later**. See [LICENSE](LICENSE).
