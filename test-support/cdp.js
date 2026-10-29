// Headless Microsoft Edge driven over the DevTools protocol (no extra dependency: `ws` is already a dependency).
//
//   const browser = await launch();
//   const page = await browser.page('http://localhost:5298/', initScript);   // one isolated browser context per page
//   await browser.eval(page, 'document.title');
//   await browser.waitFor(page, 'document.readyState === "complete"');
//   await browser.close();
//
// Pages get their own context (own cookies, localStorage), so "GM" and "phone" pages in one browser do not share state.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

export const findEdge = () => EDGE_CANDIDATES.find(path => existsSync(path)) ?? null;
export const browserAvailable = () => findEdge() !== null;

const DEFAULT_ARGS = [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  // headless pages must not be slowed down when they are "in the background": that would be a measurement artefact
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
];

/**
 * launch({ args }) -> browser
 *   cmd(method, params, sessionId)     raw protocol call
 *   page(url, setupScript) -> session  new context + page; setupScript runs before any page script on every navigation
 *   eval(session, expression)          Runtime.evaluate with awaitPromise/returnByValue; throws on exceptions
 *   waitFor(session, expression, ms, label)   poll until the expression is truthy
 *   click(session, textRegex)          click the first <button> whose text matches
 *   problems(session)                  page errors, console errors and HTTP >= 400 collected since the page was created
 *   cpu()                              SystemInfo.getProcessInfo -> [{ type, id, cpuTime }]
 *   closePage(session)                 close one page and its context
 *   close()
 */
export async function launch({ args = [], executablePath = findEdge() } = {}) {
  if (!executablePath) throw new Error('Microsoft Edge was not found (set EDGE_PATH).');
  const profile = await mkdtemp(join(tmpdir(), 'rf-edge-'));
  const child = spawn(executablePath, [...DEFAULT_ARGS, '--remote-debugging-port=0', `--user-data-dir=${profile}`, ...args, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let exited = false;
  child.on('exit', () => { exited = true; });

  let port = 0;
  for (let i = 0; i < 150 && !port; i += 1) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await sleep(100); }
  }
  // Newer Edge builds start the real browser and let the launcher process exit at once, so the launcher's exit is not an error:
  // what matters is whether the browser opened its DevTools port.
  if (!port) { child.kill(); throw new Error(`Edge did not open its DevTools port${exited ? ' (the launcher exited)' : ''}`); }
  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });

  const pending = new Map();
  const bySession = new Map(); // sessionId -> { errors: [] , contextId, targetId }
  let seq = 0;
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message ?? 'protocol error'} ${JSON.stringify(message.error)}`));
      else resolve(message.result);
      return;
    }
    const record = bySession.get(message.sessionId);
    if (!record) return;
    const { method, params } = message;
    if (method === 'Runtime.exceptionThrown') record.errors.push(`exception: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`);
    else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') record.errors.push(`console.error: ${params.args.map(a => a.value ?? a.description ?? '').join(' ')}`);
    else if (method === 'Log.entryAdded' && params.entry.level === 'error' && !String(params.entry.url ?? '').endsWith('/favicon.ico')) record.errors.push(`log: ${params.entry.text} ${params.entry.url ?? ''}`);
    else if (method === 'Network.responseReceived' && params.response.status >= 400 && !params.response.url.endsWith('/favicon.ico')) record.http.push(`${params.response.status} ${params.response.url}`);
  });

  const cmd = (method, params = {}, sessionId, timeoutMs = 60000) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error(`DevTools timeout: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });

  const browser = {
    cmd, profile, process: child,
    async page(url, setup = '') {
      const { browserContextId } = await cmd('Target.createBrowserContext');
      const { targetId } = await cmd('Target.createTarget', { url: 'about:blank', browserContextId });
      const { sessionId } = await cmd('Target.attachToTarget', { targetId, flatten: true });
      bySession.set(sessionId, { errors: [], http: [], contextId: browserContextId, targetId });
      for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await cmd(`${domain}.enable`, {}, sessionId);
      if (setup) await cmd('Page.addScriptToEvaluateOnNewDocument', { source: setup }, sessionId);
      await cmd('Page.navigate', { url }, sessionId);
      return sessionId;
    },
    async eval(session, expression) {
      const result = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, session);
      if (result.exceptionDetails) throw new Error(String(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)));
      return result.result.value;
    },
    async waitFor(session, expression, timeoutMs = 15000, label = expression) {
      const end = Date.now() + timeoutMs;
      let last;
      while (Date.now() < end) {
        try { last = await browser.eval(session, expression); if (last) return last; } catch (error) { last = error; }
        await sleep(100);
      }
      throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${label}${last instanceof Error ? ` (last error: ${last.message.slice(0, 200)})` : ''}`);
    },
    click(session, textRegex) {
      const source = textRegex instanceof RegExp ? textRegex.source : String(textRegex);
      const flags = textRegex instanceof RegExp ? textRegex.flags : 'i';
      return browser.eval(session, `(() => {
        const re = new RegExp(${JSON.stringify(source)}, ${JSON.stringify(flags)});
        const button = [...document.querySelectorAll('button, [role=button]')].find(b => !b.disabled && re.test(b.textContent));
        if (!button) return false; button.click(); return true;
      })()`);
    },
    problems(session) { const r = bySession.get(session); return r ? [...r.errors, ...r.http] : []; },
    async cpu() { return (await cmd('SystemInfo.getProcessInfo')).processInfo; },
    async closePage(session) {
      const record = bySession.get(session);
      if (!record) return;
      bySession.delete(session);
      try { await cmd('Target.closeTarget', { targetId: record.targetId }, undefined, 5000); } catch { /* gone */ }
      try { await cmd('Target.disposeBrowserContext', { browserContextId: record.contextId }, undefined, 5000); } catch { /* gone */ }
    },
    async close() {
      try { await cmd('Browser.close', {}, undefined, 3000); } catch { /* closing */ }
      try { socket.close(); } catch { /* closed */ }
      if (!exited) child.kill();
      for (let i = 0; i < 20 && !exited; i += 1) await sleep(100);
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    },
  };
  return browser;
}
