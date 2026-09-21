// 后台: 保存状态, 维护重定向规则, 观察视频分片请求(签名 URL, 实际节点, 网速).
// 测速在页面的 content.js 中进行(需要页面的 Origin/Referer).

const REPO_RAW = 'https://raw.githubusercontent.com/bcuii/bilibili-cdn-switcher/master/';
// 远程列表拿不到时使用(例如仓库尚未推送)
const SEED_NODES = [
  'upos-sz-estgcos.bilivideo.com', 'upos-sz-estgoss.bilivideo.com',
  'upos-sz-mirrorali.bilivideo.com', 'upos-sz-mirroralio1.bilivideo.com',
  'upos-sz-mirrorhw.bilivideo.com', 'upos-sz-mirrorhwb.bilivideo.com', 'upos-sz-mirrorhwo1.bilivideo.com',
  'upos-sz-mirror08c.bilivideo.com', 'upos-sz-mirror08h.bilivideo.com',
  'upos-sz-mirrorcos.bilivideo.com', 'upos-sz-mirrorcosb.bilivideo.com', 'upos-sz-mirrorcoso1.bilivideo.com',
  'upos-sz-mirrorbos.bilivideo.com', 'upos-sz-mirrorbd.bilivideo.com',
  'upos-sz-mirroraliov.bilivideo.com', 'upos-sz-mirrorcosov.bilivideo.com',
].map(host => ({ host, group: 'upos' }));

const MEDIA_RE = /^https:\/\/[^/]+\.bilivideo\.com\/upgcxcode\//;
const PROBE_MARK = 'cdnsw_probe=';
const RULE_ALLOW_PROBE = 1, RULE_REDIRECT = 2;

const DEFAULTS = {
  enabled: false, current: null, auto: false, overlay: false,
  results: null,        // {at, scope, nodes: [{host, ms, mbps?}]}, 按快慢排序
  extraNodes: [],       // 测 backup 时发现的, 主列表之外的可用节点
  listCache: null,      // {updated, nodes: [{host, group}]}
};
const getState = () => chrome.storage.local.get(DEFAULTS);
const setState = (o) => chrome.storage.local.set(o);

// ---------- 重定向规则 ----------
async function applyRule() {
  const { enabled, current } = await getState();
  const addRules = [{
    // 测速请求带 cdnsw_probe 标记, 不参与重定向
    id: RULE_ALLOW_PROBE, priority: 2, action: { type: 'allow' },
    condition: { urlFilter: PROBE_MARK, requestDomains: ['bilivideo.com'] },
  }];
  if (enabled && current) {
    addRules.push({
      id: RULE_REDIRECT, priority: 1,
      action: { type: 'redirect', redirect: { transform: { scheme: 'https', host: current } } },
      condition: {
        regexFilter: '^https://[^/]+\\.bilivideo\\.com/upgcxcode/',
        initiatorDomains: ['bilibili.com'],
        excludedRequestDomains: [current],
        resourceTypes: ['xmlhttprequest', 'media', 'other'],
      },
    });
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ALLOW_PROBE, RULE_REDIRECT], addRules,
  });
}

// 给所有 B 站视频页发消息(标签页可能没有注入 content.js, 忽略失败)
async function notifyTabs(msg) {
  for (const t of await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' }))
    chrome.tabs.sendMessage(t.id, msg).catch(() => {});
}
const toastAll = text => notifyTabs({ type: 'toast', text });

const short = h => (h || '默认').replace('.bilivideo.com', '');

// 切换到 host; reason 用于提示文字
async function setNode(host, reason) {
  const { current, enabled } = await getState();
  await setState({ current: host });
  if (!enabled) return;
  await applyRule();
  if (host === current) {
    if (reason === 'stall') await toastAll(`重新测速后当前节点仍最快: ${short(host)}`);
    return;
  }
  const label = { manual: '已切换 CDN', test: '测速完成, 已切换到最快节点', stall: '检测到卡顿, 已自动切换 CDN' }[reason];
  await toastAll(`${label}:${short(current)} → ${short(host)}`);
}

async function setEnabled(on) {
  let { current, results } = await getState();
  if (on && !current && results?.nodes.length) current = results.nodes[0].host;
  await setState({ enabled: on, current });
  await applyRule();
  await toastAll(on ? `已启用 CDN 切换: ${short(current)}` : '已停用 CDN 切换, 恢复 B 站默认节点');
}

// ---------- 节点列表 ----------
async function fetchJson(name) {
  const r = await fetch(REPO_RAW + name + '?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.json();
}

async function getNodes(scope) {
  if (scope === 'backup') return (await fetchJson('cdn_backup.json')).nodes;
  let { listCache, extraNodes } = await getState();
  try {
    listCache = await fetchJson('cdn_list.json');
    await setState({ listCache });
  } catch (e) {
    console.warn('获取 cdn_list.json 失败, 使用缓存/内置列表', e);
  }
  const nodes = [...(listCache?.nodes || SEED_NODES)];
  const seen = new Set(nodes.map(n => n.host));
  for (const host of extraNodes) if (!seen.has(host)) nodes.push({ host, group: 'backup' });
  return nodes;
}

async function testDone(scope, nodes, reason) {
  const { extraNodes, listCache, enabled } = await getState();
  const update = { results: { at: Date.now(), scope, nodes } };
  if (scope === 'backup') {
    const inList = new Set((listCache?.nodes || SEED_NODES).map(n => n.host));
    update.extraNodes = [...new Set([...extraNodes, ...nodes.map(n => n.host).filter(h => !inList.has(h))])];
  }
  await setState(update);
  if (!nodes.length) return;
  if (enabled) await setNode(nodes[0].host, reason);
  else await setState({ current: nodes[0].host });
}

// ---------- 观察视频请求 ----------
// tabId -> {sample, origin, host, done: [{t, bytes, start}], inflight: Map(requestId -> start)}
const tabs = {};
const tabInfo = id => (tabs[id] ||= { sample: null, origin: null, host: null, done: [], inflight: new Map() });
const FILTER = { urls: ['https://*.bilivideo.com/upgcxcode/*'] };

chrome.webRequest.onBeforeRequest.addListener(d => {
  if (d.tabId < 0 || d.url.includes(PROBE_MARK) || !MEDIA_RE.test(d.url)) return;
  const info = tabInfo(d.tabId);
  info.sample = d.url;
  info.origin = new URL(d.url).host;  // 重定向前的地址, 即 B 站签发的节点
  info.inflight.set(d.requestId, Date.now());
  chrome.storage.session.set({ ['sample' + d.tabId]: d.url });
}, FILTER);

chrome.webRequest.onCompleted.addListener(d => {
  if (d.tabId < 0 || d.url.includes(PROBE_MARK)) return;
  const info = tabInfo(d.tabId);
  info.host = new URL(d.url).host;
  const len = d.responseHeaders?.find(h => h.name.toLowerCase() === 'content-length');
  const now = Date.now();
  info.done.push({ t: now, start: info.inflight.get(d.requestId) || now, bytes: Number(len?.value) || 0 });
  info.inflight.delete(d.requestId);
  info.done = info.done.filter(x => now - x.t < SPEED_WINDOW);
}, FILTER, ['responseHeaders']);

const dropInflight = d => tabs[d.tabId]?.inflight.delete(d.requestId);
chrome.webRequest.onErrorOccurred.addListener(dropInflight, FILTER);

chrome.tabs.onRemoved.addListener(id => {
  delete tabs[id];
  chrome.storage.session.remove('sample' + id);
});

async function getSample(tabId) {
  return tabs[tabId]?.sample || (await chrome.storage.session.get('sample' + tabId))['sample' + tabId] || null;
}

const SPEED_WINDOW = 10000;
function stats(tabId) {
  const info = tabs[tabId] || { done: [], inflight: new Map() };
  const now = Date.now();
  const recent = info.done.filter(x => now - x.t < SPEED_WINDOW);
  const bytes = recent.reduce((s, x) => s + x.bytes, 0);
  // 速度按实际传输时段折算: 从最早的请求开始算起(最多回看 SPEED_WINDOW)
  const starts = [...recent.map(x => x.start), ...info.inflight.values()];
  const from = Math.max(now - SPEED_WINDOW, Math.min(now, ...starts));
  return {
    host: info.host ?? null, origin: info.origin ?? null,
    downloading: info.inflight.size > 0,
    idle: !info.inflight.size && !recent.length,
    mbps: bytes / Math.max(0.5, (now - from) / 1000) / 1048576,
  };
}

// ---------- 消息 ----------
const handlers = {
  getState,
  getNodes: m => getNodes(m.scope),
  getSample: (m, s) => getSample(s.tab?.id),
  stats: (m, s) => stats(s.tab?.id),
  testDone: m => testDone(m.scope, m.nodes, m.reason),
  // 后台补测的中间结果: 只更新表格, 不切换节点
  testUpdate: async m => {
    const { results } = await getState();
    await setState({ results: { at: results?.at || Date.now(), scope: m.scope, nodes: m.nodes } });
  },
  setNode: m => setNode(m.host, 'manual'),
  setEnabled: m => setEnabled(m.on),
  setOption: m => setState({ [m.key]: m.value }),
  clearData: async () => {
    await notifyTabs({ type: 'cancelTest' });  // 否则后台补测会把结果又写回来
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
    await applyRule();  // 恢复默认(停用)后移除重定向规则
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const h = handlers[msg.type];
  if (!h) return;
  Promise.resolve(h(msg, sender)).then(
    r => reply({ ok: true, data: r }),
    e => reply({ ok: false, error: String(e?.message || e) }));
  return true;
});

chrome.runtime.onInstalled.addListener(applyRule);
chrome.runtime.onStartup.addListener(applyRule);
