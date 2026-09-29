"""读一段 COM 口，把收到的字节数与速率写进 JSON（给 RTT 转发测速用）。

    python tmp/com-read.py <COM口> <秒数> <输出json>

为什么单独一个进程：RTT 转发是**探针侧**在搬数据、往 CDC 灌；主机不把 COM 口的数据读走，
探针那条路会背压停下来 —— 那样测出来的"速率"是假的。所以测转发时必须真有一个读者。
独立进程 + 结果写文件（不走 stdout 管道），避免和 CDP 脚本抢管道。
"""
import json
import sys
import time

import serial

port = sys.argv[1] if len(sys.argv) > 1 else 'COM5'
secs = float(sys.argv[2]) if len(sys.argv) > 2 else 8.0
out = sys.argv[3] if len(sys.argv) > 3 else 'tmp/com-read.json'

res = {'port': port, 'wantSeconds': secs, 'bytes': 0, 'seconds': 0, 'rate': 0, 'head': '', 'error': ''}
try:
    s = serial.Serial(port, 115200, timeout=0.1)
    t0 = time.time()
    n = 0
    head = b''
    while time.time() - t0 < secs:
        chunk = s.read(8192)
        if chunk:
            n += len(chunk)
            if len(head) < 240:
                head += chunk
    dt = time.time() - t0
    s.close()
    res.update(bytes=n, seconds=round(dt, 3), rate=round(n / dt, 1) if dt else 0,
               head=head.decode('utf-8', 'replace')[:200])
except Exception as e:                                    # noqa: BLE001 —— 报障信息要给全
    res['error'] = f'{type(e).__name__}: {e}'

with open(out, 'w', encoding='utf-8') as f:
    json.dump(res, f, ensure_ascii=False)
print(json.dumps(res, ensure_ascii=False))
