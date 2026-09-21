#!/usr/bin/env python3
"""发现新的 B 站视频 CDN 节点, 检测可用性并测速, 更新 cdn_list.json / cdn_backup.json.

只用 Python 标准库, 本地和 GitHub Actions 通用:
    python3 tools/update_cdn.py              # 检测 + 测速 + 写回两个列表
    python3 tools/update_cdn.py --no-write   # 只检测和打印, 不改文件

候选节点 = backup 中的全部节点 + ccb 节点列表 + crt.sh 证书日志 + upos 命名枚举.
可用 = 用当前视频的签名 URL 换成该节点后, Range 请求返回 206.
"""
import argparse, concurrent.futures as cf, gzip, http.cookiejar, json, re, socket, sys, time
import urllib.error, urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIST_FILE, BACKUP_FILE = ROOT / 'cdn_list.json', ROOT / 'cdn_backup.json'

UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36')
REFERER = 'https://www.bilibili.com/'
SAMPLE_VIDEOS = ['BV16M4m1m7YP', 'BV1GJ411x7h7', 'BV1xx411c7mD']  # 取签名 URL 用, 依次尝试
PROBE_BYTES = 256 * 1024

CCB_URL = 'https://kanda-akihito-kun.github.io/ccb/api/cdn.json'
CRT_URL = 'https://crt.sh/?q=%25.bilivideo.com&output=json'
UPOS_PATTERNS = [f'upos-sz-mirror{s}' for s in (
    'cos', 'cosb', 'coso1', 'cosov', 'ali', 'alib', 'alio1', 'aliov', 'hw', 'hwb', 'hwo1', 'hwov',
    '08c', '08h', 'bd', 'bos', 'ks3', 'ks3b', 'akam', 'cf1ov')] + [
    'upos-sz-estgcos', 'upos-sz-estgoss', 'upos-tf-all-hw', 'upos-tf-all-tx']


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def http_get(url, headers=None, timeout=20):
    req = urllib.request.Request(url, headers={'User-Agent': UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    return gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw


# ---------- 候选节点 ----------
def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return default


def discover():
    """返回 {host: group}, group 为 'upos' 或省份名."""
    found = {}
    try:
        for region, hosts in json.loads(http_get(CCB_URL)).items():
            for h in hosts:
                found.setdefault(h.strip().lower(), region)
        log(f'ccb: {len(found)} 个节点')
    except Exception as e:
        log(f'ccb 获取失败, 跳过: {e}')
    for attempt in range(3):  # crt.sh 经常临时返回 404/502
        try:
            n0 = len(found)
            for e in json.loads(http_get(CRT_URL, timeout=60)):
                for n in e['name_value'].lower().split('\n'):
                    if n.endswith('.bilivideo.com') and '*' not in n:
                        found.setdefault(n, 'other')
            log(f'crt.sh: 新增 {len(found) - n0} 个')
            break
        except Exception as e:
            log(f'crt.sh 获取失败(第 {attempt + 1} 次): {e}')
            time.sleep(10)
    for p in UPOS_PATTERNS:
        found.setdefault(p + '.bilivideo.com', 'upos')
    return {h: ('upos' if h.startswith('upos-') else g) for h, g in found.items()}


# ---------- 签名 URL ----------
def get_signed_url():
    """访问视频页, 从 window.__playinfo__ 中取视频流 URL(直接调 API 会被风控 412)."""
    spi = json.loads(http_get('https://api.bilibili.com/x/frontend/finger/spi',
                              {'Referer': REFERER}))['data']
    cookie = f"buvid3={spi['b_3']}; buvid4={spi['b_4']}"
    for bv in SAMPLE_VIDEOS:
        try:
            html = http_get(f'https://www.bilibili.com/video/{bv}/',
                            {'Referer': REFERER, 'Cookie': cookie}).decode('utf-8')
            m = re.search(r'window\.__playinfo__\s*=\s*(\{.*?\})\s*</script>', html, re.S)
            dash = json.loads(m.group(1))['data']['dash']
            # akamaized.net 的签名与 bilivideo 节点不通用, 只取 bilivideo 的地址
            for s in dash['video'] + dash['audio']:
                for url in [s['baseUrl']] + (s.get('backupUrl') or []):
                    if re.match(r'https://[^/]+\.bilivideo\.com/upgcxcode/', url):
                        return url
        except Exception as e:
            log(f'{bv} 取签名 URL 失败: {e}')
    raise RuntimeError('所有样本视频都取不到签名 URL')


# ---------- 检测 ----------
def check(host, path_query):
    """返回 (status, MB/s). status: ok / nodns / httpNNN / error:Xxx"""
    try:
        socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except OSError:
        return 'nodns', None
    req = urllib.request.Request(f'https://{host}/{path_query}', headers={
        'User-Agent': UA, 'Referer': REFERER, 'Range': f'bytes=0-{PROBE_BYTES - 1}'})
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            n = len(r.read())
            if r.status != 206 or n == 0:
                return f'http{r.status}', None
            return 'ok', n / (time.monotonic() - t0) / 1048576
    except urllib.error.HTTPError as e:
        return f'http{e.code}', None
    except Exception as e:
        return 'error:' + type(e).__name__, None


def write_nodes(path, updated, nodes):
    """一行一个节点, git diff 友好."""
    body = ',\n'.join('  ' + json.dumps(n, ensure_ascii=False) for n in nodes)
    path.write_text(f'{{\n "updated": "{updated}",\n "nodes": [\n{body}\n ]\n}}\n', encoding='utf-8')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--no-write', action='store_true', help='只检测和打印, 不写文件')
    ap.add_argument('--workers', type=int, default=16, help='并发数(默认 16)')
    args = ap.parse_args()

    backup = {n['host']: n for n in load_json(BACKUP_FILE, {'nodes': []})['nodes']}
    groups = {h: n['group'] for h, n in backup.items()}
    new = {h: g for h, g in discover().items() if h not in groups}
    groups.update(new)
    log(f'候选共 {len(groups)} 个(backup {len(backup)}, 新发现 {len(new)})')

    url = get_signed_url()
    path_query = url.split('/', 3)[3]
    log(f'签名 URL 来自 {url.split("/")[2]}, 开始检测...')

    hosts = sorted(groups)
    with cf.ThreadPoolExecutor(args.workers) as ex:
        results = dict(zip(hosts, ex.map(lambda h: check(h, path_query), hosts)))

    now = datetime.now(timezone.utc).isoformat(timespec='seconds')
    ok = sorted((h for h, (s, _) in results.items() if s == 'ok'), key=lambda h: -results[h][1])

    print(f'\n可用 {len(ok)} / {len(hosts)}(并发 {args.workers}, 每个 {PROBE_BYTES // 1024} KB, 速度仅供参考)')
    print(f'{"HOST":45} {"GROUP":6} MB/s')
    for h in ok:
        print(f'{h:45} {groups[h]:6} {results[h][1]:.2f}')
    stats = Counter(s for s, _ in results.values())
    print('\n状态统计:', ', '.join(f'{k}={v}' for k, v in stats.most_common()))
    old_list = {n['host'] for n in load_json(LIST_FILE, {'nodes': []})['nodes']}
    print(f'主列表: +{len(set(ok) - old_list)} -{len(old_list - set(ok))}')

    if args.no_write:
        return
    order = lambda h: (groups[h] != 'upos', groups[h], h)
    write_nodes(LIST_FILE, now, [{'host': h, 'group': groups[h]} for h in sorted(ok, key=order)])
    write_nodes(BACKUP_FILE, now, [{
        'host': h, 'group': groups[h], 'last_status': results[h][0],
        'last_ok': now if results[h][0] == 'ok' else backup.get(h, {}).get('last_ok'),
    } for h in sorted(hosts, key=order)])
    log(f'已写入 {LIST_FILE.name}({len(ok)})和 {BACKUP_FILE.name}({len(hosts)})')


if __name__ == '__main__':
    main()
