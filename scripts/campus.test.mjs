import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import './test-support.mjs'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import {
  campusAccount,
  campusReadUrl,
  officialCampusUrl,
  normalizeCampusSource
} from '../src/main/services/campus-policy.ts'
import {
  storeCampusCourses,
  campusCourses,
  mapCampusCourse,
  buildCampusTicket,
  applyCampusTicket,
  campusProvenance
} from '../src/main/services/campus-store.ts'
import {
  listAssignments,
  getAssignment,
  saveAssignment,
  archiveAssignment
} from '../src/main/services/assignments.ts'
import { updateTask } from '../src/main/services/projects.ts'
import { validateIpc } from '../src/main/services/security.ts'

after(closeDb)
const raw = (patch = {}) => ({
  id: 'student-homework',
  baseId: 'base-problem',
  title: '动力学作业',
  deadline: '2026-11-20T23:59:00+08:00',
  submitted: false,
  grade: 98,
  gradeContent: 'private',
  ...patch
})
const source = (patch = {}, account = 'account-one', course = 'course-one') =>
  normalizeCampusSource(account, '2026-2027-1', course, '理论力学', raw(patch))
const course = (account = 'account-one', id = 'course-one') =>
  storeCampusCourses(account, '测试同学', '2026-2027-1', [
    { id, title: '理论力学' }
  ])
const preview = (sources = [source()]) => buildCampusTicket(sources, [])
const apply = (t, adopt = []) =>
  applyCampusTicket(t, {
    token: t.preview.token,
    keys: t.preview.items.map((i) => i.key),
    adopt
  })
const assignments = () =>
  listAssignments({ scope: 'all', query: '', offset: 0 }).items
const edit = (a, patch) =>
  saveAssignment({
    id: a.id,
    expected_revision: a.revision,
    subject_id: a.subject_id,
    title: a.task.title,
    detail: a.task.detail,
    due_at: a.task.due_at,
    status: a.task.status,
    blocked_reason: a.task.blocked_reason,
    ...patch
  })

test('campus policy restricts read endpoints, navigation, canonical identity and private fields', () => {
  assert.equal(officialCampusUrl('https://id.tsinghua.edu.cn/login'), true)
  for (const u of [
    'http://id.tsinghua.edu.cn',
    'https://id.tsinghua.edu.cn.evil.com',
    'https://user@id.tsinghua.edu.cn',
    'javascript:alert(1)'
  ])
    assert.equal(officialCampusUrl(u), false)
  assert.equal(
    campusReadUrl(
      'https://learn.tsinghua.edu.cn/b/wlxt/kczy/zy/student/zyListWj',
      'POST'
    ),
    true
  )
  assert.equal(
    campusReadUrl(
      'https://learn.tsinghua.edu.cn/b/wlxt/kczy/zy/student/submit',
      'POST'
    ),
    false
  )
  assert.equal(
    campusReadUrl(
      'https://learn.tsinghua.edu.cn/f/wlxt/common/language',
      'GET'
    ),
    false
  )
  const one = campusAccount(Buffer.from('i_user=student-1&i_pass=secret'))
  assert.match(one, /^[a-f0-9]{64}$/)
  assert.equal(
    one,
    campusAccount(
      Buffer.from(
        '--boundary\r\nContent-Disposition: form-data; name="i_user"\r\n\r\nstudent-1\r\n--boundary--\r\n'
      )
    )
  )
  assert.notEqual(one, campusAccount(Buffer.from('i_user=student-2')))
  for (const b of [
    'i_pass=secret',
    'i_user=a&i_user=b',
    'i_user=',
    'i_user=%00'
  ])
    assert.equal(campusAccount(Buffer.from(b)), null)
  assert.equal(campusAccount(Buffer.alloc(65537)), null)
  const s = source({ url: 'javascript:secret' })
  assert.equal('grade' in s, false)
  assert.equal('gradeContent' in s, false)
  assert.match(s.url, /^https:\/\/learn.tsinghua.edu.cn\/f\//)
  for (const deadline of [
    '2026-02-30T00:00:00+08:00',
    '2026-11-20',
    'bad',
    '2026-11-20T24:00:00+08:00'
  ])
    assert.throws(() => source({ deadline }))
})

test('campus upgrade rollback and retry preserves existing assignment/task data', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  for (const m of MIGRATIONS.filter((m) => m.version < 34)) db.exec(m.sql)
  db.prepare(
    "INSERT INTO assignments(id,title,source,status) VALUES('legacy','旧作业','manual','open')"
  ).run()
  db.transaction(() => db.exec(MIGRATIONS.find((m) => m.version === 34).sql))()
  const originalTasks = db.prepare('SELECT * FROM tasks').all()
  const before = db.prepare('SELECT * FROM assignments').all()
  const migration = MIGRATIONS.find((m) => m.version === 35)
  assert.throws(() =>
    db.transaction(() => {
      db.exec(migration.sql)
      throw Error('injected failure')
    })()
  )
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM pragma_table_info('assignment_links') WHERE name='mutation_origin'"
      )
      .get().n,
    0
  )
  db.transaction(() => db.exec(migration.sql))()
  assert.deepEqual(db.prepare('SELECT * FROM assignments').all(), before)
  assert.deepEqual(db.prepare('SELECT * FROM tasks').all(), originalTasks)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  db.close()
})

test('preview is read-only; import deduplicates student record scoped to account and course', () => {
  course()
  const count = assignments().length,
    t = preview()
  assert.equal(assignments().length, count)
  assert.equal(apply(t).created, 1)
  const a = assignments()[0]
  assert.equal(a.source, 'campus')
  assert.equal(a.task.status, 'open')
  const revision = a.revision
  assert.equal(apply(preview()).created, 0)
  assert.equal(getAssignment(a.id).revision, revision)
  assert.equal(campusProvenance(a.id).versions, 1)
  course('account-two')
  course('account-one', 'course-two')
  assert.equal(apply(preview([source({}, 'account-two')])).created, 1)
  assert.equal(
    apply(preview([source({}, 'account-one', 'course-two')])).created,
    1
  )
  assert.equal(assignments().length, count + 3)
})

test('manual and calendar edits protect fields; explicit adoption clears only selected ownership', () => {
  const a = assignments().find(
    (a) =>
      campusProvenance(a.id).current.account_id === 'account-one' &&
      campusProvenance(a.id).current.course_id === 'course-one'
  )
  const custom = edit(a, {
    title: '自己的名称',
    detail: '自己的学习要求',
    status: 'doing'
  })
  updateTask(custom.task.id, {
    due_at: Date.parse('2026-11-25T23:59:00+08:00')
  })
  const changed = source({
    title: '学校新名称',
    deadline: '2026-11-21T23:59:00+08:00',
    submitted: true
  })
  let t = preview([changed])
  assert.equal(t.preview.items[0].changes.filter((c) => c.protected).length, 2)
  apply(t)
  let saved = getAssignment(a.id)
  assert.equal(saved.task.title, '自己的名称')
  assert.equal(saved.task.status, 'doing')
  assert.equal(saved.task.detail, '自己的学习要求')
  assert.equal(saved.task.due_at, Date.parse('2026-11-25T23:59:00+08:00'))
  assert.equal(campusProvenance(a.id).current.submitted, true)
  t = preview([changed])
  apply(t, [{ key: t.preview.items[0].key, fields: ['title'] }])
  saved = getAssignment(a.id)
  assert.equal(saved.task.title, changed.title)
  assert.deepEqual(campusProvenance(a.id).overrides, ['due_at'])
  assert.equal(campusProvenance(a.id).versions, 2)
  assert.equal(
    getDb()
      .prepare(
        'SELECT mutation_origin,writing FROM assignment_links WHERE assignment_id=?'
      )
      .get(a.id).mutation_origin,
    'local'
  )
})

test('stale assignment, course config, source state and duplicate selections reject atomically', () => {
  let t = preview(),
    a = assignments().find((a) => a.task.title === '学校新名称')
  edit(a, { detail: '预览后的改动' })
  assert.throws(() => apply(t), /已变化/)
  t = preview()
  let c = campusCourses('account-one', '2026-2027-1').find(
    (c) => c.id === 'course-one'
  )
  mapCampusCourse('account-one', '2026-2027-1', {
    id: c.id,
    revision: c.revision,
    subject_id: null
  })
  assert.throws(() => apply(t), /已变化/)
  t = preview()
  assert.throws(
    () =>
      applyCampusTicket(t, {
        token: t.preview.token,
        keys: [t.preview.items[0].key, t.preview.items[0].key],
        adopt: []
      }),
    /不正确/
  )
  assert.throws(
    () =>
      preview([source(), source({ title: 'same id contradictory source' })]),
    /冲突/
  )
})

test('trash tombstones never resurrect, absent/failed source never deletes, transaction failure rolls back', () => {
  let a = assignments().find((a) => a.task.title === '学校新名称')
  archiveAssignment({ id: a.id, expected_revision: a.revision, archived: true })
  const t = preview()
  assert.equal(t.preview.items[0].kind, 'trash')
  apply(t)
  assert.notEqual(getAssignment(a.id).deleted_at, null)
  const count = getDb().prepare('SELECT count(*) AS n FROM assignments').get().n
  apply(buildCampusTicket([], ['course failed']))
  assert.equal(
    getDb().prepare('SELECT count(*) AS n FROM assignments').get().n,
    count
  )
  const batch = preview([
    source({ id: 'rollback-one' }),
    source({ id: 'rollback-two' })
  ])
  getDb().exec(
    "CREATE TEMP TRIGGER fail_campus_import BEFORE INSERT ON campus_source_versions WHEN json_extract(NEW.source_json,'$.id')='rollback-two' BEGIN SELECT RAISE(ABORT,'injected'); END"
  )
  assert.throws(() => apply(batch), /injected/)
  assert.equal(
    getDb().prepare('SELECT count(*) AS n FROM assignments').get().n,
    count
  )
  assert.equal(
    getDb()
      .prepare(
        "SELECT count(*) AS n FROM assignment_links WHERE mutation_origin!='local' OR writing!=0"
      )
      .get().n,
    0
  )
  getDb().exec('DROP TRIGGER fail_campus_import')
  assert.equal(apply(batch).created, 2)
})

test('course subject mapping preserves personal overrides and survives deleted subjects/restart', () => {
  course('mapping-account')
  const db = getDb(),
    subjects = db.prepare('SELECT id FROM subjects').all()
  let c = campusCourses('mapping-account', '2026-2027-1')[0]
  mapCampusCourse('mapping-account', '2026-2027-1', {
    ...c,
    subject_id: subjects[0].id
  })
  apply(preview([source({}, 'mapping-account')]))
  let a = assignments().find(
    (a) => campusProvenance(a.id).current.account_id === 'mapping-account'
  )
  assert.equal(a.subject_id, subjects[0].id)
  a = edit(a, { subject_id: subjects[1].id })
  c = campusCourses('mapping-account', '2026-2027-1')[0]
  mapCampusCourse('mapping-account', '2026-2027-1', {
    ...c,
    subject_id: subjects[2].id
  })
  apply(preview([source({}, 'mapping-account')]))
  assert.equal(getAssignment(a.id).subject_id, subjects[1].id)
  const before = campusCourses('mapping-account', '2026-2027-1')[0]
  db.prepare('DELETE FROM subjects WHERE id=?').run(subjects[2].id)
  assert.notEqual(
    campusCourses('mapping-account', '2026-2027-1')[0].revision,
    before.revision
  )
  closeDb()
  assert.equal(campusProvenance(a.id).current.id, 'student-homework')
  assert.equal(getAssignment(a.id).subject_id, subjects[1].id)
})

test('campus IPC rejects secrets, forged fields and excessive input', () => {
  assert.throws(() => validateIpc('campus:login', [{ password: 'secret' }]))
  assert.throws(() => validateIpc('campus:preview', [Array(31).fill('course')]))
  assert.throws(() =>
    validateIpc('campus:map', [
      { id: 'c', revision: 'r', subject_id: null, account_id: 'forged' }
    ])
  )
  assert.throws(() =>
    validateIpc('campus:apply', [
      { token: 'x', keys: ['x'], adopt: [{ key: 'x', fields: ['status'] }] }
    ])
  )
})

test('failed update rolls back task, source, audit and ownership; source-only changes invalidate old editors', () => {
  let a = assignments().find(
    (a) => campusProvenance(a.id).current.account_id === 'account-two'
  )
  const initial = getAssignment(a.id),
    versions = campusProvenance(a.id).versions
  const t = preview([source({ title: '学校在故障中的更新' }, 'account-two')])
  getDb().exec(
    "CREATE TEMP TRIGGER fail_campus_update BEFORE UPDATE ON campus_sources WHEN NEW.account_id='account-two' BEGIN SELECT RAISE(ABORT,'update-fault'); END"
  )
  assert.throws(() => apply(t), /update-fault/)
  assert.deepEqual(getAssignment(a.id), initial)
  assert.equal(campusProvenance(a.id).versions, versions)
  assert.equal(
    getDb()
      .prepare(
        'SELECT mutation_origin FROM assignment_links WHERE assignment_id=?'
      )
      .get(a.id).mutation_origin,
    'local'
  )
  getDb().exec('DROP TRIGGER fail_campus_update')
  assert.equal(apply(t).updated, 1)
  a = getAssignment(a.id)
  apply(
    preview([source({ title: a.task.title, submitted: true }, 'account-two')])
  )
  const updated = getAssignment(a.id)
  assert.equal(updated.task.status, a.task.status)
  assert.notEqual(updated.revision, a.revision)
  assert.throws(() => edit(a, { detail: 'stale source editor' }), /已变化/)
})
