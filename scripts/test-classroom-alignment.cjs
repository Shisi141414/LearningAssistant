// Real Electron + SQLite + worker + React; interrupted processing is recovered in a second process.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict')
if (!process.versions.electron) {
  const root = fs.mkdtempSync(
    path.join(
      require('node:os').tmpdir(),
      'learning-assistant-classroom-alignment-'
    )
  )
  for (const phase of ['first', 'resume']) {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const result = require('node:child_process').spawnSync(
      require('electron'),
      [__filename, root, phase],
      { env, windowsHide: true, encoding: 'utf8', timeout: 130_000 }
    )
    process.stdout.write(result.stdout || '')
    process.stderr.write(result.stderr || '')
    if (result.error) throw result.error
    if (phase === 'first') {
      assert.ok(
        result.stdout.includes('CLASSROOM_ALIGNMENT_CRASH_READY'),
        '首次进程未完成验收或未进入中断点'
      )
      assert.notEqual(result.status, 0, '首次进程应模拟强制中断')
    } else assert.equal(result.status, 0, '课堂自动定位验收失败：' + phase)
  }
  console.log('CLASSROOM_ALIGNMENT_NATIVE_OK', root)
  process.exit(0)
}
const electron = require('electron'),
  { app } = electron
const root = process.argv[2],
  phase = process.argv[3]
app.disableHardwareAcceleration()
app.setPath('userData', root)
app.setPath('sessionData', root)
const contents = [
  '动量定理描述合外力冲量等于质点动量的变化，速度与质量相乘得到动量。',
  '刚体绕固定轴转动时，角速度和转动惯量共同决定角动量，外力矩改变转动状态。',
  '理想气体状态方程联系压强体积温度，气体常数反映单位物质的量的热力学性质。',
  '矩阵特征值通过特征多项式计算，对角化要求存在完备线性无关的特征向量。',
  '傅里叶级数使用三角函数展开周期信号，正交性可以求得各项系数。',
  '泊松括号描述哈密顿系统的正则结构，守恒量与对称性之间存在联系。',
  '复变函数围道积分遵循留数定理，孤立奇点的留数决定积分结果。',
  '流体连续性方程反映质量守恒，流速和截面积互相制约。',
  '熵增原理限制孤立系统演化方向，不可逆过程产生正的熵增。'
]
let holdText = '',
  held = false,
  organizedRequest = '',
  releaseAlignment = null
let delayPosition = false,
  positionHeld = false,
  releasePosition = null,
  alignmentReview = false
const threads = require('node:worker_threads')
class DelayedWorker extends threads.Worker {
  postMessage(message, ...args) {
    if (holdText && message.text === holdText) {
      held = true
      releaseAlignment = () => super.postMessage(message, ...args)
      return
    }
    return super.postMessage(message, ...args)
  }
}
class HiddenWindow extends electron.BrowserWindow {
  constructor(options) {
    super({
      ...options,
      width: 1024,
      height: 768,
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
  if (request === 'node:worker_threads')
    return { ...threads, Worker: DelayedWorker }
  if (request === 'electron')
    return {
      ...electron,
      BrowserWindow: HiddenWindow,
      ipcMain: {
        on: electron.ipcMain.on.bind(electron.ipcMain),
        handle: (channel, handler) =>
          electron.ipcMain.handle(channel, async (...args) => {
            const result = await handler(...args)
            if (channel === 'classroom:alignment')
              alignmentReview =
                result.ok && result.data.jobs[0]?.status === 'review'
            if (
              channel === 'classroom:position' &&
              delayPosition &&
              alignmentReview
            ) {
              delayPosition = false
              positionHeld = true
              await new Promise((resolve) => {
                releasePosition = resolve
              })
            }
            return result
          })
      }
    }
  return load.call(this, request, parent, isMain)
}
globalThis.fetch = async (url, options) => {
  assert.ok(
    String(url).startsWith('https://alignment-fixture.invalid'),
    '意外外网请求'
  )
  organizedRequest = options.body
  return new Response(
    'data: ' +
      JSON.stringify({
        type: 'content_block_delta',
        delta: {
          text: JSON.stringify({
            seg_type: 'definition',
            organized_text: '保留老师原始讲授，并参照教材校正术语。'
          })
        }
      }) +
      '\n\n'
  )
}
const deadline = setTimeout(() => {
  console.error('CLASSROOM_ALIGNMENT_TIMEOUT')
  app.exit(2)
}, 120_000)
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code)
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const call = async (group, method, ...args) => {
      const result = await js(
        `window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`
      )
      assert.equal(result.ok, true, result.error)
      return result.data
    }
    const wait = async (read, label) => {
      const limit = Date.now() + 12_000
      while (!(await read())) {
        if (Date.now() > limit)
          throw Error(
            '等待失败：' + label + '\n' + (await js('document.body.innerText'))
          )
        await pause(40)
      }
    }
    const click = (label) =>
      js(
        `(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)throw Error('按钮不可操作：'+${JSON.stringify(label)});b.click();return true})()`
      )
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
      await pause(60)
      await js(
        `(()=>{const e=document.querySelector('[aria-label="课堂手动记录"]'),d=new DataTransfer();d.setData('text/plain',${JSON.stringify(text)});e.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}));return true})()`
      )
      await click('添加段落')
      await wait(
        () =>
          js(
            `document.querySelector('[aria-label="课堂手动记录"]').textContent===''`
          ),
        '手动记录已保存'
      )
    }
    let db
    try {
      await wait(() => js('!!window.api'), '接口就绪')
      db = new (require('better-sqlite3'))(
        path.join(root, 'learning-assistant.db')
      )
      if (phase === 'resume') {
        const saved = JSON.parse(
          fs.readFileSync(path.join(root, 'checkpoint.json'), 'utf8')
        )
        const recovered = db
          .prepare('SELECT * FROM classroom_alignment_jobs WHERE segment_id=?')
          .get(saved.interrupted)
        assert.equal(recovered.status, 'cancelled')
        assert.match(recovered.reason, /中断/)
        assert.equal(
          (await call('notes', 'get', saved.note)).segments.find(
            (s) => s.id === saved.interrupted
          ).raw_text,
          contents[5]
        )
        assert.equal(
          (await call('classroom', 'position', saved.note)).block.id,
          'b8'
        )
        assert.equal(
          (await call('notes', 'get', saved.note)).segments.find(
            (s) => s.id === saved.automatic
          ).material_ref.id,
          'b1'
        )
        await js(
          `location.hash=${JSON.stringify('/classroom?note=' + saved.note)}`
        )
        await wait(
          () =>
            js(
              `Array.from(document.querySelectorAll('button')).some(e=>e.textContent==='继续课堂'&&!e.disabled)`
            ),
          '课堂恢复'
        )
        await click('继续课堂')
        await wait(
          () =>
            js(
              `!!document.querySelector('[aria-label="自动跟随教材"]:checked')`
            ),
          '跟随设置恢复'
        )
        await manual(contents[8])
        await wait(
          () =>
            Promise.resolve(
              db
                .prepare(
                  "SELECT count(*) AS n FROM classroom_alignment_jobs WHERE session_id=(SELECT id FROM classroom_sessions ORDER BY rowid DESC LIMIT 1) AND status='applied'"
                )
                .get().n === 1
            ),
          '恢复课堂后的新语段'
        )
        assert.equal(
          (await call('notes', 'get', saved.note)).segments.find(
            (s) => s.id === saved.automatic
          ).material_ref.id,
          'b1'
        )
        await call('classroom', 'stop')
      } else {
        await call('config', 'set', 'classroom.autoOrganize', '0')
        await call('config', 'set', 'asr.model_dir', '')
        const provider = await call('providers', 'save', {
          name: '定位验收模型',
          base_url: 'https://alignment-fixture.invalid',
          api_format: 'anthropic',
          api_key: 'fixture'
        })
        await call('models', 'save', {
          provider_id: provider.id,
          model_id: 'fixture'
        })
        db.exec(
          "INSERT INTO materials(id,title,kind,created_at) VALUES('m','力学教材','textbook',1); INSERT INTO material_versions(id,material_id,file_name,format,file_path,fingerprint,status,created_at) VALUES('v','m','lecture.docx','docx','unused.docx','hash','ready',1); UPDATE materials SET current_version_id='v' WHERE id='m'"
        )
        for (let ordinal = 0; ordinal < contents.length; ordinal++)
          db.prepare(
            'INSERT INTO material_blocks(id,version_id,ordinal,text,locator_json) VALUES(?,?,?,?,?)'
          ).run(
            'b' + ordinal,
            'v',
            ordinal,
            contents[ordinal],
            JSON.stringify({ kind: 'docx', paragraph: ordinal })
          )
        const note = await call('notes', 'create', {
          title: '自动教材定位验收',
          source: 'class'
        })
        await call('classroom', 'calibrate', {
          note_id: note.id,
          block_id: 'b0'
        })
        await js(
          `location.hash=${JSON.stringify('/classroom?note=' + note.id)}`
        )
        await wait(
          () =>
            js(
              `Array.from(document.querySelectorAll('button')).some(e=>e.textContent==='继续课堂'&&!e.disabled)`
            ),
          '开始课堂'
        )
        await click('继续课堂')
        await wait(
          () =>
            js(
              `!!document.querySelector('[aria-label="自动跟随教材"]:not(:disabled)')`
            ),
          '自动定位控件'
        )
        assert.equal(
          await js(
            `document.querySelector('[aria-label="自动跟随教材"]').checked`
          ),
          false
        )
        await js(
          `document.querySelector('[aria-label="自动跟随教材"]').click();void 0`
        )
        await wait(
          () =>
            js(`document.querySelector('[aria-label="自动跟随教材"]').checked`),
          '启用跟随'
        )
        await manual(contents[0])
        await wait(
          () =>
            Promise.resolve(
              db
                .prepare(
                  "SELECT count(*) AS n FROM classroom_alignment_jobs WHERE status='applied'"
                )
                .get().n === 1
            ),
          '首段保持起点'
        )
        holdText = contents[1]
        const automatic = await call('notes', 'addSegment', {
          note_id: note.id,
          raw_text: contents[1]
        })
        win.webContents.send('classroom:final', {
          text: automatic.raw_text,
          segment: automatic
        })
        const backlogText = contents[1] + '我们然后'
        const backlog = await call('notes', 'addSegment', {
          note_id: note.id,
          raw_text: backlogText
        })
        win.webContents.send('classroom:final', {
          text: backlog.raw_text,
          segment: backlog
        })
        await wait(() => Promise.resolve(held), '教材匹配进入等待')
        const organizing = call('classroom', 'organizeSegment', automatic.id)
        await pause(100)
        assert.equal(
          organizedRequest,
          '',
          '教材尚未匹配完成，不应提前启动整理请求'
        )
        holdText = backlogText
        held = false
        releaseAlignment()
        releaseAlignment = null
        await wait(
          () =>
            js(
              `document.querySelector('.classroom-current').textContent.includes('条目 2')`
            ),
          '自动推进教材'
        )
        await organizing
        await wait(() => Promise.resolve(held), '同一页的后续匹配进入等待')
        await wait(
          () =>
            js(
              `document.querySelector('.classroom-backlinks summary')?.textContent.includes('（1）')`
            ),
          '首个自动来源回链'
        )
        holdText = ''
        held = false
        releaseAlignment()
        releaseAlignment = null
        await wait(
          () =>
            js(
              `document.querySelector('.classroom-backlinks summary')?.textContent.includes('（2）')`
            ),
          '位置未变时刷新后续来源回链'
        )
        assert.ok(
          organizedRequest.includes('讲授位置] ' + contents[1]),
          '整理请求应使用新匹配教材上下文'
        )
        assert.equal(
          db
            .prepare(
              'SELECT block_id FROM segment_material_refs WHERE segment_id=?'
            )
            .get(automatic.id).block_id,
          'b0'
        )
        assert.equal(
          (await call('notes', 'get', note.id)).segments.find(
            (s) => s.id === automatic.id
          ).material_ref.id,
          'b1'
        )
        await click('上一条')
        await wait(
          () =>
            js(
              `document.querySelector('.classroom-material h3').textContent.includes('条目 1')`
            ),
          '浏览历史教材'
        )
        await manual(contents[2])
        await wait(
          () =>
            js(
              `document.querySelector('.classroom-current').textContent.includes('条目 3')`
            ),
          '后台定位继续'
        )
        assert.ok(
          await js(
            `document.querySelector('.classroom-material h3').textContent.includes('条目 1')`
          ),
          '自动定位不得抢走历史浏览位置'
        )
        await click('回到讲授位置')
        await wait(
          () =>
            js(
              `document.querySelector('.classroom-material h3').textContent.includes('条目 3')`
            ),
          '恢复显示跟随'
        )
        delayPosition = true
        await manual(contents[8])
        await wait(
          () =>
            js(
              `document.querySelector('[aria-label="教材自动定位"]').textContent.includes('可能跳页')`
            ),
          '低把握跳页提示'
        )
        await wait(
          () => Promise.resolve(positionHeld),
          '校准前的位置读取响应暂缓'
        )
        assert.equal(
          (await call('classroom', 'position', note.id)).block.id,
          'b2'
        )
        await pause(100)
        fs.writeFileSync(
          path.join(root, 'alignment-review.png'),
          (await win.webContents.capturePage()).toPNG()
        )
        assert.equal(
          await js('document.documentElement.scrollWidth<=innerWidth'),
          true
        )
        await js(
          `document.querySelector('.alignment-review summary').click();void 0`
        )
        await pause(100)
        fs.writeFileSync(
          path.join(root, 'alignment-candidates.png'),
          (await win.webContents.capturePage()).toPNG()
        )
        await click('上一条')
        await click('按此校准')
        await wait(
          () =>
            js(
              `document.querySelector('.classroom-current').textContent.includes('条目 9')`
            ),
          '候选手动校准'
        )
        await wait(
          () =>
            js(
              `document.querySelector('.classroom-material h3').textContent.includes('条目 9')`
            ),
          '显式校准恢复教材显示跟随'
        )
        releasePosition()
        releasePosition = null
        await pause(150)
        assert.ok(
          await js(
            `document.querySelector('.classroom-current').textContent.includes('条目 9')`
          ),
          '校准之前发起的旧位置响应不得覆盖人工位置'
        )
        await wait(
          () =>
            js(
              `document.querySelector('[aria-label="教材自动定位"]').textContent.includes('等待新的课堂语段')`
            ),
          '手动校准后不沿用旧判断作为当前状态'
        )
        assert.equal(
          (await call('notes', 'get', note.id)).segments.find(
            (s) => s.id === automatic.id
          ).material_ref.id,
          'b1'
        )
        holdText = contents[5]
        const interrupted = await call('notes', 'addSegment', {
          note_id: note.id,
          raw_text: holdText
        })
        await wait(() => Promise.resolve(held), '匹配正在进行')
        assert.equal(
          db
            .prepare(
              'SELECT status FROM classroom_alignment_jobs WHERE segment_id=?'
            )
            .get(interrupted.id).status,
          'running'
        )
        fs.writeFileSync(
          path.join(root, 'checkpoint.json'),
          JSON.stringify({
            note: note.id,
            automatic: automatic.id,
            interrupted: interrupted.id
          })
        )
        db.close()
        process.stdout.write('CLASSROOM_ALIGNMENT_CRASH_READY\n', () =>
          process.kill(process.pid, 'SIGKILL')
        )
        return
      }
      console.log('CLASSROOM_ALIGNMENT_PHASE_OK', phase)
      db.close()
      clearTimeout(deadline)
      app.exit(0)
    } catch (error) {
      console.error(error)
      if (db?.open) db.close()
      clearTimeout(deadline)
      app.exit(1)
    }
  })
})
require(path.join(__dirname, '../out/main/index.js'))
