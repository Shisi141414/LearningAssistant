import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { invoke } from './test-support.mjs'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { getDb, closeDb } from '../src/main/services/db.ts'
registerAllIpc()
after(closeDb)
const ok = (r) => {
  assert.equal(r.ok, true, r.error)
  return r.data
}

test('教材更名、移动与回收恢复保持稳定 ID、版本、块和课堂引用', async () => {
  const db = getDb(),
    subjects = db.prepare('SELECT id FROM subjects').all()
  db.prepare(
    "INSERT INTO materials(id,subject_id,title,kind,created_at) VALUES ('managed',?,'旧教材','textbook',1)"
  ).run(subjects[0].id)
  db.exec(
    "INSERT INTO material_versions(id,material_id,file_name,file_path,format,fingerprint,status,created_at) VALUES ('mv','managed','source.pdf','materials/source.pdf','pdf','original','ready',1); UPDATE materials SET current_version_id='mv' WHERE id='managed'; INSERT INTO material_blocks(id,version_id,ordinal,text,locator_json) VALUES ('mb','mv',0,'守恒律','{}'); INSERT INTO notes(id,title,created_at,updated_at) VALUES ('mn','笔记',1,1); INSERT INTO note_segments(id,note_id,raw_text,sort_order,created_at,updated_at) VALUES ('ms','mn','课堂原文',0,1,1); INSERT INTO segment_material_refs(segment_id,block_id) VALUES ('ms','mb')"
  )
  const changed = ok(
    await invoke('materials:update', {
      id: 'managed',
      title: ' 新教材 ',
      subject_id: subjects[1].id,
      kind: 'handout'
    })
  )
  assert.equal(changed.title, '新教材')
  assert.equal(changed.current_version_id, 'mv')
  assert.equal(changed.subject_id, subjects[1].id)
  assert.equal(
    ok(await invoke('materials:list', subjects[0].id)).some((m) => m.id === 'managed'),
    false
  )
  assert.equal(ok(await invoke('materials:anchor', 'mb')).material_title, '新教材')
  assert.equal(
    (
      await invoke('materials:update', {
        id: 'managed',
        title: 'bad',
        subject_id: 'missing',
        kind: 'handout'
      })
    ).ok,
    false
  )
  assert.equal(
    (
      await invoke('materials:update', {
        id: 'managed',
        title: ' ',
        subject_id: null,
        kind: 'handout'
      })
    ).ok,
    false
  )
  ok(await invoke('materials:archive', 'managed'))
  assert.equal(
    ok(await invoke('materials:list')).some((m) => m.id === 'managed'),
    false
  )
  assert.equal(
    ok(await invoke('materials:trash')).some((m) => m.id === 'managed'),
    true
  )
  assert.equal(ok(await invoke('notes:get', 'mn')).segments[0].material_ref.id, 'mb')
  assert.equal(
    (
      await invoke('materials:update', {
        id: 'managed',
        title: 'bad',
        subject_id: null,
        kind: 'handout'
      })
    ).ok,
    false
  )
  ok(await invoke('materials:restore', 'managed'))
  assert.equal(
    ok(await invoke('materials:list', subjects[1].id)).find((m) => m.id === 'managed').title,
    '新教材'
  )
  assert.equal(
    db.prepare('SELECT fingerprint FROM material_versions WHERE id=?').get('mv').fingerprint,
    'original'
  )
  closeDb()
  assert.equal(ok(await invoke('materials:get', 'managed')).material.current_version_id, 'mv')
  assert.equal(ok(await invoke('notes:get', 'mn')).segments[0].material_ref.id, 'mb')
})
