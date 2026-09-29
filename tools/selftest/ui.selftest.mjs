/**
 * 浏览器端端到端自检（无头也能跑）：
 *   http://127.0.0.1:8899/index.html?demo=serial&selftest=1
 * 结果写进页面里的 #selftest 节点（JSON），可以用 Edge/Chrome 的 --dump-dom 抓出来。
 *
 * 它跑的是**真的界面对象**（Assistant / TerminalView），只是串口换成了内置演示设备。
 */

const $ = id => document.getElementById(id);

async function until(cond, tries = 300, what = '条件', gap = 20){
  for (let i = 0; i < tries; i++){
    let v = false;
    try { v = cond(); } catch {}
    if (v) return true;
    await new Promise(r => setTimeout(r, gap));
  }
  throw new Error(`等待超时：${what}`);
}

export async function runUiSelfTest(tools){
  const out = [];
  const step = async (name, fn) => {
    try {
      const note = await fn();
      out.push({ name, ok: true, note: note === undefined ? '' : String(note) });
    } catch (e){
      out.push({ name, ok: false, error: String(e?.message || e) });
    }
  };
  const { assistant, terminal, session } = tools;

  await step('演示串口出现在端口列表', async () => {
    if (!assistant.demo) throw new Error('没开演示模式（URL 要带 ?demo=serial）');
    if (!assistant.ports.length) throw new Error('端口列表是空的');
    return assistant.ports.length + ' 个';
  });

  await step('连接演示串口', async () => {
    await assistant.connect();
    await until(() => session.isOpen, 200, '串口打开');
    return '已连接';
  });

  await step('收到设备问候（RX 有数据）', async () => {
    await until(() => assistant.rx.bytes > 0, 200, 'RX 数据');
    return assistant.rx.bytes + ' B';
  });

  await step('发送 ASCII + 行尾（AT → OK）', async () => {
    const before = assistant.txc.total;
    await assistant.send('AT');
    await until(() => assistant.rx.text().includes('OK'), 200, 'OK 回复');
    const sent = assistant.txc.total - before;
    if (sent !== 4) throw new Error(`TX 记账应为 4 字节（AT + CRLF），实际 ${sent}`);
    return `TX ${sent} B`;
  });

  await step('快捷发送槽位(Alt+1)内容生效', async () => {
    assistant.quick[0].body.value = 'AT+GMR';
    await assistant.send(assistant.quick[0].body.value);
    await until(() => assistant.rx.text().includes('演示设备 v1.0'), 200, 'AT+GMR 回复');
    return 'OK';
  });

  await step('HEX 发送解析：非法字符要报错', async () => {
    assistant.txSeg.set('hex');
    const okBefore = assistant.txc.total;
    await assistant.send('01 0G');
    await new Promise(r => setTimeout(r, 60));
    const err = $('s-err').textContent;
    if (!err.includes('非法字符')) throw new Error('没报错：' + err);
    if (assistant.txc.total !== okBefore) throw new Error('非法 HEX 不该真的发出去');
    return err;
  });

  await step('HEX 发送解析：正常组包', async () => {
    const before = assistant.txc.total;
    await assistant.send('01 03 00 0A');
    await until(() => assistant.txc.total - before === 6, 100, 'TX 记账 6 字节（4 + CRLF）');
    return 'TX 6 B';
  });

  await step('切换 HEX 显示模式', async () => {
    assistant.rx.setMode('hex');
    const t = $('s-rx').textContent;
    if (!/[0-9A-F]{2} [0-9A-F]{2}/.test(t)) throw new Error('HEX 视图没有成对十六进制');
    assistant.rx.setMode('ascii');
    return 'OK';
  });

  await step('时间戳开关', async () => {
    // 默认（未勾「绝对时间」）= 自页面打开起的**相对**时间；勾上 = 当天钟点。
    // 🚨 以前两个分支一模一样（等于那个复选框是摆设，代码审查 item 10）—— 这里两个都验。
    assistant.rx.setTimestamps(true, false);
    const rel = $('s-rx').textContent;
    if (!/\[\+\d\d:\d\d\.\d{3}\]/.test(rel)) throw new Error('没看到相对时间戳：' + rel.slice(-60));
    assistant.rx.setTimestamps(true, true);
    const abs = $('s-rx').textContent;
    if (!/\[\d\d:\d\d:\d\d\.\d{3}\]/.test(abs)) throw new Error('没看到绝对时间戳：' + abs.slice(-60));
    assistant.rx.setTimestamps(false, false);
    return '相对 + 绝对都对';
  });

  await step('暂停/继续不丢数据', async () => {
    assistant.rx.setPaused(true);
    const n0 = assistant.rx.bytes;
    await assistant.send('help');
    await until(() => assistant.rx.bytes > n0, 200, '暂停期间继续收');
    const shown = $('s-rx').textContent.length;
    assistant.rx.setPaused(false);
    if ($('s-rx').textContent.length <= shown) throw new Error('继续后没有重绘');
    return 'OK';
  });

  await step('定时发送（100ms × 3 次）', async () => {
    assistant.txSeg.set('ascii');           // 定时发送用的是发送框里的内容（和 SSCOM 一样）
    $('s-tx').value = 'AT';
    $('s-timer-ms').value = '100';
    $('s-timer').checked = true;
    assistant._armTimer();
    const before = assistant.txc.frames;
    await until(() => assistant.txc.frames - before >= 3, 300, '定时发送 3 帧');
    $('s-timer').checked = false;
    assistant._armTimer();
    $('s-tx').value = '';
    return 'OK';
  });

  await step('保存数据内容非空', async () => {
    const t = assistant.rx.text();
    if (t.length < 50) throw new Error('导出的文本太短：' + t.length);
    return t.length + ' 字符';
  });

  await step('终端：敲命令并收到回显', async () => {
    document.querySelector('#tabs .tab[data-tab=terminal]').click();
    await new Promise(r => setTimeout(r, 30));
    if (!terminal.term) throw new Error('xterm 没初始化');
    terminal._input('A'); terminal._input('T'); terminal._input('\r');
    await until(() => {
      const b = terminal.term.buffer.active;
      let s = '';
      for (let i = 0; i < b.length; i++) s += b.getLine(i)?.translateToString(true) || '';
      return s.includes('OK');
    }, 200, '终端里出现 OK');
    return 'OK';
  });

  await step('终端：本地回显开关生效', async () => {
    const sel = $('t-echo');
    sel.value = 'on'; sel.dispatchEvent(new Event('change'));
    terminal._input('Z');
    await until(() => {
      const b = terminal.term.buffer.active;
      let s = '';
      for (let i = 0; i < b.length; i++) s += b.getLine(i)?.translateToString(true) || '';
      return s.includes('Z');
    }, 100, '本地回显 Z');
    sel.value = 'off'; sel.dispatchEvent(new Event('change'));
    return 'OK';
  });

  await step('断开串口', async () => {
    await session.close();
    await until(() => !session.isOpen, 200, '串口关闭');
    return 'OK';
  });

  await step('SWD 速度下拉（默认 + 1M~60M 九档）就位', async () => {
    const want = ['1000', '5000', '10000', '20000', '30000', '40000', '45000', '50000', '60000'];
    const label = v => v >= 1000 ? (v / 1000) + ' MHz' : v + ' kHz';
    const opts = id => [...(document.getElementById(id)?.options || [])];
    // 四个字段都必须是原生下拉（不是 datalist —— value/label 会被 Edge 画成两行）。
    // 结构：r-usb-clock / r-ocd-speed / f-speed = 「默认」+ 九档；
    //       r-jlink-speed 特殊 —— J-Link 的默认就是一个具体值（50MHz），所以它只有九档。
    const withDefault = ['r-usb-clock', 'r-ocd-speed', 'f-speed'];
    for (const id of [...withDefault, 'r-jlink-speed']){
      const el = $(id);
      if (!el) throw new Error('找不到 ' + id);
      if (el.tagName !== 'SELECT') throw new Error(`${id} 应该是原生下拉，实际 ${el.tagName}`);
      if (el.getAttribute('list')) throw new Error(`${id} 还挂着 datalist`);
      const all = opts(id);
      const nine = (withDefault.includes(id) ? all.slice(1, 10) : all).map(o => o.value);
      if (want.join(',') !== nine.join(',')) throw new Error(`${id} 九档 = ${nine.join(',')}`);
      if (withDefault.includes(id)){
        const d = all[0];
        if (d.value !== '' && d.value !== '0') throw new Error(`${id} 第一条不是默认项：${d.outerHTML}`);
      }
      const bad = all.filter(o => !/^(0)?$/.test(o.value) && o.textContent.trim() !== label(+o.value));
      if (bad.length) throw new Error(`${id} 选项文案不对：${bad.map(o => o.textContent).join(' / ')}`);
      if (all.length > nine.length + 1 && !/^\d+$/.test(all[nine.length + 1].value)) throw new Error(`${id} 末尾的补丁项不对`);
    }
    // J-Link 那格必须永远有个具体速度（它没有"不设"这个语义）；其余三格可以是 不设/自动
    if ($('r-jlink-speed').value === '') throw new Error('J-Link 速度不该为空');
    return '4 个字段 = 原生下拉（3 个带默认项 + 九档）';
  });

  await step('RTT 转发页：接收链路 + 假探针面板', async () => {
    const hid = tools.hid;
    const stream = tools.stream;
    if (!hid || !stream) throw new Error('没有 hid / stream 视图对象（main.js 没接？）');
    document.querySelector('#tabs .tab[data-tab=rttcdc]').click();
    await new Promise(r => setTimeout(r, 60));
    if (!$('c-rx')) throw new Error('这一页没有接收区 #c-rx');

    // ① 接收链路：本页与串口助手共用同一个会话 —— 助手收数据，这一页也要收到并渲染
    await assistant.connect();
    await until(() => session.isOpen, 200, '串口打开');
    const before = tools.stream.summary().bytes;
    await assistant.send('help');
    await until(() => tools.stream.summary().bytes > before, 200, '这一页收到数据');
    const got = tools.stream.summary().bytes - before;
    if (!$('c-rx').textContent.trim()) throw new Error('接收区是空的（没渲染）');
    if (tools.stream.summary().buffered <= 0) throw new Error('接收缓冲是空的');

    // ② 纯输出：这页不该有任何发送控件
    for (const id of ['c-tx', 'c-send', 'c-quick', 'c-timer']) if ($(id)) throw new Error('不该出现发送相关控件：' + id);

    // ③ 假探针：启停（面板搬到了这一页）
    hid.useMock();
    $('h-addr').value = '0x24000000';
    $('h-start').click();
    await until(() => tools.hid.summary().running, 100, '转发跑起来');
    if (tools.hid.summary().cbAddr !== '0x24000000') throw new Error('控制块地址不对：' + tools.hid.summary().cbAddr);

    // ④ "桥在跑但搬不到数据"要被认出来（真机上踩过：另一路把 RTT 缓冲读走了）
    tools.hid.mock.stall = true;
    for (let i = 0; i < 4; i++){ await tools.hid.refresh(); }
    if (tools.hid.summary().stall < 2) throw new Error('没累计到停滞计数');
    if (!/不涨|抢/.test($('h-state').textContent)) throw new Error('状态行没提示：' + $('h-state').textContent);
    tools.hid.mock.stall = false;

    // ⑤ 目标类型切换（HID 0x31 action 10）：切到 RISC-V/JTAG 后 SWD 时钟档要置灰
    //    （RTT-over-JTAG 就是靠这个全局开关；J-Scope 采样器的后端也跟着它走）
    $('h-target').value = 'riscv';
    await tools.hid.applyTargetType();
    if (!tools.hid.mock.riscv) throw new Error('没把目标类型发下去（mock.riscv 还是 false）');
    if (!$('h-clock').disabled) throw new Error('RISC-V 下 SWD 时钟档应该置灰');
    $('h-target').value = 'swd';
    await tools.hid.applyTargetType();
    if (tools.hid.mock.riscv) throw new Error('切回 SWD 没生效');
    if ($('h-clock').disabled) throw new Error('切回 SWD 后时钟档该恢复可用');

    $('h-stop').click();
    await until(() => !tools.hid.summary().running, 100, '转发停掉');

    await session.close();
    return `收到 ${got} B · 本页共 ${tools.stream.summary().bytes} B`;
  });

  await step('烧录器页：HPM（RISC-V）零安装选项就位', async () => {
    document.querySelector('#tabs .tab[data-tab=flash]').click();
    await new Promise(r => setTimeout(r, 60));
    const sel = $('f-chip');
    if (!sel) throw new Error('没有芯片下拉 #f-chip');
    const hpm = [...sel.options].filter(o => o.value.startsWith('hpm'));
    if (hpm.length < 8) throw new Error(`芯片下拉里只有 ${hpm.length} 个 HPM 项（应为 10）`);
    sel.value = 'hpm6800evk';
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 60));
    const f = tools.flash;
    if (!f) throw new Error('没有 flash 视图对象');
    if (typeof f._flashHpmRiscv !== 'function') throw new Error('烧录页没有 RISC-V 那条链路（_flashHpmRiscv）');
    const chips = await import('/app/flash/hpm/chips.js');
    const b = chips.hpmBoard('hpm6800evk');
    if (!b || b.flashBase !== 0x80000000 || b.xpiBase !== 0xF3000000) throw new Error('HPM6800EVK 的板级参数不对');
    return `HPM 选项 ${hpm.length} 个 · ${b.name}`;
  });

  return out;
}
