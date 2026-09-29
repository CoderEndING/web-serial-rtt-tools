/**
 * Web Serial 串口授权的两个动作（都只动**测试 profile**，不碰你自己的浏览器 profile）：
 *
 *   node tools/selftest/serial-grant.mjs            # 补：把"当前这个 CDC 口"的实例 ID 写进授权
 *   node tools/selftest/serial-grant.mjs --clean    # 清：删掉过期的探针授权（换过口/换过探针留下的）
 *   node tools/selftest/serial-grant.mjs --show     # 看：列出 profile 里现有的串口授权
 *
 * 为什么需要（2026-10 用户现场，两小时的坑）：
 *   · Web Serial 的端口授权**只能人工点一次** —— CDP 的 DeviceAccess 域不管它，
 *     `Browser.grantPermissions` 里也没有 'serial' 这个权限类型（实测 "Unknown permission type"）。
 *   · 但授权记录就躺在 profile 的 `profile.content_settings.exceptions.serial_chooser_data` 里，
 *     按「**来源 + 设备实例 ID**」记 —— 来源是页面地址（线上是 `https://minichao9901.github.io:443,*`），
 *     实例 ID 跟"插在哪个 USB 口"绑定（`...\8&305E904C&3&0001` 里那个 `&3&` 会变）。
 *   · 所以：从用户自己的 Chrome profile 搬一份 Preferences 出来，再把**当前口**的实例 ID 补进去，
 *     测试 profile 就认这个口了。插到别的 USB 口上了就再跑一次本脚本。
 *
 * ⚠️ 浏览器必须先停（Preferences 是它写的，运行中改会被覆盖）：
 *     本脚本会自己把用 `%TEMP%\chrome-rtt-authorized` 的那个 Chrome 杀掉，改完不自动起 ——
 *     交给 tools/selftest/hw-campaign.mjs（或 launch-browser.ps1）起。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MODE = process.argv.includes('--clean') ? 'clean' : process.argv.includes('--show') ? 'show' : 'patch';
const PROFILE = path.join(process.env.TEMP, 'chrome-rtt-authorized');
const PREF = path.join(PROFILE, 'Default', 'Preferences');
const SRC = path.join(process.env.LOCALAPPDATA, 'Google/Chrome/User Data');
const ORIGIN = 'https://minichao9901.github.io:443';
const KEY = ORIGIN + ',*';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 取当前 CDC 口（MI_01）的实例 ID；顺带写进 tmp/cdc-instance.txt 备查 */
function currentInstance(){
  const out = path.join('tmp', 'cdc-instance.txt');
  spawn('pwsh', ['-NoProfile', '-Command',
    `(Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_0D28&PID_0204&MI_01' }).InstanceId | Set-Content -Encoding UTF8 ${out}`],
    { stdio: 'ignore' });
  for (let i = 0; i < 20; i++){                       // 等它写完（spawn 抓不到 stdout，就落文件再读）
    try { const v = fs.readFileSync(out, 'utf8').trim(); if (v) return v; } catch {}
    // 同步等一下（这里是启动期的几十毫秒，用忙等最省事、也不引依赖）
    const t0 = Date.now(); while (Date.now() - t0 < 200) { /* spin */ }
  }
  return '';
}

if (MODE !== 'show'){
  // 1) 停掉测试浏览器（Preferences 归它写）
  spawn('pwsh', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'chrome-rtt-authorized' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
    { stdio: 'ignore' });
  await sleep(2000);
}

// 2) 没有 profile 副本就从用户 Chrome 拷一份
if (!fs.existsSync(PREF)){
  if (MODE === 'show'){ console.log('还没有授权 profile 副本（' + PROFILE + '）'); process.exit(0); }
  console.log('复制授权 profile ← 用户 Chrome 的 Preferences');
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
  for (const f of ['Local State', 'Default/Preferences', 'Default/Secure Preferences']){
    try { fs.copyFileSync(path.join(SRC, f), path.join(PROFILE, f)); } catch {}
  }
}

const pref = JSON.parse(fs.readFileSync(PREF, 'utf8'));
pref.profile = pref.profile || {};
pref.profile.content_settings = pref.profile.content_settings || {};
pref.profile.content_settings.exceptions = pref.profile.content_settings.exceptions || {};
const exc = pref.profile.content_settings.exceptions;
exc.serial_chooser_data = exc.serial_chooser_data || {};
const cur = exc.serial_chooser_data[KEY] || { last_modified: String((Date.now() + 11644473600000) * 1000), setting: { 'chosen-objects': [] } };
const objs = cur.setting['chosen-objects'] || [];

if (MODE === 'show'){
  console.log(`profile: ${PREF}`);
  for (const [k, v] of Object.entries(exc.serial_chooser_data)){
    console.log(`来源 ${k}:`);
    for (const o of (v?.setting?.['chosen-objects'] || [])) console.log('   ' + o.device_instance_id + '  (' + o.name + ')');
  }
  process.exit(0);
}

if (MODE === 'clean'){
  const inst = currentInstance();
  const isProbe = o => /VID_0D28/i.test(o.device_instance_id || '');
  const keep = objs.filter(o => !isProbe(o) || o.device_instance_id === inst);
  const dropped = objs.filter(o => !keep.includes(o));
  console.log(`删掉 ${dropped.length} 条过期探针授权：`);
  for (const o of dropped) console.log('   ✗ ' + o.device_instance_id + '  (' + o.name + ')');
  cur.setting['chosen-objects'] = keep;
  console.log('保留：');
  for (const o of keep) console.log('   ✓ ' + o.device_instance_id + '  (' + o.name + ')');
} else {
  const inst = currentInstance();
  if (!inst){ console.error('❌ 没读到 CDC 口的实例 ID（探针插着吗？MI_01 就是它的 CDC 口）'); process.exit(1); }
  if (objs.some(o => o.device_instance_id === inst)){
    console.log('当前口已在授权里：' + inst);
  } else {
    objs.push({ name: 'akaLinkPro CMSIS-DAP', device_instance_id: inst });
    console.log('补上当前口：' + inst);
  }
  cur.setting['chosen-objects'] = objs;
}

exc.serial_chooser_data[KEY] = cur;
fs.writeFileSync(PREF, JSON.stringify(pref));
console.log('已写回 ' + PREF);
console.log('（这个 profile 的浏览器下次启动时生效；hw-campaign 会自己起它）');
