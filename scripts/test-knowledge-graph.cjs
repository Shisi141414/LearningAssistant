// Actual React Flow canvas, relationship editing, learning backlinks and persisted layout.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict')
if (!process.versions.electron) {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'learning-assistant-graph-')),
    env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  for (const phase of ['first', 'resume']) {
    const result = require('node:child_process').spawnSync(
      require('electron'),
      [__filename, root, phase],
      { env, windowsHide: true, encoding: 'utf8', timeout: 75000 }
    )
    process.stdout.write(result.stdout || '')
    process.stderr.write(result.stderr || '')
    if (result.error) throw result.error
    assert.equal(result.status, 0, '图谱验收失败：' + phase)
  }
  console.log('KNOWLEDGE_GRAPH_ROOT ' + root)
  process.exit(0)
}
const electron = require('electron'),
  { app } = electron,
  root = process.argv[2],
  phase = process.argv[3],
  remote = []
app.disableHardwareAcceleration()
app.setPath('userData', root)
app.setPath('sessionData', root)
class HiddenWindow extends electron.BrowserWindow {
  constructor(options) {
    super({
      ...options,
      width: 1360,
      height: 900,
      show: false,
      webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false }
    })
  }
  show() {}
}
const Module = require('node:module'),
  load = Module._load
Module._load = function (request, parent, main) {
  return request === 'electron'
    ? { ...electron, BrowserWindow: HiddenWindow }
    : load.call(this, request, parent, main)
}
const deadline = setTimeout(() => {
  console.error('KNOWLEDGE_GRAPH_TIMEOUT')
  app.exit(2)
}, 70000)
app.on('browser-window-created', (_event, win) => {
  win.webContents.session.webRequest.onBeforeRequest(
    { urls: ['https://*/*', 'http://*/*'] },
    (request, callback) => {
      remote.push(request.url)
      callback({ cancel: true })
    }
  )
  win.webContents.once('did-finish-load', async () => {
    const js = (code) =>
      win.webContents.executeJavaScript(code).catch((error) => {
        throw Error(error.message + '\n表达式：' + code.slice(0, 500))
      })
    const call = async (group, method, ...args) => {
      const result = await js(
        `window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`
      )
      assert.equal(result.ok, true, result.error)
      return result.data
    }
    const wait = async (code) => {
      const end = Date.now() + 9000
      while (!(await js(code))) {
        if (Date.now() > end)
          throw Error('等待失败：' + code + '\n' + (await js('document.body.innerText')))
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
    }
    const set = (label, value) =>
      js(
        `(()=>{const e=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');if(!e)throw Error('缺少 '+${JSON.stringify(label)});const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));return true})()`
      )
    const click = (label, scope = '.page') =>
      js(
        `(()=>{const b=Array.from(document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')).find(item=>item.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)throw Error('按钮不可用：'+${JSON.stringify(label)});b.click();return true})()`
      )
    const capture = async (name) => {
      await js("document.querySelector('.page').scrollTop=0;document.fonts.ready.then(()=>true)")
      await js(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))'
      )
      await new Promise((resolve) => {
        win.webContents.once('paint', resolve)
        win.webContents.invalidate()
      })
      fs.writeFileSync(path.join(root, name), (await win.webContents.capturePage()).toPNG())
    }
    const connect = async (a, b, kind, memo, expected = '关系已保存') => {
      await click('新建另一关系')
      await set('关系起点知识', a)
      await set('关系终点知识', b)
      await set('知识关系类型', kind)
      await set('知识关系说明', memo)
      await click('保存关系')
      await wait(
        `document.body.innerText.includes(${JSON.stringify(expected)}) && !document.querySelector('.graph-relation-editor fieldset').disabled`
      )
    }
    try {
      await wait('!!window.api')
      if (phase === 'resume') {
        const saved = JSON.parse(fs.readFileSync(path.join(root, 'checkpoint.json'), 'utf8')),
          graph = await call('concepts', 'graph')
        assert.deepEqual(graph.positions, saved.positions)
        assert.equal(graph.relations.length, 2)
        assert.equal(
          graph.relations.find((edge) => edge.from_id === saved.a && edge.to_id === saved.b).memo,
          '更新后的前置说明'
        )
        assert.equal((await call('concepts', 'usage', { concept_id: saved.a })).total, 3)
        await js(`location.hash='/knowledge/graph?concept=${saved.a}'`)
        await wait("document.querySelectorAll('.react-flow__node').length>=3")
        assert.match(
          await js("document.querySelector('.graph-details').innerText"),
          /动量复习题|振动测量/
        )
        assert.deepEqual(remote, [])
        console.log(
          'KNOWLEDGE_GRAPH_RESTART_OK relation revisions, manual layout and learning backlinks'
        )
        clearTimeout(deadline)
        app.exit(0)
        return
      }
      const subjects = await call('subjects', 'list'),
        make = (name, subject_id, aliases = []) =>
          call('concepts', 'save', { name, subject_id, aliases, summary: '保留适用条件与教材证据' })
      const a = await make('动量守恒', subjects[0].id, ['动量不变']),
        b = await make('碰撞模型', subjects[1].id),
        c = await make('冲量定理', subjects[1].id),
        d = await make('线性代数', subjects[0].id)
      const project = await call('projects', 'create', {
          title: '振动测量',
          subject_id: subjects[1].id
        }),
        task = await call('tasks', 'create', {
          project_id: project.id,
          title: '校验测量模型',
          knowledge_refs: [{ concept_id: a.id, why: '用动量变化验证测量模型' }]
        })
      const manual = await call('tasks', 'create', {
        title: '补学动量应用',
        knowledge_refs: [{ concept_id: a.id, why: '明确系统边界' }]
      })
      const exercise = await call('exercises', 'save', {
        title: '动量复习题',
        subject_id: subjects[1].id,
        status: 'wrong',
        question_type: '计算',
        source_label: '隔离教材',
        no_idea: false,
        review_concept_ids: [a.id],
        fields: {
          statement: '求系统的总动量。',
          approach: '',
          standard_answer: '',
          user_answer: '',
          error_reason: '系统边界不清'
        }
      })
      await js(`location.hash='/knowledge/graph?concept=${a.id}'`)
      await wait("document.querySelectorAll('.react-flow__node').length===4")
      await connect(a.id, b.id, 'prerequisite', '先确定动量，再建立碰撞模型')
      await connect(b.id, c.id, 'prerequisite', '应用到冲量变化')
      await connect(a.id, d.id, 'related', '从代数表达看守恒约束')
      await connect(c.id, a.id, 'prerequisite', '非法回路', '前置知识形成循环')
      await wait("document.querySelector('[role=alert]')?.textContent.includes('循环')")
      assert.equal((await call('concepts', 'graph')).relations.length, 3)
      await click('新建另一关系')
      await set('选择图谱知识点', a.id)
      await wait("document.querySelector('.concept-usage').innerText.includes('校验测量模型')")
      assert.match(
        await js("document.querySelector('.graph-details').innerText"),
        /用动量变化验证测量模型/
      )
      await js(
        `Array.from(document.querySelectorAll('.graph-relations button')).find(b=>b.textContent.includes('碰撞模型')).click();true`
      )
      await wait('document.querySelector(\'[aria-label="关系起点知识"]\').disabled')
      await set('知识关系说明', '更新后的前置说明')
      await click('保存关系')
      await wait(
        "document.body.innerText.includes('关系已保存')&&!document.querySelector('.graph-relation-editor fieldset').disabled"
      )
      await click('自动排布当前范围')
      await wait(
        "document.body.innerText.includes('当前范围已自动排布并保存')&&!document.querySelector('.graph-relation-editor fieldset').disabled"
      )
      await capture('knowledge-graph.png')
      const before = (await call('concepts', 'graph')).positions.find((p) => p.concept_id === a.id)
      await js(`document.querySelector('.react-flow__node[data-id="${a.id}"]').focus();true`)
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
      await wait(
        `window.api.concepts.graph().then(r=>r.ok&&r.data.positions.find(p=>p.concept_id===${JSON.stringify(a.id)})?.x>${before.x})`
      )
      await wait("!document.querySelector('.graph-relation-editor fieldset').disabled")
      await js(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))'
      )
      // Real pointer drag, not direct service invocation.
      await js("document.querySelector('.knowledge-graph-page').scrollTop=0;true")
      const box = await js(
        `(()=>{const b=document.querySelector('.react-flow__node[data-id="${a.id}"]').getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`
      )
      const current = (await call('concepts', 'graph')).positions.find((p) => p.concept_id === a.id)
      // First motion crosses React Flow's drag threshold; the next motion changes position.
      win.webContents.sendInputEvent({ type: 'mouseMove', x: box.x, y: box.y })
      win.webContents.sendInputEvent({
        type: 'mouseDown',
        x: box.x,
        y: box.y,
        button: 'left',
        clickCount: 1
      })
      win.webContents.sendInputEvent({ type: 'mouseMove', x: box.x + 8, y: box.y + 8 })
      await js('new Promise(resolve=>requestAnimationFrame(()=>resolve(true)))')
      win.webContents.sendInputEvent({ type: 'mouseMove', x: box.x + 45, y: box.y + 30 })
      await js('new Promise(resolve=>requestAnimationFrame(()=>resolve(true)))')
      win.webContents.sendInputEvent({
        type: 'mouseUp',
        x: box.x + 45,
        y: box.y + 30,
        button: 'left',
        clickCount: 1
      })
      await wait(
        `window.api.concepts.graph().then(r=>r.ok&&r.data.positions.find(p=>p.concept_id===${JSON.stringify(a.id)})?.y!==${current.y})`
      )
      await set('图谱学科', subjects[0].id)
      await wait("document.querySelector('.graph-caption').textContent.includes('2 / 4')")
      await set('图谱学科', 'all')
      await set('搜索图谱知识', '动量不变')
      await wait("document.querySelector('.graph-caption').textContent.includes('1 / 4')")
      await set('搜索图谱知识', '')
      await set('图谱关系筛选', 'cross')
      await wait("document.querySelectorAll('.react-flow__edge').length===1")
      await set('图谱关系筛选', 'all')
      await set('选择图谱知识点', a.id)
      await js("document.querySelector('.graph-caption input[type=checkbox]').click();true")
      await wait("document.querySelector('.graph-caption').textContent.includes('3 / 4')")
      await js("document.querySelector('.graph-caption input[type=checkbox]').click();true")
      const all = (await call('concepts', 'graph')).relations,
        related = all.find((edge) => edge.relation === 'related')
      await js('window.confirm=()=>true;true')
      await js(
        "Array.from(document.querySelectorAll('.graph-relations button')).find(b=>b.textContent.includes('线性代数')).click();true"
      )
      await click('删除关系')
      await wait(
        "document.body.innerText.includes('关系已删除')&&!document.querySelector('.graph-relation-editor fieldset').disabled"
      )
      assert.equal((await call('concepts', 'graph')).relations.length, 2)
      // A relation removal must leave the knowledge entity and aliases intact.
      assert.ok((await call('concepts', 'list')).find((item) => item.id === d.id))
      assert.ok(related)
      await js(
        "Array.from(document.querySelectorAll('.concept-usage a')).find(a=>a.textContent==='查看相关习题').click();true"
      )
      await wait("!!document.querySelector('.exercise-list-item')")
      assert.match(await js("document.querySelector('.exercise-list').innerText"), /动量复习题/)
      assert.equal(await js('document.querySelector(\'[aria-label="习题学科筛选"]\').value'), 'all')
      await js("document.querySelector('.exercise-list-item').click();true")
      await wait("document.querySelector('h1')?.textContent==='动量复习题'")
      await js(`location.hash='/knowledge?concept=${a.id}'`)
      await wait("document.querySelector('.concept-usage')?.innerText.includes('校验测量模型')")
      await js(`document.querySelector('.concept-usage a[href*="${task.id}"]').click();true`)
      await wait(`!!document.getElementById('project-task-${task.id}')`)
      assert.equal(
        await js(
          `document.getElementById('project-task-${task.id}').classList.contains('evidence-target')`
        ),
        true
      )
      await js(`document.querySelector('#project-task-${task.id} a[href*=knowledge]').click();true`)
      await wait("document.querySelector('.concept-usage')?.innerText.includes('补学动量应用')")
      await js(`document.querySelector('.concept-usage a[href*="${manual.id}"]').click();true`)
      await wait("document.querySelector('.schedule-editor')?.innerText.includes('编辑日程')")
      assert.equal(
        await js("document.querySelector('.schedule-editor input').value"),
        '补学动量应用'
      )
      await js(`location.hash='/knowledge/graph?concept=${a.id}'`)
      await wait("document.querySelectorAll('.react-flow__node').length===4")
      win.setContentSize(1024, 768)
      // Windows offscreen resize can round a client pixel at the window boundary.
      await wait('Math.abs(innerWidth-1024)<=2')
      assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true)
      await capture('knowledge-graph-1024.png')
      const positions = (await call('concepts', 'graph')).positions
      fs.writeFileSync(
        path.join(root, 'checkpoint.json'),
        JSON.stringify({ a: a.id, b: b.id, positions, exercise: exercise.id })
      )
      assert.deepEqual(remote, [])
      console.log(
        'KNOWLEDGE_GRAPH_NATIVE_OK React Flow form/cycles, Dagre, keyboard and pointer layout, cross-subject filters, exercise and project/task round trips, 1024 layout'
      )
      clearTimeout(deadline)
      app.exit(0)
    } catch (error) {
      console.error(error.stack || error)
      clearTimeout(deadline)
      app.exit(1)
    }
  })
})
require('../out/main/index.js')
