/** SVD parser/decoder selftest (无需浏览器或探针). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSvdXml, decodeSvdRegister, svdSummary } from '../../app/dbg/svd.js';

const xml = readFileSync(new URL('../../app/dbg/svd/STM32F103xx.svd', import.meta.url), 'utf8');
const model = parseSvdXml(xml);
assert.equal(model.name, 'STM32F103xx');
assert.ok(model.peripherals.length >= 50);
const gpio = model.peripherals.find(p => p.name === 'GPIOA');
assert.ok(gpio && gpio.baseAddress === 0x40010800);
const crl = gpio.registers.find(r => r.name === 'CRL');
assert.ok(crl && crl.addressOffset === 0 && crl.fields.some(f => f.name === 'MODE0' && f.width === 2));
const decoded = decodeSvdRegister(crl, 0x0000000b);
assert.equal(decoded.valueHex, '0x0000000B');
assert.equal(decoded.fields.find(f => f.name === 'MODE0').value, 3);
assert.equal(decoded.fields.find(f => f.name === 'CNF0').value, 2);
assert.match(svdSummary(model), /53 个外设/);
assert.throws(() => parseSvdXml('<device><name>x</name></device>'), /没有可用/);
console.log('dbg-svd: official STM32F103xx.svd parsing, register address, field decode and malformed input PASS');
