// 隐藏 Electron 验收：真实窗口、主进程 IPC、ICS worker、文件对话框和重启；使用独立数据目录。
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto')
if (!process.versions.electron) {
  const root = fs.mkdtempSync(
      path.join(require('node:os').tmpdir(), 'learning-assistant-calendar-')
    ),
    env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  for (const phase of ['first', 'resume']) {
    const r = require('node:child_process').spawnSync(
      require('electron'),
      [__filename, root, phase],
      { env, windowsHide: true, encoding: 'utf8', timeout: 120000 }
    )
    process.stdout.write(r.stdout || '')
    process.stderr.write(r.stderr || '')
    if (r.error) throw r.error
    assert.equal(r.status, 0, '教材/日历验收失败：' + phase)
  }
  console.log('CALENDAR_NATIVE_ROOT ' + root)
  process.exit(0)
}
const electron = require('electron'),
  { app } = electron,
  root = process.argv[2],
  phase = process.argv[3]
app.disableHardwareAcceleration()
app.setPath('userData', root)
app.setPath('sessionData', root)
let selectedFile, saveFile
class HiddenWindow extends electron.BrowserWindow {
  constructor(options) {
    super({
      ...options,
      width: 1500,
      height: 1000,
      show: false,
      webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false }
    })
  }
  show() {}
}
class NotificationSpy {
  static isSupported() {
    return true
  }
  show() {}
}
const Module = require('node:module'),
  load = Module._load
Module._load = function (request, parent, main) {
  if (request === 'electron')
    return {
      ...electron,
      BrowserWindow: HiddenWindow,
      Notification: NotificationSpy,
      dialog: {
        ...electron.dialog,
        showOpenDialog: async () => ({
          canceled: !selectedFile,
          filePaths: selectedFile ? [selectedFile] : []
        }),
        showSaveDialog: async () => ({ canceled: !saveFile, filePath: saveFile })
      }
    }
  return load.call(this, request, parent, main)
}
const deadline = setTimeout(() => {
  console.error('CALENDAR_NATIVE_TIMEOUT')
  app.exit(2)
}, 110000)
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const localDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const localTime = (d) =>
  localDate(d) +
  `T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
app.on('browser-window-created', (_event, win) =>
  win.webContents.once('did-finish-load', async () => {
    const js = (code) =>
      win.webContents.executeJavaScript(code).catch((e) => {
        throw Error(e.message + '\n表达式：' + code.slice(0, 400))
      })
    const call = async (group, method, ...args) => {
      const r = await js(
        `window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`
      )
      assert.equal(r.ok, true, r.error)
      return r.data
    }
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const wait = async (expression) => {
      const end = Date.now() + 10000
      while (!(await js(`Promise.resolve((${expression})).then(value=>!!value)`))) {
        if (Date.now() > end)
          throw Error('等待失败：' + expression + '\n' + (await js('document.body.innerText')))
        await pause(30)
      }
    }
    const click = (label, scope = '.page') =>
      js(
        `(()=>{const b=Array.from(document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)throw Error('按钮不可操作：'+${JSON.stringify(label)});b.click();return true})()`
      )
    const set = (selector, value) =>
      js(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('缺少输入：'+${JSON.stringify(selector)});const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));return true})()`
      )
    const frame = () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('截图超时')), 5000)
        win.webContents.once('paint', (_e, _r, img) => {
          clearTimeout(timer)
          resolve(img)
        })
        win.webContents.invalidate()
      })
    const capture = async (name) => {
      await js('document.fonts.ready.then(()=>true)')
      await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))')
      await frame()
      fs.writeFileSync(path.join(root, name), (await frame()).toPNG())
    }
    try {
      await wait('!!window.api')
      await js('window.confirm=()=>true;true')
      if (phase === 'resume') {
        const checkpoint = JSON.parse(
            fs.readFileSync(path.join(root, 'calendar-checkpoint.json'), 'utf8')
          ),
          tasks = await call('tasks', 'listAll')
        assert.equal(tasks.find((t) => t.id === checkpoint.manual).location, '实验室 301')
        assert.equal(tasks.find((t) => t.id === checkpoint.edited).title, '已人工修改的课程')
        assert.equal(
          tasks.some((t) => t.id === checkpoint.deleted),
          false
        )
        assert.equal(
          (await call('materials', 'get', checkpoint.material)).material.title,
          '重命名力学讲义'
        )
        assert.equal(
          (await call('notes', 'get', checkpoint.note)).segments[0].material_ref.id,
          checkpoint.block
        )
        selectedFile = checkpoint.ics
        const preview = await call('calendar', 'preview', checkpoint.range),
          result = await call('calendar', 'import', preview.token)
        assert.deepEqual(result, { added: 0, skipped: 3 })
        console.log(
          'CALENDAR_RESTART_OK material metadata/source links, calendar times, manual edits, delete tombstone and import dedup'
        )
        clearTimeout(deadline)
        app.exit(0)
        return
      }
      const subjects = await call('subjects', 'list'),
        subject = subjects[0].id,
        moved = subjects[1].id
      const { zipSync, strToU8 } = require('fflate'),
        source = path.join(root, '教材源文件.docx')
      fs.writeFileSync(
        source,
        zipSync({
          '[Content_Types].xml': strToU8(
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
          ),
          'word/document.xml': strToU8(
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>动量守恒：总动量保持不变。</w:t></w:r></w:p></w:body></w:document>'
          )
        })
      )
      const originalHash = hash(source)
      selectedFile = source
      const material = await call('materials', 'import', { subject_id: subject, kind: 'handout' })
      await wait(
        `window.api.materials.get(${JSON.stringify(material.id)}).then(r=>r.data.versions[0].status==='ready')`
      )
      const block = (await call('materials', 'blocks', { version_id: material.current_version_id }))
        .blocks[0]
      const note = await call('notes', 'create', { title: '教材管理引用测试', source: 'class' })
      await call('classroom', 'calibrate', { note_id: note.id, block_id: block.id })
      await call('notes', 'addSegment', { note_id: note.id, raw_text: '课堂来源应保留' })
      await js(`location.hash='/library?material=${material.id}'`)
      await wait("!!document.querySelector('.material-management')")
      await js("document.querySelector('.material-management').open=true")
      await set('[aria-label="教材名称"]', '重命名力学讲义')
      await set('[aria-label="移动教材到学科"]', moved)
      await click('保存教材信息')
      await wait("document.querySelector('.material-reader h2')?.textContent==='重命名力学讲义'")
      assert.equal((await call('materials', 'list', subject)).length, 0)
      assert.equal((await call('materials', 'list', moved))[0].id, material.id)
      await click('删除教材')
      await wait("document.body.innerText.includes('教材已在回收站')")
      assert.equal((await call('materials', 'list', moved)).length, 0)
      assert.equal((await call('notes', 'get', note.id)).segments[0].material_ref.id, block.id)
      await set('.sidebar select', moved)
      await click('回收站')
      await wait("!!document.querySelector('.material-book')")
      await js("document.querySelector('.material-book').click()")
      await wait("document.body.innerText.includes('恢复教材')")
      await click('恢复教材')
      await wait("!!document.querySelector('.material-management')")
      assert.equal((await call('materials', 'list', moved))[0].title, '重命名力学讲义')
      assert.equal(hash(source), originalHash)
      await click('全部教材')
      await capture('materials-management.png')
      await js("location.hash='/review'")
      await wait("!!document.querySelector('.fc-timeGridWeek-view')")
      const firstSlot=()=>js("document.querySelector('.fc-timegrid-slot[data-time]')?.getAttribute('data-time')")
      assert.equal(await js("(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect();return rect('.fc-prev-button').right<=rect('.fc-jumpDate-button').left&&rect('.fc-jumpDate-button').right<=rect('.fc-next-button').left&&rect('.fc-next-button').right<=rect('.fc-today-button').left})()"),true,'前后箭头在日期两侧，今天在右箭头之后')
      const navigationPositions=()=>js("['.fc-next-button','.fc-today-button'].map(s=>document.querySelector(s).getBoundingClientRect().x)")
      const stablePositions=await navigationPositions()
      await js("document.querySelector('.fc-timeGridDay-button').click()")
      await wait("!!document.querySelector('.fc-timeGridDay-view')")
      assert.deepEqual(await navigationPositions(),stablePositions,'日视图日期变短时，右侧按钮不移动')
      await js("document.querySelector('.fc-dayGridMonth-button').click()")
      await wait("!!document.querySelector('.fc-dayGridMonth-view')")
      assert.deepEqual(await navigationPositions(),stablePositions,'月视图日期变短时，右侧按钮不移动')
      await js("document.querySelector('.fc-timeGridWeek-button').click()")
      await wait("!!document.querySelector('.fc-timeGridWeek-view')")
      const nextPoint=await js("(()=>{const r=document.querySelector('.fc-next-button').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()")
      win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...nextPoint})
      win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...nextPoint})
      await wait("!document.querySelector('.fc-today-button').disabled")
      assert.equal(await js("document.querySelector('.fc-next-button').matches(':active')"),false,'松开后不保持按下')
      assert.equal(await js("getComputedStyle(document.querySelector('.fc-next-button')).boxShadow"),'none','鼠标点击后不残留按下外观')
      await js("document.querySelector('.fc-today-button').click()")
      const beforeJumpTitle=await js("document.querySelector('.fc-jumpDate-button').textContent")
      await js("document.querySelector('.fc-jumpDate-button').click()")
      await wait("!!document.querySelector('[aria-label=\"跳转起始日期\"]')")
      await set('[aria-label="跳转起始日期"]','2026-02-30');await click('跳转')
      await wait("document.querySelector('.schedule-date-jump [role=alert]')?.textContent==='请输入正确日期'")
      assert.equal(await js("document.querySelector('.fc-jumpDate-button').textContent"),beforeJumpTitle,'非法日期不跳转')
      await set('[aria-label="跳转起始日期"]','2026-12-31');await click('跳转')
      await wait("document.querySelector('.fc-col-header-cell[data-date]')?.getAttribute('data-date')==='2026-12-28'")
      assert.equal(await js("(()=>{const b=document.querySelector('.fc-jumpDate-button');return b.scrollWidth<=b.clientWidth})()"),true,'跨年日期在固定标题区域内完整显示')
      await js("document.querySelector('.fc-jumpDate-button').click()")
      await set('[aria-label="跳转结束日期"]','2027-01-15');await click('跳转')
      await wait("document.querySelector('.fc-col-header-cell[data-date]')?.getAttribute('data-date')==='2027-01-11'")
      await js("document.querySelector('.fc-jumpDate-button').click()")
      await set('[aria-label="跳转起始日期"]','2026-10-01');await set('[aria-label="跳转结束日期"]','2027-01-31');await click('跳转')
      await wait("document.querySelector('.fc-col-header-cell[data-date]')?.getAttribute('data-date')==='2026-09-28'")
      assert.deepEqual(await navigationPositions(),stablePositions,'跳转不同长度的日期时右侧按钮不移动')
      await js("document.querySelector('.fc-today-button').click()")
      assert.equal(await firstSlot(),'06:00:00','默认不显示六点前的空时间轴')
      const toggleSix=()=>js("document.querySelector('[aria-label=\"使用指定起始时间\"]').click()")
      await toggleSix();await wait("document.querySelector('.fc-timegrid-slot[data-time]')?.getAttribute('data-time')==='00:00:00'")
      await js("location.hash='/notes'");await wait("!document.querySelector('.fc-timeGridWeek-view')")
      await js("location.hash='/review'");await wait("!!document.querySelector('.fc-timeGridWeek-view')")
      assert.equal(await firstSlot(),'00:00:00','重新进入日程保留开关选择')
      await toggleSix();await wait("document.querySelector('.fc-timegrid-slot[data-time]')?.getAttribute('data-time')==='06:00:00'")
      const earlyStart=new Date();earlyStart.setHours(5,15,0,0)
      const early=await call('tasks','create',{title:'六点前的安排',planned_at:earlyStart.getTime(),planned_end_at:earlyStart.getTime()+1800000})
      await js("location.hash='/notes'");await wait("!document.querySelector('.fc-timeGridWeek-view')")
      await js("location.hash='/review'");await wait("document.querySelector('.fc-timegrid-slot[data-time]')?.getAttribute('data-time')==='05:00:00'")
      assert.equal(await js("!!document.querySelector('[aria-label=\"编辑日程：六点前的安排\"]')"),true)
      await capture('calendar-early-hours.png')
      await js(`document.querySelector('[aria-label="编辑日程：六点前的安排"]').click()`)
      await wait("!!document.querySelector('[aria-label=\"日程名称\"]')")
      await click('删除日程')
      await wait("document.querySelector('.fc-timegrid-slot[data-time]')?.getAttribute('data-time')==='06:00:00'")
      assert.equal((await call('tasks','listAll')).some(t=>t.id===early.id),false)
      await set('[aria-label="日程起始时间"]','07:15')
      await wait("document.querySelector('.fc-timegrid-slot[data-time]')?.getAttribute('data-time')==='07:15:00'")
      await set('[aria-label="日程起始时间"]','06:00')
      await js("window.discardChecks=0;window.confirm=()=>{window.discardChecks++;return false};true")
      await click('+ 新建日程');await js("document.querySelector('[aria-label=\"关闭日程编辑\"]').click()")
      assert.equal(await js("!!document.querySelector('.schedule-editor')"),false,'空白表单直接关闭')
      assert.equal(await js('window.discardChecks'),0)
      await click('+ 新建日程');await set('[aria-label="日程名称"]','暂未保存')
      await js("document.querySelector('[aria-label=\"关闭日程编辑\"]').click()")
      assert.equal(await js('window.discardChecks'),1)
      assert.equal(await js("document.querySelector('[aria-label=\"日程名称\"]').value"),'暂未保存','取消放弃保留内容')
      await js("window.confirm=()=>true;document.querySelector('[aria-label=\"关闭日程编辑\"]').click()")
      await click('+ 新建日程')
      await set('[aria-label="日程名称"]', '实验讨论')
      await set('[aria-label="日程地点"]', '实验室 301')
      const start = new Date()
      start.setHours(9, 0, 0, 0)
      const end = new Date(start)
      end.setHours(10)
      await set('[aria-label="日程开始"]', localTime(start))
      await set('[aria-label="日程结束"]', localTime(end))
      await click('保存日程')
      await wait('!!document.querySelector(\'[aria-label="编辑日程：实验讨论"]\')')
      await js("window.discardChecks=0;window.confirm=()=>{window.discardChecks++;return false};document.querySelector('[aria-label=\"编辑日程：实验讨论\"]').click()")
      await wait("!!document.querySelector('.schedule-editor')")
      await js("document.querySelector('[aria-label=\"关闭日程编辑\"]').click()")
      assert.equal(await js('window.discardChecks'),0,'已有日程未作修改直接关闭')
      assert.equal(await js("!!document.querySelector('.schedule-editor')"),false)
      await js("window.confirm=()=>true;true")
      assert.equal(
        await js(
          'document.querySelector(\'[aria-label="编辑日程：实验讨论"] .schedule-event-location\')?.textContent'
        ),
        '实验室 301'
      )
      assert.equal(
        await js(
          "(()=>{const buttons=document.querySelector('.schedule-heading-actions');return buttons.children[1].textContent==='导入课表'&&buttons.children[1].getBoundingClientRect().top>=buttons.children[0].getBoundingClientRect().bottom&&getComputedStyle(buttons.children[1]).backgroundColor==='rgb(255, 255, 255)'})()"
        ),
        true
      )
      assert.equal(
        await js(
          "(()=>{const e=document.querySelector('.fc-event');const channels=getComputedStyle(e).backgroundColor.match(/\\d+/g).map(Number);return channels.slice(0,3).every(c=>c>180)})()"
        ),
        true
      )
      const manual = (await call('tasks', 'listAll')).find((t) => t.title === '实验讨论')
      assert.equal(manual.planned_end_at - manual.planned_at, 3600000)
      await js('document.querySelector(\'[aria-label="编辑日程：实验讨论"]\').click()')
      await set('[aria-label="日程名称"]', '实验讨论（已编辑）')
      await set('[aria-label="日程说明"]', '携带讲义')
      await click('保存日程')
      await wait('document.querySelector(\'[aria-label="编辑日程：实验讨论（已编辑）"]\')')
      // Manual creation and editing use the same guarded save path as imports.
      await click('+ 新建日程')
      await set('[aria-label="日程名称"]', '手工重合日程')
      const manualOverlap = new Date(start.getTime() + 30 * 60000),
        manualOverlapEnd = new Date(end.getTime() + 30 * 60000)
      await set('[aria-label="日程开始"]', localTime(manualOverlap))
      await set('[aria-label="日程结束"]', localTime(manualOverlapEnd))
      await click('保存日程')
      await wait('!!document.querySelector(\'[aria-label="日程保存时间冲突"]\')')
      assert.equal((await call('tasks', 'listAll')).length, 1, '冲突未确认时不能创建日程')
      assert.equal(
        await js('document.querySelector(\'[aria-label="日程名称"]\').value'),
        '手工重合日程'
      )
      assert.equal(
        await js(
          "Array.from(document.querySelector('.schedule-editor').querySelectorAll('button')).find(b=>b.textContent.trim()==='保存日程').disabled"
        ),
        true
      )
      await capture('calendar-manual-conflicts.png')
      await js('document.querySelector(\'[aria-label="保存日程时忽略冲突"]\').click()')
      await click('保存日程')
      await wait("!document.querySelector('.schedule-editor')")
      const overlapped = (await call('tasks', 'listAll')).find((t) => t.title === '手工重合日程')
      assert.ok(overlapped)
      await wait('!!document.querySelector(\'[aria-label="编辑日程：手工重合日程"]\')')
      await js('document.querySelector(\'[aria-label="编辑日程：手工重合日程"]\').click()')
      const shiftedStart = new Date(start.getTime() + 15 * 60000)
      await set('[aria-label="日程开始"]', localTime(shiftedStart))
      await click('保存日程')
      await wait('!!document.querySelector(\'[aria-label="日程保存时间冲突"]\')')
      assert.equal(
        (await call('tasks', 'listAll')).find((t) => t.id === overlapped.id).planned_at,
        manualOverlap.getTime(),
        '未确认编辑保留原时间'
      )
      // Changing the time clears the stale acknowledgement and checks the replacement interval.
      await set('[aria-label="日程开始"]', localTime(end))
      await set('[aria-label="日程结束"]', localTime(manualOverlapEnd))
      await wait('!document.querySelector(\'[aria-label="日程保存时间冲突"]\')')
      await click('保存日程')
      await wait("!document.querySelector('.schedule-editor')")
      assert.equal(
        (await call('tasks', 'listAll')).find((t) => t.id === overlapped.id).planned_at,
        end.getTime(),
        '相邻日程不误报'
      )
      await call('tasks', 'remove', overlapped.id)
      await click('日')
      await wait("!!document.querySelector('.fc-timeGridDay-view')")
      await capture('calendar-day.png')
      await click('月')
      await wait("!!document.querySelector('.fc-dayGridMonth-view')")
      await capture('calendar-month.png')
      await click('周')
      await wait("!!document.querySelector('.fc-timeGridWeek-view')")
      const monday = new Date(start)
      monday.setDate(start.getDate() - ((start.getDay() + 6) % 7))
      monday.setHours(8, 0, 0, 0)
      const from = new Date(monday)
      from.setDate(from.getDate() - 1)
      const to = new Date(monday)
      to.setDate(to.getDate() + 21)
      const compact = (d) => d.toISOString().replace(/[-:]/g, '').replace('.000', '')
      const classEnd = new Date(monday.getTime() + 90 * 60000),
        allDay = new Date(monday)
      allDay.setDate(allDay.getDate() + 2)
      const sourceIcs = path.join(root, '学期课表.ics'),
        dateOnly = (d) => localDate(d).replaceAll('-', ''),
        nextDay = new Date(allDay)
      nextDay.setDate(nextDay.getDate() + 1)
      fs.writeFileSync(
        sourceIcs,
        `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:mechanics-course\r\nDTSTART:${compact(monday)}\r\nDTEND:${compact(classEnd)}\r\nRRULE:FREQ=WEEKLY;COUNT=2\r\nSUMMARY:理论力学课\r\nLOCATION:六教 301\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:lab-day\r\nDTSTART;VALUE=DATE:${dateOnly(allDay)}\r\nDTEND;VALUE=DATE:${dateOnly(nextDay)}\r\nSUMMARY:实验日\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`
      )
      selectedFile = sourceIcs
      const sourceIcsHash = hash(sourceIcs),
        range = { from: from.getTime(), to: to.getTime() }
      await js("document.querySelector('.schedule-import').open=true")
      await set('[aria-label="课表导入开始日期"]', localDate(from))
      await set('[aria-label="课表导入结束日期"]', localDate(new Date(to.getTime() - 86400000)))
      await click('选择 ICS 并预览')
      await wait("!!document.querySelector('.schedule-import-preview')")
      await click('取消导入')
      assert.equal((await call('tasks', 'listAll')).length, 1)
      await click('选择 ICS 并预览')
      await wait("!!document.querySelector('.schedule-import-preview')")
      await click('确认导入课表')
      await wait("!document.querySelector('.schedule-import-preview')")
      const imported = (await call('tasks', 'listAll')).filter((t) => t.id !== manual.id)
      assert.equal(imported.length, 3)
      const edited = imported.find((t) => t.title === '理论力学课'),
        deleted = imported.find((t) => t.title === '理论力学课' && t.id !== edited.id)
      await call('tasks', 'update', edited.id, { title: '已人工修改的课程' })
      // 重新进入日历后，找到另一节课程并通过界面删除。
      await js("location.hash='/notes'")
      await wait("document.querySelector('h1')?.textContent==='笔记'")
      await js("location.hash='/review'")
      await wait("!!document.querySelector('.fc-timeGridWeek-view')")
      if (!(await js('!!document.querySelector(\'[aria-label="编辑日程：理论力学课"]\')')))
        await js("document.querySelector('.fc-next-button').click()")
      await wait('!!document.querySelector(\'[aria-label="编辑日程：理论力学课"]\')')
      await js('document.querySelector(\'[aria-label="编辑日程：理论力学课"]\').click()')
      await wait('!!document.querySelector(\'[aria-label="日程名称"]\')')
      await click('删除日程')
      await wait(
        `window.api.tasks.listAll().then(r=>!r.data.some(t=>t.id===${JSON.stringify(deleted.id)}))`
      )
      const again = await call('calendar', 'preview', range)
      assert.deepEqual(await call('calendar', 'import', again.token), { added: 0, skipped: 3 })
      assert.equal(
        (await call('tasks', 'listAll')).find((t) => t.id === edited.id).title,
        '已人工修改的课程'
      )
      assert.equal(hash(sourceIcs), sourceIcsHash)
      saveFile = path.join(
        fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'learning-calendar-export-')),
        '日程.ics'
      )
      await click('导出全部日程（ICS）')
      await wait("document.body.innerText.includes('已导出')")
      const exported = fs.readFileSync(saveFile, 'utf8')
      assert.match(exported, /BEGIN:VCALENDAR/)
      assert.match(exported, /实验讨论/)
      assert.match(exported, /携带讲义/)
      selectedFile = saveFile
      const roundTrip = await call('calendar', 'preview', range)
      assert.deepEqual(await call('calendar', 'import', roundTrip.token), { added: 0, skipped: 3 })
      // Existing and same-file overlaps require an explicit UI acknowledgement.
      const overlapping = path.join(root, '冲突课表.ics'),
        overlapStart = new Date(start.getTime() + 30 * 60000),
        overlapEnd = new Date(end.getTime() + 30 * 60000)
      fs.writeFileSync(
        overlapping,
        `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${['冲突课程一', '冲突课程二'].map((title, i) => `BEGIN:VEVENT\r\nUID:conflict-${i}\r\nDTSTART:${compact(overlapStart)}\r\nDTEND:${compact(overlapEnd)}\r\nSUMMARY:${title}\r\nLOCATION:六教 302\r\nEND:VEVENT`).join('\r\n')}\r\nEND:VCALENDAR`
      )
      selectedFile = overlapping
      await click('导入课表')
      await set('[aria-label="课表导入开始日期"]', localDate(from))
      await set('[aria-label="课表导入结束日期"]', localDate(new Date(to.getTime() - 86400000)))
      await click('选择 ICS 并预览')
      await wait('!!document.querySelector(\'[aria-label="导入时间冲突"]\')')
      await capture('calendar-conflicts.png')
      assert.equal(
        await js(
          "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='确认导入课表').disabled"
        ),
        true
      )
      assert.equal(
        await js(
          "document.querySelector('[aria-label=\"导入时间冲突\"]').textContent.includes('本批课表')"
        ),
        true
      )
      const unconfirmed = await call('tasks', 'listAll')
      await js('document.querySelector(\'[aria-label="忽略冲突"]\').click()')
      await click('确认导入课表')
      await wait("!document.querySelector('.schedule-import-preview')")
      const conflictsAdded = (await call('tasks', 'listAll')).filter(
        (t) => !unconfirmed.some((old) => old.id === t.id)
      )
      assert.equal(conflictsAdded.length, 2)
      for (const task of conflictsAdded) await call('tasks', 'remove', task.id)
      // 事务中途故障不能留下半份课表；同一预览可在解除故障后重试。
      const rollback = path.join(root, '回滚.ics')
      fs.writeFileSync(
        rollback,
        fs
          .readFileSync(sourceIcs, 'utf8')
          .replaceAll('mechanics-course', 'rollback-course')
          .replaceAll('lab-day', 'rollback-lab')
          .replaceAll('理论力学课', '正常课程')
          .replaceAll('实验日', '回滚课程')
      )
      selectedFile = rollback
      const preview = await call('calendar', 'preview', range),
        before = (await call('tasks', 'listAll')).length
      assert.ok(preview.conflicts.items.length > 0)
      assert.ok((await call('calendar', 'import', preview.token)).conflicts, '不能绕过冲突确认')
      const stale = await call('tasks', 'create', {
        title: '预览后新增的安排',
        planned_at: monday.getTime(),
        planned_end_at: classEnd.getTime()
      })
      const changed = await call('calendar', 'import', preview.token, {
        ignore_conflicts: true,
        conflict_fingerprint: preview.conflicts.fingerprint
      })
      assert.ok(changed.conflicts, '过期的冲突确认必须重新审核')
      assert.equal((await call('tasks', 'listAll')).length, before + 1)
      await call('tasks', 'remove', stale.id)
      const freshConflicts = (await call('calendar', 'import', preview.token)).conflicts
      const approval = { ignore_conflicts: true, conflict_fingerprint: freshConflicts.fingerprint }
      const db = new (require('better-sqlite3'))(path.join(root, 'learning-assistant.db'))
      db.exec(
        "CREATE TRIGGER fail_calendar BEFORE INSERT ON tasks WHEN NEW.title='回滚课程' BEGIN SELECT RAISE(ABORT,'simulated import failure'); END"
      )
      assert.equal(
        (
          await js(
            `window.api.calendar.import(${JSON.stringify(preview.token)},${JSON.stringify(approval)})`
          )
        ).ok,
        false
      )
      assert.equal((await call('tasks', 'listAll')).length, before)
      db.exec('DROP TRIGGER fail_calendar')
      db.close()
      assert.equal((await call('calendar', 'import', preview.token, approval)).added, 3)
      await js("location.hash='/notes'")
      await wait("document.querySelector('h1')?.textContent==='笔记'")
      await js("location.hash='/review'")
      await wait("!!document.querySelector('.fc-timeGridWeek-view')")
      await wait('!!document.querySelector(\'[aria-label="编辑日程：实验讨论（已编辑）"]\')')
      await capture('calendar-week.png')
      win.setSize(1024, 768)
      await pause(100)
      assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true)
      await js("location.hash='/settings'");await wait("document.querySelector('h1')?.textContent==='设置'")
      await click('个性化');await wait("!!document.querySelector('.settings-preferences')")
      assert.equal(await js("(()=>{const r=document.querySelector('.settings-preferences').getBoundingClientRect(),p=document.querySelector('.page').getBoundingClientRect();return Math.abs(r.width-(p.width-48))<2})()"),true,'个性化条目使用页面全宽')
      await capture('settings-preferences-full-width.png')
      fs.writeFileSync(
        path.join(root, 'calendar-checkpoint.json'),
        JSON.stringify({
          manual: manual.id,
          edited: edited.id,
          deleted: deleted.id,
          material: material.id,
          note: note.id,
          block: block.id,
          ics: sourceIcs,
          range
        })
      )
      console.log(
        'CALENDAR_NATIVE_OK material UI rename/move/trash/restore, day/week/month, task UI edit, ICS preview/cancel/import/export, worker, duplicate/deletion protection and transactional rollback'
      )
      clearTimeout(deadline)
      app.exit(0)
    } catch (error) {
      console.error(error.stack || error)
      clearTimeout(deadline)
      app.exit(1)
    }
  })
)
require('../out/main/index.js')
