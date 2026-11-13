// Real Electron forms, textbook transfer, PDF and restart with isolated user data.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict')
if (!process.versions.electron) {
  const root = fs.mkdtempSync(
    path.join(require('node:os').tmpdir(), 'learning-assistant-project-documents-')
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  for (const phase of ['first', 'resume']) {
    const result = require('node:child_process').spawnSync(
      require('electron'),
      [__filename, root, phase],
      { env, windowsHide: true, encoding: 'utf8', timeout: 100_000 }
    )
    process.stdout.write(result.stdout || '')
    process.stderr.write(result.stderr || '')
    if (result.error) throw result.error
    assert.equal(result.status, 0, '项目文档验收失败：' + phase)
  }
  ;(async () => {
    const canvas = require('@napi-rs/canvas')
    global.DOMMatrix = canvas.DOMMatrix
    global.ImageData = canvas.ImageData
    global.Path2D = canvas.Path2D
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const bytes = fs.readFileSync(path.join(root, '计划书.pdf'))
    assert.ok(bytes.toString('latin1').includes('SimSun'))
    const loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }),
      pdf = await loading.promise,
      texts = []
    for (let n = 1; n <= pdf.numPages; n++)
      texts.push(
        (await (await pdf.getPage(n)).getTextContent()).items.map((item) => item.str).join('')
      )
    const text = texts.join('\n')
    for (const label of ['计划书', '振动测量', '质量', '项目要求'])
      assert.ok(text.includes(label), 'PDF 缺少 ' + label)
    const page = await pdf.getPage(1),
      viewport = page.getViewport({ scale: 1.2 }),
      image = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    await page.render({ canvasContext: image.getContext('2d'), viewport }).promise
    fs.writeFileSync(path.join(root, 'project-document-pdf.png'), image.toBuffer('image/png'))
    await loading.destroy()
    console.log('PROJECT_DOCUMENTS_NATIVE_ROOT ' + root)
  })().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
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
  let save = { canceled: true },
    pick = { canceled: true, filePaths: [] }
  const remote = []
  class HiddenWindow extends electron.BrowserWindow {
    constructor(options) {
      super({
        ...options,
        width: 1100,
        height: 820,
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
      ? {
          ...electron,
          BrowserWindow: HiddenWindow,
          dialog: {
            ...electron.dialog,
            showSaveDialog: async () => save,
            showOpenDialog: async () => pick
          }
        }
      : load.call(this, request, parent, main)
  }
  const deadline = setTimeout(() => {
    console.error('PROJECT_DOCUMENTS_TIMEOUT')
    app.exit(2)
  }, 90000)
  app.on('browser-window-created', (_event, win) => {
    win.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (request, callback) => {
        remote.push(request.url)
        callback({ cancel: true })
      }
    )
    win.webContents.once('did-finish-load', async () => {
      if (new URL(win.webContents.getURL()).pathname.endsWith('/print.html')) return
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
        const end = Date.now() + 10000
        while (!(await js(code))) {
          if (Date.now() > end)
            throw Error('等待失败：' + code + '\n' + (await js('document.body.innerText')))
          await new Promise((resolve) => setTimeout(resolve, 30))
        }
      }
      const click = (label, scope = '.page') =>
        js(
          `(()=>{const b=Array.from(document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')).find(item=>item.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)throw Error('按钮不可用：'+${JSON.stringify(label)});b.click();return true})()`
        )
      const set = (label, value) =>
        js(
          `(()=>{const e=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');if(!e)throw Error('缺少输入：'+${JSON.stringify(label)});const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));return true})()`
        )
      const paste = (label, text) =>
        js(
          `(()=>{const e=document.querySelector('.math-editor[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');e.focus();const range=document.createRange();range.selectNodeContents(e);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);document.dispatchEvent(new Event('selectionchange'));const clipboard=new DataTransfer();clipboard.setData('text/plain',${JSON.stringify(text)});e.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:clipboard}));return true})()`
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
      try {
        await wait('!!window.api')
        if (phase === 'resume') {
          const saved = JSON.parse(fs.readFileSync(path.join(root, 'checkpoint.json'), 'utf8'))
          const doc = await call('projectDocuments', 'get', { id: saved.id })
          assert.equal(doc.snapshot.title, '振动测量计划书')
          assert.ok(doc.history.length >= 7)
          assert.deepEqual(doc.snapshot.concept_ids, [saved.concept])
          const imported = await call('projectDocuments', 'get', { id: saved.imported })
          assert.equal(imported.snapshot.origin.material_id, saved.material)
          await js(`location.hash='/projects/${saved.project}/documents/${saved.id}'`)
          await wait("!!document.querySelector('.project-document-paper .katex')")
          assert.deepEqual(remote, [])
          console.log(
            'PROJECT_DOCUMENTS_RESTART_OK immutable revisions, source and concept links, formula rendering'
          )
          clearTimeout(deadline)
          app.exit(0)
          return
        }
        await js('window.confirm=()=>true;true')
        const project = await call('projects', 'create', {
          title: '振动测量',
          goal: '比较理论模型与测量值'
        })
        const concept = await call('concepts', 'save', {
          subject_id: null,
          name: '牛顿第二定律',
          summary: '系统边界与受力分析',
          aliases: []
        })
        await js(`location.hash='/projects/${project.id}'`)
        await wait("!!document.querySelector('.project-document-create')")
        await js("document.querySelector('.project-document-create').click();true")
        await wait("!!document.querySelector('.project-document-editor')")
        await set('项目文档标题', '振动测量计划书')
        await set('项目文档用途', 'plan')
        await paste('项目文档正文', '项目要求：已知质量，验证 $F=ma$。\n保留系统边界与验证条件。')
        await wait(`!!document.querySelector('option[value="${concept.id}"]')`)
        await set('项目文档关联知识', concept.id)
        await click('保存文档')
        await wait(
          "!!document.querySelector('.project-document-paper .katex')&&!document.querySelector('.project-document-editor')"
        )
        const id = (await js('location.hash')).split('/').at(-1),
          first = await call('projectDocuments', 'get', { id })
        assert.equal(first.snapshot.concept_ids[0], concept.id)
        await click('整理条目')
        await set('条目语义类型', 'definition')
        await set('学习条目标题', '验证条件')
        await click('保存类型与标题')
        await wait(
          "document.querySelector('.project-document-paper .learning-definition')?.textContent.includes('验证条件')&&!document.querySelector('.learning-editor')"
        )
        await capture('project-document.png')
        save = { canceled: false, filePath: path.join(root, '计划书.pdf') }
        await click('导出 PDF')
        await click('选择位置并保存 PDF')
        await wait(
          "document.querySelector('.learning-pdf-export')?.innerText.includes('已保存 计划书.pdf')"
        )
        assert.ok(fs.statSync(save.filePath).size > 5000)
        await click('编辑文档')
        await set('项目文档标题', '计划第二版')
        await click('保存文档')
        await wait(
          "document.querySelector('h1')?.textContent==='计划第二版'&&!document.querySelector('.project-document-editor')"
        )
        let current = await call('projectDocuments', 'get', { id })
        assert.deepEqual(
          current.snapshot.state.entries,
          (await call('projectDocuments', 'get', { id, revision_id: current.history[1].id }))
            .snapshot.state.entries
        )
        await click('编辑文档')
        await set('项目文档标题', '本地草稿')
        await call('projectDocuments', 'save', {
          project_id: project.id,
          id,
          expected_revision_id: current.head_revision_id,
          title: '协作更新',
          kind: 'plan',
          concept_ids: [concept.id]
        })
        await click('保存文档')
        await wait("document.querySelector('[role=alert]')?.textContent.includes('已有更新')")
        assert.equal(
          await js('document.querySelector(\'[aria-label="项目文档标题"]\').value'),
          '本地草稿'
        )
        await click('读取最新修订')
        await wait(
          "document.querySelector('h1')?.textContent==='协作更新'&&!document.querySelector('.project-document-editor')"
        )
        await set('项目文档修订', first.revision_id)
        await wait("document.body.innerText.includes('正在查看历史修订')")
        assert.equal(
          await js(
            "Array.from(document.querySelectorAll('.page button')).find(b=>b.textContent==='编辑文档').disabled"
          ),
          true
        )
        await click('恢复此修订')
        await wait(
          "document.querySelector('h1')?.textContent==='振动测量计划书'&&!document.body.innerText.includes('正在查看历史修订')"
        )
        await click('删除文档')
        await wait("document.body.innerText.includes('文档在回收站')")
        await click('恢复文档')
        await wait("!document.body.innerText.includes('文档在回收站')")
        await js(`location.hash='/knowledge?concept=${concept.id}'`)
        await wait(
          "document.querySelector('.concept-usage')?.innerText.includes('项目文档：振动测量计划书')"
        )
        await js(`document.querySelector('.concept-usage a[href*="${id}"]').click();true`)
        await wait("!!document.querySelector('.project-document-paper .katex')")
        const { zipSync, strToU8 } = require('fflate'),
          file = path.join(root, '任务书.docx')
        const entries = {
          '[Content_Types].xml':
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
          '_rels/.rels':
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
          'word/document.xml':
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>任务书：定义测量精度与系统边界。</w:t></w:r></w:p><w:p><w:r><w:t>交付计划书及实验记录。</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'
        }
        fs.writeFileSync(
          file,
          zipSync(
            Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, strToU8(value)]))
          )
        )
        pick = { canceled: false, filePaths: [file] }
        const subjects = await call('subjects', 'list'),
          material = await call('materials', 'import', {
            subject_id: subjects[0].id,
            kind: 'handout'
          })
        await wait(
          `window.api.materials.get(${JSON.stringify(material.id)}).then(r=>r.ok&&r.data.versions[0].status==='ready')`
        )
        const original = await call('learning', 'prepare', material.current_version_id)
        await js(`location.hash='/projects/${project.id}'`)
        await wait("!!document.querySelector('.project-document-list a')")
        await click('从材料库导入')
        await wait(`!!document.querySelector('option[value="${material.id}"]')`)
        await set('导入项目的材料', material.id)
        await set('导入项目文档用途', 'requirements')
        await click('导入所选修订')
        await wait("!!document.querySelector('.project-document-origin')")
        const imported = (await js('location.hash')).split('/').at(-1),
          copy = await call('projectDocuments', 'get', { id: imported })
        assert.equal(copy.snapshot.origin.revision_id, original.revision_id)
        assert.deepEqual(copy.snapshot.sources, original.sources)
        await js("document.querySelector('.project-document-origin a').click();true")
        await wait("!!document.querySelector('.learning-reader')")
        assert.ok((await js('location.hash')).includes(original.revision_id))
        await js(`location.hash='/projects/${project.id}'`)
        await wait("document.querySelectorAll('.project-document-list a').length===2")
        await set('查找项目文档', '振动测量')
        await wait("document.querySelectorAll('.project-document-list a').length===1")
        await set('查找项目文档', '')
        await call('projects', 'update', project.id, { status: 'archived' })
        await js(`location.hash='/projects/${project.id}/documents/${id}'`)
        await wait("!!document.querySelector('.project-document-paper')")
        win.setContentSize(1024, 768)
        await wait('Math.abs(innerWidth-1024)<=2')
        assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true)
        await capture('project-document-1024.png')
        fs.writeFileSync(
          path.join(root, 'checkpoint.json'),
          JSON.stringify({
            id,
            project: project.id,
            concept: concept.id,
            imported,
            material: material.id
          })
        )
        assert.deepEqual(remote, [])
        console.log(
          'PROJECT_DOCUMENTS_NATIVE_OK forms, formulas, structure, stale draft protection, history restore, trash, material import/source, knowledge backlinks, PDF and 1024 layout'
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
}
