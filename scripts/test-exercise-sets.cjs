// Real Electron/file-picker/worker/renderer/restart acceptance using isolated user data.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto')
if (!process.versions.electron) {
  const root = fs.mkdtempSync(
      path.join(
        require('node:os').tmpdir(),
        'learning-assistant-exercise-sets-'
      )
    ),
    env = { ...process.env }
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
    assert.equal(r.status, 0, '习题集验收失败：' + phase)
  }
  console.log('EXERCISE_SETS_NATIVE_ROOT ' + root)
  process.exit(0)
}
const electron = require('electron'),
  { app } = electron,
  root = process.argv[2],
  phase = process.argv[3]
app.disableHardwareAcceleration()
app.setPath('userData', root)
app.setPath('sessionData', root)
let pick
const remote = []
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
      dialog: {
        ...electron.dialog,
        showOpenDialog: async () => ({
          canceled: !pick,
          filePaths: pick ? [pick] : []
        })
      }
    }
  return load.call(this, request, parent, main)
}
const deadline = setTimeout(() => {
  console.error('EXERCISE_SETS_NATIVE_TIMEOUT')
  app.exit(2)
}, 90000)
const hash = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function files() {
  const { zipSync, strToU8 } = require('fflate'),
    xml = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  const zip = (name, entries) => {
    const file = path.join(root, name)
    fs.writeFileSync(
      file,
      zipSync(
        Object.fromEntries(
          Object.entries(entries).map(([k, v]) => [k, strToU8(v)])
        )
      )
    )
    return file
  }
  const docx = zip('习题集.docx', {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml':
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      [
        '测试习题集',
        '1. 求 $x^2$ 的导数。',
        '(1) 说明使用的法则。',
        '解题思路：使用幂函数法则。',
        '标准答案：$2x$。',
        '2. 求位移。',
        '答案：$s=vt$。',
        '第3题 求反力。',
        '解：$R=mg$。'
      ]
        .map((t) => `<w:p><w:r><w:t>${xml(t)}</w:t></w:r></w:p>`)
        .join('') +
      '<w:sectPr/></w:body></w:document>'
  })
  const rel =
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  const slide = (lines) =>
    '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/>' +
    lines.map((t) => `<a:p><a:r><a:t>${xml(t)}</a:t></a:r></a:p>`).join('') +
    '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
  const pptx = zip('练习课件.pptx', {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
    '_rels/.rels':
      rel +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    'ppt/presentation.xml':
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels':
      rel +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    'ppt/slides/slide1.xml': slide([
      'Problem 1 Find velocity.',
      'Answer: 3m/s',
      'Problem 2 Find mass.',
      'Answer: 2kg'
    ])
  })
  const content =
    'BT /F1 12 Tf 50 750 Td (Question 1 Find x.) Tj 0 -20 Td (Answer: x=2) Tj 0 -40 Td (Question 2 Find y.) Tj 0 -20 Td (Answer: y=3) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  const pdfFile = path.join(root, '练习.pdf')
  fs.writeFileSync(pdfFile, pdf)
  return { docx, pptx, pdf: pdfFile }
}
app.on('browser-window-created', (_e, win) => {
  win.webContents.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (r, callback) => {
      remote.push(r.url)
      callback({ cancel: true })
    }
  )
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code)
    const call = async (group, method, ...args) => {
      const r = await js(
        `window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`
      )
      assert.equal(r.ok, true, r.error)
      return r.data
    }
    const wait = async (code) => {
      const end = Date.now() + 12000
      while (!(await js(code))) {
        if (Date.now() > end)
          throw Error(
            '等待失败：' + code + '\n' + (await js('document.body.innerText'))
          )
        await new Promise((r) => setTimeout(r, 30))
      }
    }
    const click = (text) =>
      js(
        `(()=>{const b=[...document.querySelectorAll('.page button')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(text)}));if(!b||b.disabled)throw Error('按钮不可用：'+${JSON.stringify(text)});b.click();return true})()`
      )
    const set = (label, value) =>
      js(
        `(()=>{const e=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));return true})()`
      )
    const capture = async (name) => {
      await js(
        'document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true)))))'
      )
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('离屏截图超时')), 5000)
        win.webContents.once('paint', () => {
          clearTimeout(timer)
          resolve()
        })
        win.webContents.invalidate()
      })
      fs.writeFileSync(
        path.join(root, name),
        (await win.webContents.capturePage()).toPNG()
      )
    }
    try {
      await wait('!!window.api')
      if (phase === 'resume') {
        const saved = JSON.parse(
          fs.readFileSync(path.join(root, 'checkpoint.json'), 'utf8')
        )
        assert.equal((await call('exercises', 'list', {})).total, 7)
        const exercise = await call('exercises', 'get', { id: saved.first })
        assert.equal(
          exercise.snapshot.document.sources.find(
            (s) => s.heading === '用户答案'
          ).raw_text,
          '用户独立解答'
        )
        const p = await call('exerciseSets', 'preview', saved.version)
        assert.equal(p.candidates.filter((c) => c.existing_id).length, 3)
        assert.equal(
          (
            await call('exerciseSets', 'import', {
              token: p.token,
              entry_ids: p.candidates.map((c) => c.id)
            })
          ).added,
          0
        )
        assert.equal(hash(saved.file), saved.hash)
        assert.deepEqual(remote, [])
        console.log(
          'EXERCISE_SETS_RESTART_OK original, fixed source revision, answers and import dedup'
        )
        clearTimeout(deadline)
        app.exit(0)
        return
      }
      const fixture = files(),
        subject = (await call('subjects', 'list'))[0].id,
        sourceHash = hash(fixture.docx)
      await js("location.hash='/exercises'")
      await wait("document.querySelector('h1')?.textContent==='习题库'")
      await click('导入习题集')
      await wait('!!document.querySelector(\'[aria-label="习题集导入学科"]\')')
      await set('习题集导入学科', subject)
      await click('选择习题集文件')
      assert.deepEqual(await call('materials', 'list'), [])
      pick = fixture.docx
      await click('选择习题集文件')
      await wait(
        "document.querySelectorAll('.exercise-import-candidates article').length===3"
      )
      await js(
        "document.querySelector('.exercise-import-candidates details').open=true"
      )
      await wait(
        "!!document.querySelector('.exercise-import-candidates .katex')"
      )
      await capture('exercise-set-preview.png')
      const material = (await call('materials', 'list'))[0],
        version = material.current_version_id
      await js(
        "document.querySelectorAll('.exercise-import-candidates article input')[1].click()"
      )
      await click('确认转换所选习题（2）')
      await wait(
        "document.querySelector('.exercise-import-result')?.textContent.includes('已转换 2 道')"
      )
      const first = (await call('exercises', 'list', {})).items.find((e) =>
        e.title.startsWith('1.')
      )
      const detail = await call('exercises', 'get', { id: first.id })
      assert.ok(
        detail.snapshot.document.sources
          .find((s) => s.heading === '解题思路')
          .raw_text.includes('幂函数')
      )
      assert.ok(
        detail.snapshot.document.sources
          .find((s) => s.heading === '标准答案')
          .raw_text.includes('2x')
      )
      assert.ok(detail.snapshot.origin.raw_text.includes('(1) 说明'))
      assert.equal(detail.snapshot.origin.reference.version_id, version)
      await call('exercises', 'save', {
        id: detail.id,
        expected_revision_id: detail.current_revision_id,
        title: detail.snapshot.title,
        subject_id: subject,
        status: 'unfinished',
        question_type: '',
        source_label: detail.snapshot.source_label,
        no_idea: false,
        review_concept_ids: [],
        fields: {
          statement: detail.snapshot.document.sources.find(
            (s) => s.heading === '题面'
          ).raw_text,
          approach: detail.snapshot.document.sources.find(
            (s) => s.heading === '解题思路'
          ).raw_text,
          standard_answer: detail.snapshot.document.sources.find(
            (s) => s.heading === '标准答案'
          ).raw_text,
          user_answer: '用户独立解答',
          error_reason: ''
        }
      })
      await click('重新预览切分')
      await wait(
        "document.querySelectorAll('.exercise-import-candidates article').length===3"
      )
      assert.equal(
        await js(
          "document.querySelectorAll('.exercise-import-candidates article input:disabled').length"
        ),
        2
      )
      await click('确认转换所选习题（1）')
      await wait(
        "document.querySelector('.exercise-import-result')?.textContent.includes('已转换 1 道')"
      )
      win.setSize(1024, 768)
      await capture('exercise-set-import-1024.png')
      assert.equal(
        await js('document.documentElement.scrollWidth<=innerWidth'),
        true
      )
      for (const file of [fixture.pdf, fixture.pptx]) {
        pick = file
        const m = await call('materials', 'import', {
          subject_id: subject,
          kind: 'supplement'
        })
        await wait(
          `window.api.materials.get(${JSON.stringify(m.id)}).then(r=>r.ok&&r.data.versions.find(v=>v.id===${JSON.stringify(m.current_version_id)}).status==='ready')`
        )
        const preview = await call(
          'exerciseSets',
          'preview',
          m.current_version_id
        )
        assert.equal(preview.candidates.length, 2, file)
        assert.ok(preview.candidates.every((c) => c.answer.trim()))
        assert.equal(
          (
            await call('exerciseSets', 'import', {
              token: preview.token,
              entry_ids: preview.candidates.map((c) => c.id)
            })
          ).added,
          2
        )
      }
      assert.equal(hash(fixture.docx), sourceHash)
      fs.writeFileSync(
        path.join(root, 'checkpoint.json'),
        JSON.stringify({
          first: first.id,
          version,
          file: fixture.docx,
          hash: sourceHash
        })
      )
      assert.deepEqual(remote, [])
      console.log(
        'EXERCISE_SETS_NATIVE_OK DOCX picker/preview/subset, native PDF/PPTX parsing, canonical fields, source, duplicate-safe and 1024px UI'
      )
      clearTimeout(deadline)
      app.exit(0)
    } catch (e) {
      console.error(e.stack || e)
      clearTimeout(deadline)
      app.exit(1)
    }
  })
})
require('../out/main/index.js')
