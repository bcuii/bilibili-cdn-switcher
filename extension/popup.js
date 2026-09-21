const $ = id => document.getElementById(id);
const short = h => (h || '').replace('.bilivideo.com', '');
const send = msg => chrome.runtime.sendMessage(msg).then(r => {
  if (r === undefined) throw new Error('后台无响应, 请在 chrome://extensions 刷新扩展');
  if (! r.ok) throw new Error(r.error);
  return r.data;
});

let state = {}, listNodes = [], view = 'results', viewNodes = { list: null, backup: null };

function say(text, info = false) {
  $('msg').textContent = text;
  $('msg').className = info ? 'info' : '';
}

function render() {
  $('enabled').checked = !!state.enabled;
  $('auto').checked = !!state.auto;
  $('overlay').checked = !!state.overlay;

  // 下拉框: 测过的按快慢排在前面, 其余按列表顺序
  const tested = state.results?.nodes || [];
  const seen = new Set(tested.map(n => n.host));
  const opts = tested.map(n => [n.host, short(n.host)]);
  for (const n of listNodes) if (!seen.has(n.host)) { seen.add(n.host); opts.push([n.host, short(n.host)]); }
  if (state.current && !seen.has(state.current)) opts.unshift([state.current, short(state.current)]);
  $('node').innerHTML = '';
  if (!opts.length) $('node').add(new Option('(尚未测速)', ''));
  for (const [v, t] of opts) $('node').add(new Option(t, v, false, v === state.current));

  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('on', b.dataset.view === view);
  renderRows(tested);
}

// 三个视图: 测速结果 / cdn_list.json / cdn_backup.json
function renderRows(tested) {
  const speed = Object.fromEntries(tested.map(n => [n.host, n]));
  let rows, info;
  if (view === 'results') {
    [$('col2').textContent, $('col3').textContent] = ['64KB ms', 'MB/s'];
    $('col2').title = '第一轮: 取 64 KB 的总耗时, 含建立连接, 仅用于筛选';
    $('col3').title = '第二轮: 各取 1 MB 实测速度';
    rows = tested.map(n => [n.host, n.ms, n.mbps || '-']);
    info = state.results
      ? `${state.results.scope === 'backup' ? 'backup' : '列表'}测速于 ${new Date(state.results.at).toLocaleString()}, 可用 ${tested.length} 个` +
        (state.extraNodes?.length ? `; backup 额外可用 ${state.extraNodes.length} 个` : '')
      : '尚未测速';
  } else {
    [$('col2').textContent, $('col3').textContent] = ['分组', 'MB/s'];
    $('col2').title = $('col3').title = '';
    const nodes = viewNodes[view];
    if (!nodes) { $('rows').innerHTML = '<tr><td>加载中... </td></tr>'; $('resultInfo').textContent = ''; return; }
    rows = nodes.map(n => [n.host, n.group, speed[n.host]?.mbps || '-']);
    info = view === 'list'
      ? `cdn_list.json:${nodes.length} 个节点, 测速时使用(含 backup 中测到的可用节点)`
      : `cdn_backup.json:${nodes.length} 个节点, 其中最近检测可用 ${nodes.filter(n => n.last_status === 'ok').length} 个`;
  }

  $('rows').innerHTML = '';
  for (const [host, c2, c3] of rows) {
    const tr = document.createElement('tr');
    if (host === state.current) tr.className = 'cur';
    tr.innerHTML = `<td></td><td class="n">${c2 ?? ''}</td><td class="n">${c3 ?? ''}</td>`;
    tr.firstChild.textContent = short(host);
    tr.title = '点击切换到此节点';
    tr.onclick = () => switchTo(host);
    $('rows').appendChild(tr);
  }
  $('resultInfo').textContent = info;
}

async function showView(name) {
  view = name;
  render();
  if (view === 'results' || viewNodes[view]) return;
  try {
    viewNodes[view] = await send({ type: 'getNodes', scope: view });
  } catch (e) {
    viewNodes[view] = [];
    say(view === 'backup' ? '读取 cdn_backup.json 失败(需要仓库已推送到 GitHub)' : e.message);
  }
  render();
}

async function videoTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith('https://www.bilibili.com/video/')) throw new Error('请在 B 站视频页(www.bilibili.com/video/...)打开此面板');
  return tab;
}

async function runTest(scope) {
  const tab = await videoTab();
  $('testList').disabled = $('testBackup').disabled = true;
  say('开始测速...', true);
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'runTest', scope }).catch(() => {
      throw new Error('页面脚本未就绪, 请刷新视频页后重试');
    });
    if (!r?.ok) throw new Error(r?.error);
    const rest = r.data.rest ? `, 另有 ${r.data.rest} 个在后台补测` : '';
    say(`完成: ${r.data.total} 个中可用 ${r.data.nodes.length} 个, 最快 ${short(r.data.nodes[0]?.host)}${rest}`, true);
  } finally {
    $('testList').disabled = $('testBackup').disabled = false;
  }
}

async function switchTo(host) {
  if (!host) return;
  await send({ type: 'setNode', host });
  if (!state.enabled) say('已选择节点, 启用后生效', true);
}

const guard = fn => (...a) => fn(...a).catch(e => say(e.message));

$('enabled').onchange = guard(async e => {
  const on = e.target.checked;
  if (on && !state.results) {           // 第一次启用: 先测速选最快
    try { await runTest('list'); } catch (err) { e.target.checked = false; throw err; }
  }
  await send({ type: 'setEnabled', on });
  say(on ? '已启用' : '已停用, 恢复 B 站默认节点', true);
});
$('node').onchange = guard(e => switchTo(e.target.value));
$('testList').onclick = guard(() => runTest('list'));
$('testBackup').onclick = guard(() => runTest('backup'));
for (const b of document.querySelectorAll('.tab')) b.onclick = guard(() => showView(b.dataset.view));
$('clear').onclick = guard(async () => {
  try {
    await send({ type: 'clearData' });
  } catch (e) {                      // 后台没响应时自己清, 并尽量取消测速, 关掉重定向
    for (const t of await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' }))
      chrome.tabs.sendMessage(t.id, { type: 'cancelTest' }).catch(() => {});
    await chrome.storage.local.clear();
    await send({ type: 'setEnabled', on: false }).catch(() => {});
  }
  state = await send({ type: 'getState' }).catch(() => ({}));
  viewNodes = { list: null, backup: null };
  await showView('results');
  say('已清除本地数据', true);
});
$('auto').onchange = guard(e => send({ type: 'setOption', key: 'auto', value: e.target.checked }));
$('overlay').onchange = guard(e => send({ type: 'setOption', key: 'overlay', value: e.target.checked }));

chrome.runtime.onMessage.addListener(m => {
  if (m.type === 'progress') say(`${m.phase} ${m.done}/${m.total}...`, true);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [k, { newValue }] of Object.entries(changes)) state[k] = newValue;
  render();
});

(async () => {
  state = await send({ type: 'getState' });
  render();
  listNodes = await send({ type: 'getNodes', scope: 'list' }).catch(() => []);
  render();
})().catch(e => say(e.message));
