// 视频页: 测速(沿用页面的 Origin/Referer), 卡顿检测, 提示和信息浮层.

const send = msg => chrome.runtime.sendMessage(msg).then(r => {
  if (r === undefined) throw new Error('后台无响应, 请在 chrome://extensions 刷新扩展');
  if (!r.ok) throw new Error(r.error);
  return r.data;
});
const short = h => (h || '-').replace('.bilivideo.com', '');
// 进度只给弹窗看, 弹窗关着时没有接收方, 忽略失败
const progress = (phase, done, total) =>
  chrome.runtime.sendMessage({ type: 'progress', phase, done, total }).catch(() => {});

// ---------- 测速 ----------
// 两轮: 全部节点各取 64 KB 初筛; 最快的 5 个再各取 1 MB 测速,
// 随后在后台把余下节点逐个补测(不自动切换, 只更新结果)
const PROBE_SMALL = 64 * 1024, PROBE_BIG = 1024 * 1024, TOP_N = 5, REST_MAX = 30;
let testing = false, generation = 0;

async function probe(host, pathQuery, bytes, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const t0 = performance.now();
  try {
    const r = await fetch(`https://${host}/${pathQuery}&cdnsw_probe=1`, {
      headers: { Range: `bytes=0-${bytes - 1}` }, cache: 'no-store', credentials: 'omit', signal: ctrl.signal,
    });
    if (r.status !== 206) return null;
    const n = (await r.arrayBuffer()).byteLength;
    const ms = performance.now() - t0;
    return n ? { ms, mbps: n / (ms / 1000) / 1048576 } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

// 排序: 测过速的按 MB/s, 只初筛过的按耗时, 第二轮失败的排最后
const ranked = arr => [...arr].sort((a, b) =>
  (b.mbps > 0 ? 2 : b.mbps === undefined ? 1 : 0) - (a.mbps > 0 ? 2 : a.mbps === undefined ? 1 : 0) ||
  (b.mbps || 0) - (a.mbps || 0) || a.ms - b.ms);

// 后台补测: 逐个(不并发, 尽量少影响播放), 随时可被新一轮测速取消
async function testRest(rest, nodes, pathQuery, scope, gen, best) {
  for (const [i, node] of rest.entries()) {
    if (gen !== generation) return;
    const r = await probe(node.host, pathQuery, PROBE_BIG, 10000);
    node.mbps = r ? Math.round(r.mbps * 100) / 100 : 0;
    if (gen !== generation) return;
    await send({ type: 'testUpdate', scope, nodes: ranked(nodes) }).catch(() => {});
    progress('后台补测', i + 1, rest.length);
  }
  const top = ranked(nodes)[0];
  if (top && best && top.host !== best.host && top.mbps > best.mbps)
    toast(`后台补测完成, 最快节点是 ${short(top.host)}(${top.mbps} MB/s), 可在扩展中切换`);
}

// scope: 'list' | 'backup';reason: 'test' | 'stall'
async function runTest(scope, reason = 'test') {
  if (testing) throw new Error('正在测速中');
  testing = true;
  const gen = ++generation;  // 新一轮开始, 取消上一轮的后台补测
  try {
    const sample = await send({ type: 'getSample' });
    if (!sample) throw new Error('还没有捕获到视频请求, 请先播放视频再测速');
    const pathQuery = sample.split('/').slice(3).join('/');
    const hosts = [...new Set((await send({ type: 'getNodes', scope })).map(n => n.host))];
    const ok = [];
    let done = 0;
    await pool(hosts, scope === 'backup' ? 10 : 6, async host => {
      if (gen !== generation) return;
      const r = await probe(host, pathQuery, PROBE_SMALL, scope === 'backup' ? 4000 : 6000);
      if (r) ok.push({ host, ms: Math.round(r.ms) });
      progress('初筛', ++done, hosts.length);
    });
    ok.sort((a, b) => a.ms - b.ms);
    const top = ok.slice(0, TOP_N);
    for (let k = 0; k < top.length && gen === generation; k++) {
      const r = await probe(top[k].host, pathQuery, PROBE_BIG, 10000);
      top[k].mbps = r ? Math.round(r.mbps * 100) / 100 : 0;
      progress('测速', k + 1, top.length);
    }
    if (gen !== generation) throw new Error('测速已取消');
    const nodes = ranked(ok);
    await send({ type: 'testDone', scope, nodes, reason });
    if (!nodes.length) throw new Error(`${hosts.length} 个节点都不可用`);
    // 余下节点在后台慢慢补测, 不阻塞本次结果
    const rest = ok.filter(n => n.mbps === undefined).slice(0, REST_MAX);
    if (rest.length) testRest(rest, ok, pathQuery, scope, gen, nodes[0]);
    return { total: hosts.length, nodes, rest: rest.length };
  } finally {
    testing = false;
  }
}

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg.type === 'toast') toast(msg.text);
  if (msg.type === 'cancelTest') generation++;  // 让进行中的测速/后台补测停止写回结果
  if (msg.type === 'runTest') {
    runTest(msg.scope).then(d => reply({ ok: true, data: d }), e => reply({ ok: false, error: e.message }));
    return true;
  }
});

// ---------- 页面元素: 提示与信息浮层 ----------
// 挂在 <video> 的父元素里, 全屏/网页全屏时会随播放器一起显示
const findVideo = () => document.querySelector('video, bwp-video');

function mount(el, v = findVideo()) {
  const target = v?.parentElement || document.body;
  if (el.parentElement !== target) target.appendChild(el);
  el.style.position = target === document.body ? 'fixed' : 'absolute';
}

const BOX = 'z-index:2147483647;pointer-events:none;font:13px/1.6 system-ui,sans-serif;color:#fff;' +
  'background:rgba(0,0,0,.72);border-radius:6px;padding:6px 12px;';

const toastEl = document.createElement('div');
toastEl.style.cssText = BOX + 'top:12%;left:50%;transform:translateX(-50%);display:none;max-width:80%;text-align:center;';
let toastTimer;
function toast(text) {
  toastEl.textContent = text;
  mount(toastEl);
  toastEl.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 4000);
}

const overlayEl = document.createElement('div');
overlayEl.style.cssText = BOX + 'top:8px;left:8px;white-space:pre;font-family:ui-monospace,Menlo,monospace;font-size:12px;';

function bufferAhead(v) {
  const t = v.currentTime;
  for (let i = 0; i < v.buffered.length; i++) {
    if (v.buffered.start(i) <= t + 0.1 && t <= v.buffered.end(i)) return v.buffered.end(i) - t;
  }
  return 0;
}

// ---------- 主循环: 浮层刷新 + 卡顿检测 ----------
const STALL_BUFFER = 1, STALL_SECONDS = 3, STALL_INTERVAL = 500,
  SEEK_GRACE = 5000, SWITCH_COOLDOWN = 30000;
let state = {}, lastSeek = 0, lastSwitch = 0, stalledFor = 0, hookedVideo = null;

chrome.storage.local.get(null).then(s => { state = s; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [k, { newValue }] of Object.entries(changes)) state[k] = newValue;
});

async function updateOverlay() {
  const v = findVideo();
  if (!state.overlay || !v) {
    overlayEl.style.display = 'none';
    return;
  }
  const { host, origin, mbps, idle, downloading } = await send({ type: 'stats' }).catch(() => ({}));
  const lines = [`实际 ${short(host)}`];
  // 已启用但分片还来自旧节点时, 额外显示要切到哪个节点
  if (state.enabled && host && host !== state.current) lines.push(`目标 ${short(state.current)}(切换中)`);
  // 重定向生效时, 显示 B 站原本签发的节点
  if (origin && origin !== host) lines.push(`默认 ${short(origin)}`);
  // 请求还没结束时拿不到字节数, 只能先显示"下载中"
  const speed = idle ? '空闲(无请求)'
    : mbps ? (mbps.toFixed(2) + ' MB/s' + (downloading ? ' ↓' : '')) : '下载中...';
  lines.push(`网速 ${speed}`, `缓冲 ${bufferAhead(v).toFixed(1)} s`);
  overlayEl.textContent = lines.join('\n');
  mount(overlayEl, v);
  overlayEl.style.display = 'block';
}

// 卡顿: 正在播放, 不在拖动后, 前方缓冲 < 1 秒且数据不足, 持续 3 秒
function checkStall() {
  const v = findVideo();
  if (v && v !== hookedVideo) {
    v.addEventListener('seeking', () => { lastSeek = Date.now(); });
    hookedVideo = v;
  }
  const now = Date.now();
  const stalled = v && state.enabled && state.auto && !v.paused && !v.seeking &&
    now - lastSeek > SEEK_GRACE && v.readyState < 3 && bufferAhead(v) < STALL_BUFFER;
  stalledFor = stalled ? stalledFor + STALL_INTERVAL / 1000 : 0;
  if (stalledFor >= STALL_SECONDS && !testing && now - lastSwitch > SWITCH_COOLDOWN) {
    lastSwitch = now;
    stalledFor = 0;
    toast('检测到卡顿, 正在重新测速...');
    runTest('list', 'stall').catch(e => toast('卡顿测速失败: ' + e.message));
  }
}

setInterval(() => { updateOverlay().catch(() => {}); }, 1000);
setInterval(checkStall, STALL_INTERVAL);
