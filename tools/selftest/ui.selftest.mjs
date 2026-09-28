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
    assistant.rx.setTimestamps(true, false);
    const t = $('s-rx').textContent;
    if (!/\[\d\d:\d\d:\d\d\.\d{3}\]/.test(t)) throw new Error('没看到时间戳');
    assistant.rx.setTimestamps(false, false);
    return 'OK';
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

  await step('RTT→CDC 转发面板：假探针走一遍完整流程', async () => {
    const hid = tools.hid;
    if (!hid) throw new Error('没有 hid 视图对象（main.js 没接？）');
    hid.useMock();                                   // 顶掉真设备，没插硬件也能验 UI 链路
    document.querySelector('#tabs .tab[data-tab=terminal]').click();
    await new Promise(r => setTimeout(r, 60));

    $('h-addr').value = '0x24000000';
    $('h-size').value = '0x80000';
    $('h-start').click();
    await until(() => tools.hid.summary().running, 100, '转发跑起来');
    const s = tools.hid.summary();
    if (s.cbAddr !== '0x24000000') throw new Error('控制块地址不对：' + s.cbAddr);
    if (!/运行中/.test(s.state)) throw new Error('状态行没写运行中：' + s.state);
    if ($('h-info').textContent.trim() === '') throw new Error('设备信息行是空的');

    $('h-stop').click();
    await until(() => !tools.hid.summary().running, 100, '转发停掉');
    if (!/未运行/.test(tools.hid.summary().state)) throw new Error('停止后状态行不对：' + tools.hid.summary().state);
    return s.state.slice(0, 70);
  });

  return out;
}
