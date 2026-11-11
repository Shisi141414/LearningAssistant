import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataRoot, invoke } from './test-support.mjs'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { configSet } from '../src/main/services/config.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { cleanOfficeAttempt, officeProcess, OFFICE_PROFILE } from '../src/main/services/office-converter.ts'
import { officeConverterStatus, convertedMaterialFile, ensureMaterialConversion, materialParseInput } from '../src/main/services/office-conversions.ts'
import { parseMaterial } from '../src/main/services/material-parser.ts'

registerAllIpc()
test('固定参数保留空格和命令字符，不进入 shell；失败、超量输出和超时拒绝',async()=>{
  const script=join(dataRoot,'process fixture.cjs')
  writeFileSync(script,"if(process.argv[2]==='hold'){setInterval(()=>{},1000)}else if(process.argv[2]==='bad'){process.exit(7)}else if(process.argv[2]==='flood'){console.log('x'.repeat(65000))}else console.log(JSON.stringify(process.argv.slice(2)))")
  const signal=new AbortController().signal, value='中文 空格 & $(never-run)'
  assert.deepEqual(JSON.parse(await officeProcess(process.execPath,[script,value],signal)),[value])
  await assert.rejects(officeProcess(process.execPath,[script,'bad'],signal),/退出（7）/)
  await assert.rejects(officeProcess(process.execPath,[script,'flood'],signal),/输出异常/)
  await assert.rejects(officeProcess(process.execPath,[script,'hold'],signal,150),/超时/)
  await assert.rejects(officeProcess(join(dataRoot,'missing.exe'),[],signal),/ENOENT/)
})
test('取消清理本次进程树，不能清理指定根以外的目录',async()=>{
  const script=join(dataRoot,'tree.cjs'), pidFile=join(dataRoot,'child-pid.txt')
  writeFileSync(script,"const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(process.argv[2],String(child.pid));setInterval(()=>{},1000)")
  const controller=new AbortController(), result=officeProcess(process.execPath,[script,pidFile],controller.signal)
  const end=Date.now()+5000
  while(!existsSync(pidFile)&&Date.now()<end)await new Promise(r=>setTimeout(r,10))
  assert.ok(existsSync(pidFile));const pid=Number(readFileSync(pidFile,'utf8'))
  controller.abort();await assert.rejects(result,/取消/)
  assert.throws(()=>process.kill(pid,0),/ESRCH/)
  await assert.rejects(cleanOfficeAttempt(dataRoot, dataRoot),/越界/)
  await assert.rejects(cleanOfficeAttempt(dataRoot, join(dataRoot,'..')),/越界/)
  assert.match(OFFICE_PROFILE,/DisableMacrosExecution/);assert.match(OFFICE_PROFILE,/BlockUntrustedRefererLinks/)
})
test('转换产物独立保留；缺工具时不丢原件；转换路径不可越过材料目录',async()=>{
  const db=getDb(), base=join(dataRoot,'materials','legacy-test')
  mkdirSync(base,{recursive:true});writeFileSync(join(base,'source.doc'),'private original')
  db.prepare("INSERT INTO materials(id,title,created_at) VALUES ('legacy-material','旧教材',0)").run()
  db.prepare("INSERT INTO material_versions(id,material_id,file_name,file_path,format,fingerprint,status,created_at) VALUES ('legacy-test','legacy-material','x.doc','materials/legacy-test/source.doc','doc','hash','ready',0)").run()
  configSet('materials.libreoffice',join(dataRoot,'missing','soffice.com'))
  assert.equal((await officeConverterStatus()).ready,false)
  await assert.rejects(ensureMaterialConversion('legacy-test',join(base,'source.doc'),'doc',new AbortController().signal))
  assert.equal(readFileSync(join(base,'source.doc'),'utf8'),'private original')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM material_conversions').get().n,0)
  writeFileSync(join(base,'converted.docx'),'saved immutable conversion')
  db.prepare("INSERT INTO material_conversions(version_id,format,file_path,fingerprint,engine,created_at) VALUES ('legacy-test','docx','materials/legacy-test/converted.docx','out-hash','LibreOffice mock',0)").run()
  await ensureMaterialConversion('legacy-test',join(base,'source.doc'),'doc',new AbortController().signal)
  assert.equal(materialParseInput('legacy-test',join(base,'source.doc'),'doc').format,'docx')
  assert.equal(readFileSync(convertedMaterialFile('legacy-test').file,'utf8'),'saved immutable conversion')
  await assert.rejects(parseMaterial(join(base,'converted.docx'),'docx',()=>{},true,'original-hash'),/转换文件发生变化/)
  db.prepare("UPDATE material_conversions SET file_path='../outside.docx' WHERE version_id='legacy-test'").run()
  assert.throws(()=>convertedMaterialFile('legacy-test'))
  assert.equal((await invoke('materials:converterStatus','unexpected')).ok,false)
  assert.equal((await invoke('config:set','materials.libreoffice','arbitrary executable')).ok,false)
})
after(()=>closeDb())
