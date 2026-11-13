// Isolated Electron acceptance: all four source pages, immutable entry links, edits and restart.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict')
if (!process.versions.electron) {
  const root = fs.mkdtempSync(
    path.join(require('node:os').tmpdir(), 'learning-assistant-task-resources-')
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  for (const phase of ['first', 'resume']) {
    const result = require('node:child_process').spawnSync(
      require('electron'),
      [__filename, root, phase],
      { env, windowsHide: true, encoding: 'utf8', timeout: 120_000 }
    )
    process.stdout.write(result.stdout || '')
    process.stderr.write(result.stderr || '')
    if (result.error) throw result.error
    assert.equal(result.status, 0, '任务资料验收失败：' + phase)
  }
  console.log('TASK_RESOURCES_NATIVE_ROOT ' + root)
} else {
  const electron = require('electron'),
    { app } = electron,
    root = process.argv[2],
    phase = process.argv[3]
  const data = path.join(root, 'data')
  fs.mkdirSync(data, { recursive: true })
  app.disableHardwareAcceleration()
  app.setPath('userData', data)
  app.setPath('sessionData', data)
  let pick = { canceled: true, filePaths: [] }
  const remote = []
  class HiddenWindow extends electron.BrowserWindow {
    constructor(options) {
      super({
        ...options,
        width: 1100,
        height: 820,
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
  Module._load = function (request, parent, main) {
    return request === 'electron'
      ? {
          ...electron,
          BrowserWindow: HiddenWindow,
          dialog: { ...electron.dialog, showOpenDialog: async () => pick }
        }
      : load.call(this, request, parent, main)
  }
  const deadline = setTimeout(() => {
    console.error('TASK_RESOURCES_TIMEOUT')
    app.exit(2)
  }, 110000)
  app.on('browser-window-created', (_event, win) => {
    win.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (request, callback) => {
        remote.push(request.url)
        callback({ cancel: true })
      }
    )
    win.webContents.once('did-finish-load', async () => {
      const js = (code) =>
        win.webContents.executeJavaScript(code).catch((error) => {
          throw Error(error.message + '\n表达式：' + code.slice(0, 600))
        })
      const call = async (group, method, ...args) => {
        const result = await js(
          `window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`
        )
        assert.equal(result.ok, true, result.error)
        return result.data
      }
      const wait = async (code) => {
        const end = Date.now() + 12000
        while (!(await js(code))) {
          if (Date.now() > end)
            throw Error(
              '等待失败：' + code + '\n' + (await js('document.body.innerText'))
            )
          await new Promise((resolve) => setTimeout(resolve, 30))
        }
      }
      const click = (label, scope = '.page') =>
        js(
          `(()=>{const b=Array.from(document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)throw Error('按钮不可用：'+${JSON.stringify(label)});b.click();return true})()`
        )
      const set = (label, value, scope = '.page') =>
        js(
          `(()=>{const e=document.querySelector(${JSON.stringify(scope)}).querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');if(!e)throw Error('缺少输入：'+${JSON.stringify(label)});const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));return true})()`
        )
      const capture = async (name) => {
        await js('document.fonts.ready.then(()=>true)')
        await js(
          'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))'
        )
        await new Promise((resolve) => {
          win.webContents.once('paint', resolve)
          win.webContents.invalidate()
        })
        fs.writeFileSync(
          path.join(root, name),
          (await win.webContents.capturePage()).toPNG()
        )
      }
      const goto = async (href) => {
        await js(`location.hash=${JSON.stringify(href)}`)
      }
      try {
        await wait('!!window.api')
        await js('window.confirm=()=>true;true')
        if (phase === 'resume') {
          const saved = JSON.parse(
            fs.readFileSync(path.join(root, 'checkpoint.json'), 'utf8')
          )
          const list = await call('taskResources', 'list', {
            task_id: saved.task
          })
          assert.equal(list.total, 3)
          assert.ok(list.items.some((r) => r.why === '从实验误差检验理论模型'))
          const link = list.items.find((r) => r.snapshot.source.kind === 'note')
          await goto(
            `/notes/${link.snapshot.source.note_id}?view=uniform&revision=${link.snapshot.source.revision_id}&entry=${link.snapshot.source.entry_id}`
          )
          await wait(
            `document.querySelector('#note-learning-${link.snapshot.source.entry_id}.evidence-target')?.textContent.includes('课堂结论')`
          )
          assert.equal(
            await js(
              'document.querySelector(\'[aria-label="笔记修订"]\').value'
            ),
            link.snapshot.source.revision_id
          )
          assert.deepEqual(remote, [])
          console.log(
            'TASK_RESOURCES_RESTART_OK source revisions, task uses and quote snapshots persisted'
          )
          clearTimeout(deadline)
          app.exit(0)
          return
        }
        const project = await call('projects', 'create', {
          title: '共振测量项目'
        })
        const task = await call('tasks', 'create', {
          project_id: project.id,
          title: '比较测量结果',
          planned_at: 1860000000000,
          planned_end_at: 1860003600000
        })
        const manual = await call('tasks', 'create', { title: '复习受力分析' })
        const concept = await call('concepts', 'save', {
          subject_id: null,
          name: '系统边界',
          summary: '对所选系统分析受力',
          aliases: []
        })
        const { zipSync, strToU8 } = require('fflate'),
          file = path.join(root, '力学讲义.docx')
        const paragraphs = [
          ...Array.from(
            { length: 104 },
            (_, i) => `第${i + 1}段：记录实验条件。`
          ),
          '力学结论：F=ma，先选择系统边界。'
        ]
        fs.writeFileSync(
          file,
          zipSync({
            '[Content_Types].xml': strToU8(
              '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
            ),
            '_rels/.rels': strToU8(
              '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
            ),
            'word/document.xml': strToU8(
              '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
                paragraphs
                  .map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`)
                  .join('') +
                '<w:sectPr/></w:body></w:document>'
            )
          })
        )
        pick = { canceled: false, filePaths: [file] }
        const subjects = await call('subjects', 'list')
        const material = await call('materials', 'import', {
          subject_id: subjects[0].id,
          kind: 'handout'
        })
        await wait(
          `window.api.materials.get('${material.id}').then(r=>r.ok&&r.data.versions[0].status==='ready')`
        )
        let learning = await call(
          'learning',
          'prepare',
          material.current_version_id
        )
        assert.ok(
          learning.state.entries.length > 100,
          '教材跨页定位样例必须超过100条'
        )
        const last = learning.state.entries.at(-1)
        learning = await call('learning', 'change', {
          version_id: learning.version_id,
          expected_revision_id: learning.revision_id,
          entry_id: last.id,
          action: 'formula',
          formula: { range: [5, 9], latex: 'F=ma', display: false }
        })
        const note = await call('notes', 'create', {
          title: '实验课笔记',
          source: 'class'
        })
        for (let i = 0; i < 104; i++)
          await call('notes', 'addSegment', {
            note_id: note.id,
            raw_text: `课堂第${i + 1}段`
          })
        const segment = await call('notes', 'addSegment', {
          note_id: note.id,
          raw_text: '教师原话：质量为m，注意系统边界。',
          organized_text: '课堂结论：F=ma，系统边界要明确。',
          seg_type: 'definition'
        })
        const noteDoc = await call('notes', 'learningGet', { note_id: note.id })
        const exerciseInput = {
          title: '受力计算',
          subject_id: null,
          status: 'unfinished',
          question_type: '计算',
          source_label: '课堂练习',
          no_idea: false,
          review_concept_ids: [],
          fields: {
            statement: '已知质量 $m$ 与加速度 $a$，求合力。',
            approach: '选定系统后应用牛顿第二定律',
            standard_answer: '$F=ma$',
            user_answer: '',
            error_reason: ''
          }
        }
        const exercise = await call('exercises', 'save', exerciseInput)
        const doc = await call('projectDocuments', 'import', {
          project_id: project.id,
          material_id: material.id,
          version_id: learning.version_id,
          revision_id: learning.revision_id,
          kind: 'plan'
        })
        const cases = [
          {
            kind: 'material',
            material_id: material.id,
            version_id: learning.version_id,
            revision_id: learning.revision_id,
            entry_id: last.id
          },
          {
            kind: 'note',
            note_id: note.id,
            revision_id: noteDoc.revision_id,
            entry_id: noteDoc.state.entries.at(-1).id
          },
          {
            kind: 'exercise',
            exercise_id: exercise.id,
            revision_id: exercise.revision_id,
            entry_id: exercise.snapshot.document.fields.standard_answer
          },
          {
            kind: 'project_document',
            document_id: doc.id,
            revision_id: doc.revision_id,
            entry_id: doc.snapshot.state.entries.at(-1).id
          }
        ]
        const href = (source) => {
          const query = new URLSearchParams({
            revision: source.revision_id,
            entry: source.entry_id
          })
          if (source.kind === 'material') {
            query.set('material', source.material_id)
            query.set('version', source.version_id)
            return `/library?${query}`
          }
          if (source.kind === 'note')
            return `/notes/${source.note_id}?view=uniform&${query}`
          if (source.kind === 'exercise')
            return `/exercises/${source.exercise_id}?${query}`
          return `/projects/${project.id}/documents/${source.document_id}?${query}`
        }
        const sourceSelector = (source) =>
          source.kind === 'material'
            ? `#learning-${source.entry_id}`
            : source.kind === 'note'
              ? `#note-learning-${source.entry_id}`
              : source.kind === 'exercise'
                ? `#exercise-entry-${source.entry_id}`
                : `#project-document-entry-${source.entry_id}`
        for (const source of cases) {
          await goto(href(source))
          const scope = sourceSelector(source)
          await wait(
            `!!document.querySelector('${scope}.evidence-target .task-source-links')`
          )
          await js(
            `document.querySelector('${scope} .task-source-links').open=true;true`
          )
          await wait(
            `!!document.querySelector('${scope} option[value="${task.id}"]')`
          )
          await set('资料关联任务', task.id, scope)
          await set('任务资料用途', 'apply', scope)
          await set('任务资料知识点', concept.id, scope)
          await set('任务资料用途说明', '用此处结论解释共振测量结果', scope)
          await set('任务资料验证方法', '独立复算并分析误差', scope)
          await click('关联到任务', scope)
          await wait(
            `document.querySelector('${scope} .task-resource-backlink')?.textContent.includes('比较测量结果')`
          )
          await click('关联到任务', scope)
          await wait(
            `document.querySelector('${scope}')?.innerText.includes('保留已有用途与验证方法')`
          )
          await js(
            `document.querySelector('${scope} .task-resource-backlink a').click();true`
          )
          await wait(
            `document.querySelector('#project-task-${task.id} .task-resource-record a[href*="${source.entry_id}"]')!==null`
          )
        }
        let resources = await call('taskResources', 'list', {
          task_id: task.id
        })
        assert.equal(resources.total, 4)
        const beforeTimes = (await call('tasks', 'listAll')).find(
          (t) => t.id === task.id
        )
        const resource = resources.items.find(
            (r) => r.snapshot.source.kind === 'material'
          ),
          scope = `[data-resource-id="${resource.id}"]`
        await click('编辑资料用途', scope)
        await set('任务资料用途说明', '未保存草稿仍需保留', scope)
        // Another view changes this link while this editor holds its original revision.
        await call('taskResources', 'edit', {
          id: resource.id,
          expected_revision: resource.revision,
          role: resource.role,
          concept_id: concept.id,
          why: '另一窗口的修改',
          verification: ''
        })
        await click('保存资料用途', scope)
        await wait(
          "document.querySelector('.task-resources [role=alert]')?.textContent.includes('已变化')"
        )
        assert.equal(
          await js(
            `document.querySelector('${scope} textarea[aria-label="任务资料用途说明"]').value`
          ),
          '未保存草稿仍需保留'
        )
        await js('window.confirm=()=>false;true')
        await click('刷新任务资料', '.task-resources')
        assert.equal(
          await js(
            `document.querySelector('${scope} textarea[aria-label="任务资料用途说明"]').value`
          ),
          '未保存草稿仍需保留'
        )
        await js('window.confirm=()=>true;true')
        await click('刷新任务资料', '.task-resources')
        await wait(
          `document.querySelector('${scope}')?.innerText.includes('另一窗口的修改')&&!document.querySelector('${scope} textarea')`
        )
        await click('编辑资料用途', scope)
        await set('任务资料用途说明', '从实验误差检验理论模型', scope)
        await click('保存资料用途', scope)
        await wait(
          `document.querySelector('${scope}')?.innerText.includes('从实验误差检验理论模型')&&!document.querySelector('${scope} textarea')`
        )
        const afterTimes = (await call('tasks', 'listAll')).find(
          (t) => t.id === task.id
        )
        assert.deepEqual(
          afterTimes,
          beforeTimes,
          '资料用途编辑不改任务和日程时间'
        )
        await js(
          `document.querySelector('#project-task-${task.id}').scrollIntoView({block:'start'});true`
        )
        await capture('task-learning-path.png')
        win.setSize(1024, 800)
        await capture('task-learning-path-1024.png')
        assert.equal(
          await js(
            "document.querySelector('.page').scrollWidth<=document.querySelector('.page').clientWidth"
          ),
          true,
          '1024宽不横向溢出'
        )
        // New content must not replace the quoted revision.
        await call('notes', 'updateSegment', segment.id, {
          organized_text: '完全不同的新课堂结论'
        })
        await call('notes', 'learningGet', { note_id: note.id })
        await call('exercises', 'save', {
          ...exerciseInput,
          id: exercise.id,
          expected_revision_id: exercise.current_revision_id,
          fields: { ...exerciseInput.fields, standard_answer: '全新答案' }
        })
        await call('projectDocuments', 'save', {
          project_id: project.id,
          id: doc.id,
          expected_revision_id: doc.head_revision_id,
          title: '新版计划',
          kind: 'plan',
          body: '全新的计划正文',
          concept_ids: []
        })
        for (const source of cases) {
          await goto(`/projects/${project.id}?task=${task.id}`)
          const linked = resources.items.find(
            (r) => r.snapshot.source.kind === source.kind
          )
          await wait(
            `!!document.querySelector('[data-resource-id="${linked.id}"] a[href*="${source.entry_id}"]')`
          )
          await js(
            `document.querySelector('[data-resource-id="${linked.id}"] a[href*="${source.entry_id}"]').click();true`
          )
          await wait(
            `!!document.querySelector('${sourceSelector(source)}.evidence-target')`
          )
          assert.equal(
            await js(
              `document.querySelector('${sourceSelector(source)}').innerText.includes('全新')`
            ),
            false
          )
        }
        // A source may be used in a manual schedule as well.
        await goto(href(cases[0]))
        await wait(
          `!!document.querySelector('${sourceSelector(cases[0])} .task-source-links')`
        )
        await js(
          `document.querySelector('${sourceSelector(cases[0])} .task-source-links').open=true;true`
        )
        await wait(`!!document.querySelector('option[value="${manual.id}"]')`)
        await set('资料关联任务', manual.id, sourceSelector(cases[0]))
        await click('关联到任务', sourceSelector(cases[0]))
        await wait(
          `document.querySelector('${sourceSelector(cases[0])} a[href*="${manual.id}"]')!==null`
        )
        await js(
          `document.querySelector('${sourceSelector(cases[0])} a[href*="${manual.id}"]').click();true`
        )
        await wait(
          "document.querySelector('.schedule-editor [aria-label=\"日程名称\"]')?.value==='复习受力分析'&&!!document.querySelector('.schedule-editor .task-resource-record')"
        )
          await click('编辑资料用途', '.schedule-editor .task-resource-record')
          assert.equal(
            await js("document.querySelector('.schedule-editor [aria-label=\"搜索任务资料知识点\"]').closest('form')"),
            null,
            '资料编辑独立于日程表单，回车不能意外保存日程'
          )
          await js("document.querySelector('.schedule-editor [aria-label=\"搜索任务资料知识点\"]').focus();true")
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
          await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))')
          assert.ok(await js("!!document.querySelector('.schedule-editor textarea[aria-label=\"任务资料用途说明\"]')"))
          await click('取消资料编辑', '.schedule-editor .task-resource-record')
        await goto(`/knowledge?concept=${concept.id}`)
        await wait(
          "document.querySelector('.concept-usage')?.innerText.includes('比较测量结果')"
        )
        const usage = await call('concepts', 'usage', {
          concept_id: concept.id
        })
        assert.equal(
          usage.items.filter(
            (item) => item.kind === 'task' && item.id === task.id
          ).length,
          1
        )
        // Removing a note retains the historical quote but removes its navigation target.
        await call('notes', 'remove', note.id)
        resources = await call('taskResources', 'list', { task_id: task.id })
        const noteResource = resources.items.find(
          (r) => r.snapshot.source.kind === 'note'
        )
        assert.equal(noteResource.available, false)
        assert.equal(
          noteResource.snapshot.original_text,
          '教师原话：质量为m，注意系统边界。'
        )
        await goto(`/projects/${project.id}?task=${task.id}`)
        await wait(
          `document.querySelector('[data-resource-id="${noteResource.id}"]')?.innerText.includes('来源已删除')`
        )
        const deadScope = `[data-resource-id="${noteResource.id}"]`
        assert.equal(
          await js(
            `!!document.querySelector('${deadScope} a[href*="/notes/"]')`
          ),
          false
        )
        await click('移除资料关联', deadScope)
        await wait(`!document.querySelector('${deadScope}')`)
        assert.equal(
          (await call('taskResources', 'list', { task_id: task.id })).total,
          3
        )
        // Keep another note association for restart navigation.
        const restartNote = await call('notes', 'create', {
          title: '持久化课堂笔记',
          source: 'class'
        })
        await call('notes', 'addSegment', {
          note_id: restartNote.id,
          raw_text: '原话',
          organized_text: '课堂结论 F=ma'
        })
        const restartDoc = await call('notes', 'learningGet', {
          note_id: restartNote.id
        })
        const exerciseResource = resources.items.find(
          (r) => r.snapshot.source.kind === 'exercise'
        )
        await call('taskResources', 'remove', {
          id: exerciseResource.id,
          expected_revision: exerciseResource.revision
        })
        await call('taskResources', 'add', {
          task_id: task.id,
          source: {
            kind: 'note',
            note_id: restartNote.id,
            revision_id: restartDoc.revision_id,
            entry_id: restartDoc.state.entries[0].id
          },
          role: 'learn',
          concept_id: null,
          why: '复盘课堂',
          verification: ''
        })
        assert.deepEqual(remote, [])
        fs.writeFileSync(
          path.join(root, 'checkpoint.json'),
          JSON.stringify({ task: task.id })
        )
        console.log(
          'TASK_RESOURCES_NATIVE_OK four source entries, fixed revision/pagination, bidirectional task links, stale drafts, edit/remove, concept usage, manual schedule and missing source'
        )
        clearTimeout(deadline)
        app.exit(0)
      } catch (error) {
        console.error(error.stack || error)
        try {
          await capture('failure.png')
        } catch {}
        clearTimeout(deadline)
        app.exit(1)
      }
    })
  })
  require(path.resolve('out/main/index.js'))
}
