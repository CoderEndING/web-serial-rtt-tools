import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {FRAME_CASES,frameSourceHash,sha256,validateOracle,validateBuild,webVariables,compareFrames} from './dbg-frame-contract.mjs';
const bytes=Buffer.from('elf sample'),build={schema:1,board:'f103cb',optimization:'Og',dwarf:4,elfSha256:sha256(bytes),flags:['-Og','-g3'],sources:{'dbg_frames.c':frameSourceHash()}};
const scalar=(name,value,{occurrence=0,argument=false,address}={})=>({name,occurrence,argument,status:'ok',fields:[{path:'',value:String(value)}],...(address==null?{}:{address})});
const frame=(name,variables,i=0)=>({name,pc:0x08001000+i*8,sp:0x20001000+i*64,variables});
function golden(){
 const cases={};
 for(const c of FRAME_CASES)cases[c.id]={pc:0x08001000,frames:[frame('engine_frame_'+c.id.replace('-','_'),[])]};
 cases.recursive.frames=Array.from({length:5},(_,i)=>frame('engine_frame_recursive',[scalar('depth_copy',i),scalar('seed_copy',1028-i*7),scalar('frame_value',1028-i*7+i*100)],i));
 cases.leaf.frames[0].variables=[scalar('leaf_value',1128),{...scalar('items',0),fields:[{path:'[0]',value:'1028'},{path:'[1]',value:'1029'},{path:'[2]',value:'1030'}]},
  {...scalar('record',0),fields:[{path:'tag',value:String(0x12345678)},{path:'signed_value',value:'-17'},{path:'pair[0]',value:'21'},{path:'pair[1]',value:'34'}]}];
 cases.shadow.frames[0].variables=[scalar('shadow',60),scalar('outer_copy',60),scalar('shadow',70,{occurrence:1}),scalar('inner_copy',70)];
 cases['shadow-exit'].frames[0].variables=[scalar('shadow',60),scalar('outer_copy',130)];
 cases.register.frames[0].variables=[scalar('arg',23,{argument:true}),scalar('register_value',70)];
 for(const id of ['before-call','after-call'])cases[id].frames[0].variables=[scalar('arg',70,{argument:true,...(id==='after-call'?{address:0x20001010}:{})}),scalar('stack_value',79)];
 cases['after-call'].frames[0].variables.push(scalar('result',346));
 return {schema:1,board:'f103cb',elfSha256:sha256(bytes),build:structuredClone(build),tool:'gdb test',codeVerified:true,cases};
}
validateBuild(build,bytes,'f103cb');validateOracle(golden(),build,bytes,'f103cb');
for(const modify of [o=>{o.elfSha256='stale';},o=>{o.board='h743';},o=>{o.build.optimization='Os';},o=>{o.build.sources['dbg_frames.c']='stale';},o=>{o.codeVerified=false;},o=>{delete o.cases.leaf;},o=>{o.cases.recursive.frames.pop();},o=>{o.cases.leaf.frames[0].variables[0].status='unavailable';},o=>{o.cases.shadow.frames[0].variables[2].fields[0].value='60';},o=>{o.cases['before-call'].frames[0].variables[0].address=123;}]){
 const o=golden();modify(o);assert.throws(()=>validateOracle(o,build,bytes,'f103cb'));
}
const web=webVariables([{name:'arg',argument:true,value:'70'},{name:'object',address:0x20001010,children:[
 {depth:0,name:'tag',text:'305419896',cls:''},{depth:0,name:'pair',text:'[2]',cls:'dim'},
 {depth:1,name:'[0]',text:'21',cls:''},{depth:1,name:'[1]',text:'34',cls:''},
 {depth:0,name:'signed_value',text:'-17',cls:''}]},{name:'shadow',value:'60'},{name:'shadow',value:'70'},{name:'optimized',error:'已优化掉'}]);
assert.equal(web[1].fields[1].path,'pair[0]');assert.equal(web[1].fields[3].path,'signed_value');assert.equal(web[3].occurrence,1);assert.equal(web[4].status,'unavailable');
assert.throws(()=>webVariables([{name:'bad',children:[{depth:0,name:'…',text:'还有20项',cls:'dim'}]}]),/未完整/);
const expected=[frame('engine_frame_leaf',web)],actual=structuredClone(expected);assert.deepEqual(compareFrames(actual,expected),[]);
actual[0].variables[1].fields[0].value='0';assert.match(compareFrames(actual,expected).join(','),/object/);
for(const mutate of [a=>a.pop(),a=>a[0].sp++,a=>a[0].pc++,a=>a[0].variables.pop(),a=>a[0].variables[0].status='unavailable',a=>a[0].variables[1].address++]){const a=structuredClone(expected);mutate(a);assert.ok(compareFrames(a,expected).length);}
// Compile and run the shared C target with native GCC in both optimization modes.
// This checks deterministic source behavior, not Cortex-M code generation or board behavior.
if(process.argv.includes('--native')){
const temp=mkdtempSync(join(tmpdir(),'akalink-frame-target-test-'));
try{
 const harness=join(temp,'main.c');writeFileSync(harness,'#include <stdint.h>\nuint32_t engine_frame_stage(void);\nint main(void){for(int i=0;i<10000;i++)if(engine_frame_stage()!=EXPECTED)return 1;return 0;}\n'.replace('EXPECTED',String(((19450^240^81^495)>>>0)+0x13579bd)+'u'));
 for(const optimization of ['Og','Os']){
  const executable=join(temp,optimization),result=spawnSync('gcc',['-'+optimization,'-g','-Wall','-Wextra','-Werror',resolve('tools/target-firmware/common/dbg_frames.c'),harness,'-o',executable],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||String(result.error));assert.equal(spawnSync(executable).status,0);
 }
}finally{rmSync(temp,{recursive:true,force:true});}
}
// Release entry must fail before contacting CDP when oracle is missing.
const missing=spawnSync(process.execPath,['tools/selftest/dbg-hw-stress.mjs','--board=f103cb','--frames-only'],{encoding:'utf8'});
assert.notEqual(missing.status,0);assert.match(missing.stderr,/必须指定 --frame-oracle/);
console.log('dbg-frame-contract: fixed-input GDB contract, ELF/build binding, scopes/shadowing, aggregate comparison, no silent coverage loss PASS');
