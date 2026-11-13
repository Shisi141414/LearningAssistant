// Real Electron forms, textbook transfer, PDF and restart with isolated user data.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict')
if (!process.versions.electron) {
  const root = fs.mkdtempSync(
    path.join(require('node:os').tmpdir(), 'learning-assistant-exercises-')
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
    assert.equal(result.status, 0, '习题库验收失败：' + phase)
  }
  ;(async () => {
    const canvas = require('@napi-rs/canvas')
    global.DOMMatrix = canvas.DOMMatrix
    global.ImageData = canvas.ImageData
    global.Path2D = canvas.Path2D
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const bytes = fs.readFileSync(path.join(root, '习题.pdf'))
    assert.ok(bytes.toString('latin1').includes('SimSun'))
    const loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }),
      pdf = await loading.promise,
      texts = []
    for (let n = 1; n <= pdf.numPages; n++)
      texts.push(
        (await (await pdf.getPage(n)).getTextContent()).items.map((item) => item.str).join('')
      )
    const text = texts.join('\n')
    for (const label of [
      '题面',
      '解题思路',
      '标准答案',
      '用户答案',
      '错误原因',
      '需复习',
      '动量守恒',
      '教材原题'
    ])
      assert.ok(text.includes(label), 'PDF 缺少 ' + label)
    const page = await pdf.getPage(1),
      viewport = page.getViewport({ scale: 1.2 }),
      image = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    await page.render({ canvasContext: image.getContext('2d'), viewport }).promise
    fs.writeFileSync(path.join(root, 'exercise-pdf.png'), image.toBuffer('image/png'))
    await loading.destroy()
    console.log('EXERCISES_NATIVE_ROOT ' + root)
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
    console.error('EXERCISES_TIMEOUT')
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
        await js('document.fonts.ready.then(()=>true)')
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
          const saved = JSON.parse(fs.readFileSync(path.join(root, 'checkpoint.json'), 'utf8')),
            detail = await call('exercises', 'get', { id: saved.id })
          assert.equal(detail.snapshot.status, 'correct')
          assert.deepEqual(detail.snapshot.review_concept_ids, [saved.concept])
          assert.ok(detail.history.length >= 4)
          await js(`location.hash='/exercises/${saved.id}'`)
          await wait("document.body.innerText.includes('用户已完成复核')")
          assert.equal(detail.snapshot.origin.reference.material_id, saved.material)
          assert.deepEqual(remote, [])
          console.log('EXERCISES_RESTART_OK revisions, answers, source and knowledge links')
          clearTimeout(deadline)
          app.exit(0)
          return
        }
        const subjects = await call('subjects', 'list'),
          subject = subjects[0].id
        const concept = await call('concepts', 'save', {
          subject_id: subject,
          name: '动量守恒',
          summary: '检查碰撞前后系统动量',
          aliases: ['动量不变']
        })
        await js("location.hash='/exercises/new'")
        await wait('!!document.querySelector(\'[aria-label="习题标题"]\')')
        await set('习题标题', '碰撞计算')
        await set('习题学科', subject)
        await set('习题作答状态', 'wrong')
        await set('习题题型', '计算')
        await set('习题来源', '教材第 10 页')
        // Refresh concepts in the renderer after creating a fixture through IPC.
        await js("location.hash='/knowledge'")
        await wait("document.body.innerText.includes('动量守恒')")
        await js("location.hash='/exercises/new'")
        await wait('!!document.querySelector(\'[aria-label="习题标题"]\')')
        await set('习题标题', '碰撞计算')
        await set('习题学科', subject)
        await set('习题作答状态', 'wrong')
        await set('习题题型', '计算')
        await set('习题来源', '教材第 10 页')
        await set('添加复习知识点', concept.id)
        for (const [label, text] of Object.entries({
          题面: '动量守恒：求碰撞后速度 $v$。',
          解题思路: '先选择整个系统，再用动量不变。',
          标准答案: '$v=2$',
          用户答案: '$v=1$',
          错误原因: '未考虑第二个物体的动量'
        }))
          await paste(label, text)
        await wait("document.querySelectorAll('.exercise-form math-field').length===3")
        await capture('exercise-editor.png')
        await click('保存习题')
        await wait("!!document.querySelector('.exercise-metadata')")
        const first = (await call('exercises', 'list', {})).items[0],
          detail = await call('exercises', 'get', { id: first.id })
        assert.equal(detail.snapshot.status, 'wrong')
        assert.deepEqual(detail.snapshot.review_concept_ids, [concept.id])
        assert.equal(detail.snapshot.document.state.entries.length, 5)
        await capture('exercise-detail.png')
        await click('编辑习题')
        await wait("!!document.querySelector('.exercise-form')")
        await set('习题作答状态', 'correct')
        await paste('用户答案', '用户已完成复核 $v=2$')
        await click('保存习题')
        await wait("!document.querySelector('.exercise-form')")
        await set('习题修订', detail.revision_id)
        await wait("document.body.innerText.includes('正在查看历史修订')")
        assert.equal(
          await js(
            "!!Array.from(document.querySelectorAll('.page button')).find(b=>b.textContent==='编辑习题')"
          ),
          false
        )
        await click('读取当前修订')
        await wait("document.body.innerText.includes('用户已完成复核')")
        await js('window.confirm=()=>true;true')
        await click('删除习题')
        await wait("document.body.innerText.includes('此题已在回收站')")
        await click('恢复习题')
        await wait(
          "!!Array.from(document.querySelectorAll('.page button')).find(b=>b.textContent==='编辑习题')"
        )
        await js("location.hash='/exercises'")
        await wait('!!document.querySelector(\'[aria-label="搜索习题"]\')')
        await set('习题状态筛选', 'correct')
        await set('搜索习题', '碰撞计算')
        await wait("document.querySelectorAll('.exercise-list-item').length===1")
        await capture('exercise-list.png')
        const { zipSync, strToU8 } = require('fflate'),
          file = path.join(root, '教材.docx')
        const entries = {
          '[Content_Types].xml':
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
          '_rels/.rels':
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
          'word/document.xml':
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>教材例题：求动量守恒条件。</w:t></w:r></w:p><w:p><w:r><w:t>标准解答：系统合外力为零。</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'
        }
        fs.writeFileSync(
          file,
          zipSync(
            Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, strToU8(value)]))
          )
        )
        pick = { canceled: false, filePaths: [file] }
        const material = await call('materials', 'import', {
          subject_id: subject,
          kind: 'textbook'
        })
        await wait(
          `window.api.materials.get(${JSON.stringify(material.id)}).then(r=>r.ok&&r.data.versions[0].status==='ready')`
        )
        let document = await call('learning', 'prepare', material.current_version_id)
        assert.equal(document.state.entries.length, 2)
        for (const [index, type] of ['exercise', 'solution'].entries())
          document = await call('learning', 'change', {
            version_id: material.current_version_id,
            expected_revision_id: document.current_revision_id,
            entry_id: document.state.entries[index].id,
            action: 'edit',
            type,
            title: index ? '解答' : '教材例题'
          })
        document = await call('learning', 'change', {
          version_id: material.current_version_id,
          expected_revision_id: document.current_revision_id,
          entry_id: document.state.entries[1].id,
          action: 'relate',
          target_id: document.state.entries[0].id
        })
        await js(
          `location.hash='/library?material=${material.id}&version=${material.current_version_id}&revision=${document.revision_id}'`
        )
        await wait(
          "!!document.querySelector('.learning-reader') && document.body.innerText.includes('加入习题库')"
        )
        await click('加入习题库')
        await wait("!!document.querySelector('.learning-reader a[href*=exercises]')")
        await js("document.querySelector('.learning-reader a[href*=exercises]').click()")
        await wait("!!document.querySelector('.exercise-metadata')")
        const id = (await js('location.hash')).split('/').at(-1)
        await click('编辑习题')
        await wait("!!document.querySelector('.exercise-form')")
        await set('习题作答状态', 'correct')
        await set('添加复习知识点', concept.id)
        await paste('用户答案', '用户已完成复核：合外力为零')
        await paste('解题思路', '动量守恒用于检验系统。')
        await paste('错误原因', '原先漏掉外力条件。')
        await click('保存习题')
        await wait("!document.querySelector('.exercise-form')")
        await click('删除习题')
        await wait("document.body.innerText.includes('此题已在回收站')")
        await click('恢复习题')
        await wait(
          "!!Array.from(document.querySelectorAll('.page button')).find(b=>b.textContent==='编辑习题')"
        )
        await click('导出 PDF')
        await js("document.querySelector('.learning-pdf-export input[type=checkbox]').click()")
        save = { canceled: false, filePath: path.join(root, '习题.pdf') }
        await click('选择位置并保存 PDF')
        await wait(
          "document.querySelector('.learning-pdf-export').innerText.includes('已保存 习题.pdf')"
        )
        assert.ok(fs.readFileSync(save.filePath).subarray(0, 5).toString() === '%PDF-')
        fs.writeFileSync(
          path.join(root, 'checkpoint.json'),
          JSON.stringify({ id, concept: concept.id, material: material.id })
        )
        assert.deepEqual(remote, [])
        console.log(
          'EXERCISES_NATIVE_OK real CRUD, formula fields, status/filter/history/trash, textbook transfer and PDF'
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
