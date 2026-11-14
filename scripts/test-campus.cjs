const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict')
if (!process.versions.electron) {
  const root = fs.mkdtempSync(
    path.join(require('node:os').tmpdir(), 'learning-assistant-campus-')
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  for (const phase of ['first', 'resume']) {
    const r = require('node:child_process').spawnSync(
      require('electron'),
      [__filename, root, phase],
      { env, windowsHide: true, encoding: 'utf8', timeout: 100000 }
    )
    process.stdout.write(r.stdout || '')
    process.stderr.write(r.stderr || '')
    if (r.error) throw r.error
    assert.equal(r.status, 0, '网络学堂桌面验收失败：' + phase)
  }
  console.log('CAMPUS_NATIVE_ROOT ' + root)
} else {
  const electron = require('electron'),
    { app } = electron,
    root = process.argv[2],
    phase = process.argv[3]
  app.disableHardwareAcceleration()
  app.setPath('userData', root)
  app.setPath('sessionData', root)
  let version = 1,
    delayed = false,
    identityAvailable = true,
    requests = [],
    loginOptions = null
  const realPartition = electron.session.fromPartition.bind(electron.session)
  // Test-only transport substitution, outside production code. The actual maintained library,
  // controller, security boundary, preload, UI and database still execute normally.
  const fakeSession = {
    get defaultSession() {
      return electron.session.defaultSession
    },
    fromPartition(name, options) {
      assert.equal(name.startsWith('persist:'), false)
      const ses = realPartition(name, options)
      ses.__capture = null
      ses.webRequest.onBeforeRequest = (_filter, callback) => {
        ses.__capture = callback
      }
      ses.fetch = async (input, init = {}) => {
        const u = new URL(typeof input === 'string' ? input : input.url),
          p = u.pathname
        requests.push({ path: p, method: init.method })
        assert.equal(init.credentials, 'include')
        assert.equal(init.redirect, 'error')
        if (delayed)
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 20000)
            init.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer)
                reject(Error('aborted'))
              },
              { once: true }
            )
          })
        if (p === '/f/wlxt/index/course/student/')
          return new Response(
            '<a class="user-log">验收同学</a><div class="fl up-img-info"><p>学生</p><p><label>测试院系</label></p></div><a href="?a=1&_csrf=fixture-token">课程</a>'
          )
        let json
        if (p.endsWith('/getCurrentAndNextSemester'))
          json = {
            message: 'success',
            result: {
              id: '2026-2027-1',
              xnxq: '2026-2027-1',
              kssj: '2026-09-01',
              jssj: '2027-01-31'
            }
          }
        else if (p.includes('/loadCourseBySemesterId/'))
          json = {
            message: 'success',
            resultList: [
              {
                wlkcid: 'course-good',
                zywkcm: '理论力学',
                kcm: '理论力学',
                ywkcm: 'Mechanics'
              },
              {
                wlkcid: 'course-failed',
                zywkcm: '读取失败课程',
                kcm: '读取失败课程',
                ywkcm: 'Failed'
              }
            ]
          }
        else if (
          /\/student\/(zyListWj|zyListYjwg|zyListYpg|yxzylist)$/.test(p)
        ) {
          assert.equal(init.method, 'POST')
          const course = JSON.parse(init.body.get('aoData')).find(
            (v) => v.name === 'wlkcid'
          )?.value
          if (course === 'course-failed')
            throw Error('fixture course unavailable')
          const hw = (id, bt) => ({
            xszyid: id,
            zyid: 'base-' + id,
            wlkcid: 'course-good',
            bt,
            jzsj: version === 1 ? '2026-11-20 23:59:00' : '2026-11-22 23:59:00',
            cj: 98,
            pynr: 'PRIVATE_GRADE_COMMENT',
            jsm: 'PRIVATE_GRADER'
          })
          json = {
            result: 'success',
            message: 'success',
            object: {
              aaData: p.endsWith('zyListWj')
                ? [
                    hw(
                      'hw-one',
                      version === 1 ? '动力学课堂作业' : '学校修订名称'
                    )
                  ]
                : p.endsWith('zyListYjwg')
                  ? [hw('hw-submitted', '已提交的旧作业')]
                  : []
            }
          }
        } else throw Error('Unexpected endpoint: ' + p)
        return Response.json(json)
      }
      return ses
    }
  }
  class HiddenWindow extends electron.BrowserWindow {
    constructor(options) {
      super({
        ...options,
        width: 1100,
        height: 850,
        show: false,
        webPreferences: {
          ...options.webPreferences,
          offscreen: true,
          backgroundThrottling: false
        }
      })
      if (options.webPreferences?.session) {
        loginOptions = options
        assert.equal(options.webPreferences.preload, undefined)
        assert.equal(options.webPreferences.nodeIntegration, false)
        assert.equal(options.webPreferences.contextIsolation, true)
        assert.equal(options.webPreferences.sandbox, true)
        this.loadURL = async (url) => {
          assert.equal(
            url,
            'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/bb5df85216504820be7bba2b0ae1535b/0'
          )
          this.webContents.getURL = () =>
            'https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/'
          options.webPreferences.session.__capture(
            {
              webContentsId: this.webContents.id,
              method: 'POST',
              url: 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/check',
              uploadData: [
                {
                  bytes: Buffer.from(
                    identityAvailable
                      ? 'i_user=private-student-login&i_pass=PRIVATE_PASSWORD'
                      : 'i_pass=PRIVATE_PASSWORD'
                  )
                }
              ]
            },
            () => {}
          )
          setImmediate(() => this.webContents.emit('did-finish-load'))
        }
      }
    }
    show() {}
  }
  const Module = require('node:module'),
    load = Module._load
  Module._load = function (request, parent, main) {
    return request === 'electron'
      ? { ...electron, session: fakeSession, BrowserWindow: HiddenWindow }
      : load.call(this, request, parent, main)
  }
  const deadline = setTimeout(() => {
    console.error('CAMPUS_TIMEOUT')
    app.exit(2)
  }, 90000)
  app.once('browser-window-created', (_event, win) =>
    win.webContents.once('did-finish-load', async () => {
      const js = (c) => win.webContents.executeJavaScript(c)
      const call = async (g, m, ...args) => {
        const r = await js(
          `window.api[${JSON.stringify(g)}][${JSON.stringify(m)}](...${JSON.stringify(args)})`
        )
        assert.equal(r.ok, true, r.error)
        return r.data
      }
      const pause = (ms) => new Promise((r) => setTimeout(r, ms))
      const wait = async (code) => {
        const until = Date.now() + 15000
        while (!(await js(code))) {
          if (Date.now() > until) throw Error('等待失败：' + code)
          await pause(50)
        }
      }
      const click = (text) =>
        js(
          `(()=>{const b=[...document.querySelectorAll('.campus-panel button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw Error('按钮不可用 '+${JSON.stringify(text)});b.click()})()`
        )
      const capture = async (name) => {
        await js('document.fonts.ready')
        await pause(120)
        fs.writeFileSync(
          path.join(root, name),
          (await win.webContents.capturePage()).toPNG()
        )
      }
      try {
        await js("location.hash='/assignments'")
        await wait("!!document.querySelector('.campus-panel')")
        await js("document.querySelector('.campus-panel').open=true")
        await wait(
          "[...document.querySelectorAll('.campus-panel button')].some(b=>b.textContent==='连接网络学堂'&&!b.disabled)"
        )
        assert.equal((await call('campus', 'state')).phase, 'disconnected')
        if (phase === 'resume') {
          const checkpoint = JSON.parse(
            fs.readFileSync(path.join(root, 'campus-checkpoint.json'))
          )
          const a = await call('assignments', 'get', checkpoint.id)
          assert.equal(a.task.id, checkpoint.task)
          assert.equal(a.task.title, '学校修订名称')
          assert.equal(a.deleted_at, checkpoint.deleted_at)
          assert.equal((await call('campus', 'provenance', a.id)).versions, 2)
          assert.equal(
            (
              await call('assignments', 'list', {
                scope: 'all',
                query: '',
                offset: 0
              })
            ).total,
            0
          )
          await capture('campus-offline-resume.png')
        } else {
          await click('连接网络学堂')
          await wait(
            "document.querySelector('.campus-courses')?.children.length===2"
          )
          assert.ok(loginOptions)
          const subjects = await call('subjects', 'list')
          await js(
            `(()=>{const e=document.querySelector('[aria-label="理论力学对应学科"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(subjects[0].id)});e.dispatchEvent(new Event('change',{bubbles:true}))})()`
          )
          await wait(
            `document.querySelector('[aria-label="理论力学对应学科"]').value===${JSON.stringify(subjects[0].id)}`
          )
          await pause(100)
          await js(
            "document.querySelectorAll('.campus-courses input[type=checkbox]').forEach(e=>e.click())"
          )
          await click('读取并预览作业')
          await wait(
            "document.querySelectorAll('.campus-preview article').length===2"
          )
          assert.match(
            await js("document.querySelector('.campus-preview').innerText"),
            /读取失败课程/
          )
          assert.equal(
            await js(
              "document.querySelectorAll('.campus-preview article input:checked').length"
            ),
            1
          )
          await capture('campus-preview.png')
          await click('确认导入所选作业')
          await wait("!document.querySelector('.campus-preview')")
          let a = (
            await call('assignments', 'list', {
              scope: 'all',
              query: '',
              offset: 0
            })
          ).items[0]
          assert.equal(a.subject_id, subjects[0].id)
          assert.equal(a.task.status, 'open')
          const task = a.task.id
          a = await call('assignments', 'save', {
            id: a.id,
            expected_revision: a.revision,
            subject_id: a.subject_id,
            title: '手动保留的名称',
            detail: '独立学习要求',
            status: 'doing',
            blocked_reason: '',
            due_at: a.task.due_at
          })
          version = 2
          await click('读取并预览作业')
          await wait("!!document.querySelector('.campus-change')")
          assert.match(
            await js("document.querySelector('.campus-preview').innerText"),
            /默认保留手动修改/
          )
          await capture('campus-protected-change.png')
          await click('确认导入所选作业')
          await wait("!document.querySelector('.campus-preview')")
          a = await call('assignments', 'get', a.id)
          assert.equal(a.task.title, '手动保留的名称')
          assert.equal(a.task.id, task)
          assert.equal(a.task.status, 'doing')
          assert.equal(a.task.due_at, Date.parse('2026-11-22T23:59:00+08:00'))
          assert.equal((await call('campus', 'provenance', a.id)).versions, 2)
          await click('读取并预览作业')
          await wait("!!document.querySelector('.campus-change input')")
          await js("document.querySelector('.campus-change input').click()")
          await click('确认导入所选作业')
          await wait("!document.querySelector('.campus-preview')")
          a = await call('assignments', 'get', a.id)
          assert.equal(a.task.title, '学校修订名称')
          assert.deepEqual(
            (await call('campus', 'provenance', a.id)).overrides,
            []
          )
          a = await call('assignments', 'archive', {
            id: a.id,
            expected_revision: a.revision,
            archived: true
          })
          await click('读取并预览作业')
          await wait("!!document.querySelector('.campus-preview')")
          assert.match(
            await js("document.querySelector('.campus-preview').innerText"),
            /保留删除状态/
          )
          await click('取消预览')
          delayed = true
          await click('读取并预览作业')
          await pause(100)
          await click('断开连接')
          await wait(
            "[...document.querySelectorAll('.campus-panel button')].some(b=>b.textContent==='连接网络学堂'&&!b.disabled)"
          )
          assert.equal((await call('campus', 'state')).phase, 'disconnected')
          assert.equal(
            await js("!!document.querySelector('.campus-preview')"),
            false
          )
          delayed = false
          identityAvailable = false
          await click('连接网络学堂')
          await wait(
            "document.querySelector('.campus-panel')?.innerText.includes('无法可靠区分账号')"
          )
          assert.equal((await call('campus', 'state')).phase, 'login')
          await click('断开连接')
          await wait(
            "[...document.querySelectorAll('.campus-panel button')].some(b=>b.textContent==='连接网络学堂'&&!b.disabled)"
          )
          fs.writeFileSync(
            path.join(root, 'campus-checkpoint.json'),
            JSON.stringify({ id: a.id, task, deleted_at: a.deleted_at })
          )
          const Database = require('better-sqlite3'),
            db = new Database(path.join(root, 'learning-assistant.db'), {
              readonly: true
            })
          const stored = JSON.stringify(
            [
              'campus_accounts',
              'campus_sources',
              'campus_source_versions',
              'assignment_history'
            ].flatMap((t) => db.prepare('SELECT * FROM ' + t).all())
          )
          for (const secret of [
            'private-student-login',
            'PRIVATE_PASSWORD',
            'fixture-token',
            'PRIVATE_GRADE_COMMENT',
            'PRIVATE_GRADER'
          ])
            assert.equal(stored.includes(secret), false)
          db.close()
          assert.ok(requests.some((r) => r.method === 'POST'))
        }
        console.log('CAMPUS_NATIVE_OK ' + phase)
        clearTimeout(deadline)
        app.exit(0)
      } catch (error) {
        console.error(error.stack || error)
        console.error(
          JSON.stringify(await call('campus', 'state').catch(() => null))
        )
        console.error(JSON.stringify(requests))
        clearTimeout(deadline)
        app.exit(1)
      }
    })
  )
  require('../out/main/index.js')
}
