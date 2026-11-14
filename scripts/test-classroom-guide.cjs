// Actual Electron, preload, React, IPC and SQLite; isolated data, no microphone or login.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict')
if (!process.versions.electron) {
  const root = fs.mkdtempSync(
    path.join(require('node:os').tmpdir(), 'learning-assistant-guide-')
  )
  for (const phase of ['first', 'resume']) {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const r = require('node:child_process').spawnSync(
      require('electron'),
      [__filename, root, phase],
      { env, windowsHide: true, encoding: 'utf8', timeout: 100000 }
    )
    process.stdout.write(r.stdout || '')
    process.stderr.write(r.stderr || '')
    if (r.error) throw r.error
    assert.equal(r.status, 0, '课堂导学桌面验收：' + phase)
  }
  console.log('CLASSROOM_GUIDE_NATIVE_OK ' + root)
} else {
  const electron = require('electron'),
    { app } = electron,
    root = process.argv[2],
    phase = process.argv[3]
  app.disableHardwareAcceleration()
  app.setPath('userData', root)
  app.setPath('sessionData', root)
  class HiddenWindow extends electron.BrowserWindow {
    constructor(options) {
      super({
        ...options,
        width: 1280,
        height: 960,
        show: false,
        webPreferences: {
          ...options.webPreferences,
          offscreen: true,
          backgroundThrottling: false
        }
      })
    }
    show() {}
  }
  const Module = require('node:module'),
    load = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron')
      return { ...electron, BrowserWindow: HiddenWindow }
    return load.call(this, request, parent, isMain)
  }
  const deadline = setTimeout(() => {
    console.error('GUIDE_TIMEOUT')
    app.exit(2)
  }, 95000)
  app.on('browser-window-created', (_event, win) => {
    win.webContents.once('did-finish-load', async () => {
      const js = async (code) => {
        try {
          return await win.webContents.executeJavaScript(code)
        } catch (e) {
          throw Error('Native test script: ' + code + '\n' + e.message)
        }
      }
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const call = async (group, method, ...args) => {
        const r = await js(
          `window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`
        )
        assert.equal(r.ok, true, r.error)
        return r.data
      }
      const wait = async (read, label) => {
        const end = Date.now() + 14000
        while (!(await read())) {
          if (Date.now() > end)
            throw Error(label + '\n' + (await js('document.body.innerText')))
          await pause(50)
        }
      }
      const click = (label, selector = 'document') =>
        js(
          `(()=>{const e=[...${selector}.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!e||e.disabled)throw Error('按钮不可操作：'+${JSON.stringify(label)});e.click();return true})()`
        )
      const guide = 'document.querySelector(".classroom-guide")'
      const manual = async (text) => {
        await js(
          `document.querySelector('[aria-label="课堂手动记录"]').focus();void 0`
        )
        win.webContents.sendInputEvent({
          type: 'keyDown',
          keyCode: 'A',
          modifiers: ['control']
        })
        win.webContents.sendInputEvent({
          type: 'keyUp',
          keyCode: 'A',
          modifiers: ['control']
        })
        await pause(50)
        await js(
          `(()=>{const d=new DataTransfer();d.setData('text/plain',${JSON.stringify(text)});document.querySelector('[aria-label="课堂手动记录"]').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}));return true})()`
        )
        await click('添加段落')
        await wait(
          () =>
            js(
              `document.querySelector('[aria-label="课堂手动记录"]').textContent===''`
            ),
          '手动记录保存'
        )
      }
      let db
      try {
        await wait(() => js('!!window.api'), '预加载就绪')
        db = new (require('better-sqlite3'))(
          path.join(root, 'learning-assistant.db')
        )
        if (phase === 'resume') {
          const saved = JSON.parse(
            fs.readFileSync(path.join(root, 'guide-checkpoint.json'), 'utf8')
          )
          const state = await call('classroomGuide', 'state', {
            note_id: saved.note,
            offset: 0
          })
          assert.equal(state.active, false)
          assert.equal(state.queued, 0)
          assert.equal(state.total, saved.total)
          await js(
            `location.hash=${JSON.stringify('/classroom?note=' + saved.note)}`
          )
          await wait(
            () =>
              js(
                `!![...document.querySelectorAll('button')].find(e=>e.textContent==='继续课堂'&&!e.disabled)`
              ),
            '课堂恢复入口'
          )
          await pause(1200)
          assert.equal(
            await js('!!document.querySelector(".guide-banner")'),
            false
          )
          await click('继续课堂')
          await wait(
            () =>
              js(
                `!!document.querySelector('[aria-label="课堂重点提示"]:checked:not(:disabled)')`
              ),
            '恢复设置'
          )
          await pause(1200)
          assert.equal(
            await js('!!document.querySelector(".guide-banner")'),
            false,
            '旧课堂不重播'
          )
          await manual('重点：重开课堂之后的新线索。')
          await wait(
            () =>
              js(
                `document.querySelector('.guide-banner')?.textContent.includes('重开课堂之后')`
              ),
            '新会话提示'
          )
          await call('classroom', 'stop')
        } else {
          await call('config', 'set', 'classroom.autoOrganize', '0')
          await call('config', 'set', 'asr.model_dir', '')
          db.exec(`INSERT INTO materials(id,title,kind,created_at) VALUES('guide-material','导学力学教材','textbook',1);
            INSERT INTO material_versions(id,material_id,file_name,format,file_path,fingerprint,status,created_at) VALUES('guide-version','guide-material','guide.docx','docx','unused.docx','guide-hash','ready',1);
            UPDATE materials SET current_version_id='guide-version' WHERE id='guide-material';
            INSERT INTO material_blocks(id,version_id,ordinal,text,locator_json) VALUES('guide-block','guide-version',0,'动量守恒应当先检查系统边界与外力。','{"kind":"docx","paragraph":0}');`)
          const note = await call('notes', 'create', {
            title: '课堂导学桌面验收',
            source: 'class'
          })
          await call('classroom', 'calibrate', {
            note_id: note.id,
            block_id: 'guide-block'
          })
          await js(
            `location.hash=${JSON.stringify('/classroom?note=' + note.id)}`
          )
          await wait(
            () =>
              js(
                `!![...document.querySelectorAll('button')].find(e=>e.textContent==='继续课堂'&&!e.disabled)`
              ),
            '继续课堂入口'
          )
          await click('继续课堂')
          await wait(
            () =>
              js(
                `!!document.querySelector('[aria-label="课堂重点提示"]:not(:disabled)')`
              ),
            '导学开关就绪'
          )
          assert.equal(
            await js(
              `document.querySelector('[aria-label="课堂重点提示"]').checked`
            ),
            false
          )
          await manual('重点：尚未开启时的旧记录。')
          await js(
            `document.querySelector('[aria-label="课堂重点提示"]').click();void 0`
          )
          await wait(
            async () =>
              (
                await call('classroomGuide', 'state', {
                  note_id: note.id,
                  offset: 0
                })
              ).enabled,
            '保存开关'
          )
          assert.equal(
            (
              await call('classroomGuide', 'state', {
                note_id: note.id,
                offset: 0
              })
            ).total,
            0
          )
          await manual('这里不是重点。“考试会考”只是一句引用。')
          await pause(1100)
          assert.equal(
            (
              await call('classroomGuide', 'state', {
                note_id: note.id,
                offset: 0
              })
            ).total,
            0
          )
          await manual('重点：动量守恒必须先核对系统边界与外力。')
          await wait(
            () => js(`!!document.querySelector('.guide-banner')`),
            '重点横幅'
          )
          let state = await call('classroomGuide', 'state', {
            note_id: note.id,
            offset: 0
          })
          const first = state.hints[0]
          assert.equal(first.notice, true)
          assert.equal(
            db.prepare('SELECT count(*) n FROM annotations').get().n,
            0
          )
          fs.writeFileSync(
            path.join(root, 'guide-live.png'),
            (await win.webContents.capturePage()).toPNG()
          )
          // Capture the native layout at a narrow viewport too; no horizontal overflow is allowed.
          win.setSize(960, 800)
          await pause(200)
          assert.equal(
            await js('document.documentElement.scrollWidth<=innerWidth'),
            true
          )
          fs.writeFileSync(
            path.join(root, 'guide-narrow.png'),
            (await win.webContents.capturePage()).toPNG()
          )
          win.setSize(1280, 960)
          await click('标为重点', 'document.querySelector(".guide-banner")')
          await wait(
            () => js('!document.querySelector(".guide-banner")'),
            '采纳后关闭横幅'
          )
          assert.equal(
            db
              .prepare('SELECT count(*) n FROM annotations WHERE segment_id=?')
              .get(first.segment_id).n,
            1
          )
          await manual('容易混淆系统内力与外力。')
          await wait(
            async () =>
              (
                await call('classroomGuide', 'state', {
                  note_id: note.id,
                  offset: 0
                })
              ).total === 2,
            '冷却期记录'
          )
          state = await call('classroomGuide', 'state', {
            note_id: note.id,
            offset: 0
          })
          assert.equal(state.hints[0].notice, false)
          assert.match(state.hints[0].quiet_reason, /间隔/)
          await js('document.querySelector(".guide-history").open=true;void 0')
          await wait(
            () => js('document.querySelectorAll(".guide-item").length===2'),
            '历史刷新'
          )
          await click(
            '查看原句与教材',
            'document.querySelectorAll(".guide-item")[1]'
          )
          await wait(
            () =>
              js(
                `!!document.getElementById(${JSON.stringify('classroom-segment-' + first.segment_id)})`
              ),
            '跳转原文'
          )
          assert.equal(
            (await call('notes', 'get', note.id)).segments.find(
              (s) => s.id === first.segment_id
            ).material_ref.id,
            'guide-block'
          )
          await click(
            '忽略此提示',
            'document.querySelectorAll(".guide-item")[0]'
          )
          await wait(
            async () =>
              (
                await call('classroomGuide', 'state', {
                  note_id: note.id,
                  offset: 0
                })
              ).hints[0].status === 'dismissed',
            '忽略线索'
          )
          await js(
            `document.querySelector('[aria-label="课堂重点提示"]').click();void 0`
          )
          await wait(
            async () =>
              !(
                await call('classroomGuide', 'state', {
                  note_id: note.id,
                  offset: 0
                })
              ).enabled,
            '关闭导学'
          )
          await manual('重点：关闭后不应生成提示。')
          await pause(1100)
          assert.equal(
            (
              await call('classroomGuide', 'state', {
                note_id: note.id,
                offset: 0
              })
            ).total,
            2
          )
          await js(
            `document.querySelector('[aria-label="课堂重点提示"]').click();void 0`
          )
          await wait(
            async () =>
              (
                await call('classroomGuide', 'state', {
                  note_id: note.id,
                  offset: 0
                })
              ).enabled,
            '重新开启'
          )
          await call('classroom', 'stop')
          db.prepare(
            'UPDATE note_segments SET raw_text=?,revision=revision+1 WHERE id=?'
          ).run('教师修正了原始讲授内容。', first.segment_id)
          await js(`location.hash=${JSON.stringify('/notes/' + note.id)}`)
          await wait(
            () => js(`!!document.querySelector('[aria-label="课堂导学记录"]')`),
            '课后回查'
          )
          await js('document.querySelector(".guide-history").open=true;void 0')
          await wait(
            () => js('!!document.querySelector(".guide-stale")'),
            '原文修改过期提示'
          )
          fs.writeFileSync(
            path.join(root, 'guide-history.png'),
            (await win.webContents.capturePage()).toPNG()
          )
          await js(
            `(()=>{const e=document.querySelector('.toolbar input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'导学核对中未保存的标题');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`
          )
          await pause(100)
          await click('标为疑问', 'document.querySelectorAll(".guide-item")[0]')
          await wait(
            async () =>
              (
                await call('classroomGuide', 'state', {
                  note_id: note.id,
                  offset: 0
                })
              ).hints[0].status === 'adopted',
            '课后采纳标注'
          )
          await pause(100)
          assert.equal(
            await js(`document.querySelector('.toolbar input').value`),
            '导学核对中未保存的标题',
            '采纳不能丢失未保存标题'
          )
          await click('统一文档')
          await pause(200)
          await click(
            '查看当前原文',
            'document.querySelectorAll(".guide-item")[1]'
          )
          await wait(
            () =>
              js(
                `(()=>{const r=document.getElementById(${JSON.stringify('note-segment-' + first.segment_id)})?.getBoundingClientRect();return !!r&&r.top<innerHeight&&r.bottom>0})()`
              ),
            '从统一文档定位当前原句'
          )
          await pause(100)
          assert.equal(
            await js(`document.querySelector('.toolbar input').value`),
            '导学核对中未保存的标题',
            '原句跳转不能丢失未保存标题'
          )
          const total = (
            await call('classroomGuide', 'state', {
              note_id: note.id,
              offset: 0
            })
          ).total
          fs.writeFileSync(
            path.join(root, 'guide-checkpoint.json'),
            JSON.stringify({ note: note.id, total })
          )
        }
        assert.deepEqual(db.pragma('foreign_key_check'), [])
        db.close()
        clearTimeout(deadline)
        console.log('GUIDE_NATIVE_PHASE_OK ' + phase)
        app.exit(0)
      } catch (error) {
        console.error(error.stack || error)
        try {
          fs.writeFileSync(
            path.join(root, 'guide-failed.png'),
            (await win.webContents.capturePage()).toPNG()
          )
        } catch {}
        db?.close()
        clearTimeout(deadline)
        app.exit(1)
      }
    })
  })
  require(path.resolve('out/main/index.js'))
}
