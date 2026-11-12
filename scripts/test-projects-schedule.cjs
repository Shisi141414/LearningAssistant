// R4/R5 与数学输入的隐藏 Windows 真机验收；所有数据使用独立临时目录。
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
if(!process.versions.electron){
  const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'learning-assistant-projects-')),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
  for(const phase of ['first','resume']){const r=require('node:child_process').spawnSync(require('electron'),[__filename,root,phase],{env,windowsHide:true,encoding:'utf8',timeout:65000});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.error)throw r.error;assert.equal(r.status,0,'项目/日程验收失败：'+phase)}
  console.log('PROJECTS_NATIVE_ROOT '+root);process.exit(0)
}
const electron=require('electron'),{app}=electron,root=process.argv[2],phase=process.argv[3],notifications=[]
app.disableHardwareAcceleration();app.setPath('userData',root);app.setPath('sessionData',root)
class HiddenWindow extends electron.BrowserWindow{constructor(options){super({...options,width:1024,height:768,show:false,webPreferences:{...options.webPreferences,offscreen:true,backgroundThrottling:false}})}show(){}}
// 截获派发参数，不真的给用户发送测试系统通知；不将这等同于 Windows 通知展示验收。
class NotificationSpy{static isSupported(){return true}constructor(options){this.options=options}show(){notifications.push(this.options)}}
const Module=require('node:module'),load=Module._load
Module._load=function(request,parent,main){if(request==='electron')return {...electron,BrowserWindow:HiddenWindow,Notification:NotificationSpy};return load.call(this,request,parent,main)}
const deadline=setTimeout(()=>{console.error('PROJECTS_NATIVE_TIMEOUT');app.exit(2)},60000)
function captureRendered(win){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{win.webContents.removeListener('paint',painted);reject(Error('离屏新帧超时'))},5000);const painted=(_event,_dirty,image)=>{clearTimeout(timer);win.webContents.removeListener('paint',painted);resolve(image)};win.webContents.on('paint',painted);win.webContents.invalidate()})}
app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
  const js=code=>win.webContents.executeJavaScript(code).catch(e=>{throw Error(e.message+'\n表达式：'+code.slice(0,600))})
  const call=async(group,method,...args)=>{const r=await js(`window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`);assert.equal(r.ok,true,r.error);return r.data}
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
  const wait=async expression=>{const end=Date.now()+8000;while(!await js(expression)){if(Date.now()>end)throw Error('等待失败：'+expression+'\n'+await js('document.body.innerText'));await pause(30)}}
  const click=(label,scope='.page')=>js(`(()=>{const b=Array.from(document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)throw Error('按钮不可操作：'+${JSON.stringify(label)});b.click();return true})()`)
  const capture=async name=>{await js('document.fonts.ready.then(()=>true)');await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');await captureRendered(win);fs.writeFileSync(path.join(root,name),(await captureRendered(win)).toPNG())}
  const set=(selector,value)=>js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('缺少输入：'+${JSON.stringify(selector)});const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));return true})()`)
  try{
    await wait('!!window.api')
    if(phase==='resume'){
      const saved=JSON.parse(fs.readFileSync(path.join(root,'checkpoint.json'),'utf8')),detail=await call('projects','detail',saved.project)
      assert.equal(detail.tasks[0].milestone_id,saved.milestone);assert.equal(JSON.parse(detail.tasks[0].knowledge_refs_json)[0].concept_id,saved.concept)
      assert.equal((await call('tasks','listAll')).find(t=>t.id===saved.completed).status,'done')
      assert.equal(notifications.length,1);assert.match(notifications[0].body,/今日有 1 项任务到期/)
      await js("location.hash='/review'");await wait("document.body.innerText.includes('今日提醒样例')");assert.equal(await js("document.body.innerText.includes('一次勾选完成')"),false)
      console.log('PROJECTS_RESTART_OK project/milestone/knowledge uses, task completion and startup notification dispatch parameters');clearTimeout(deadline);app.exit(0);return
    }
    assert.deepEqual(await call('projects','list'),[])
    const concept=await call('concepts','save',{subject_id:null,name:'动量守恒',summary:'校验实验结果',aliases:[]})
    await js("location.hash='/projects'");await wait("document.querySelector('h1')?.textContent==='项目'");await click('+ 新建项目')
    await set('input[placeholder="如：桁架结构优化课程项目"]','振动测量项目');await set('textarea[placeholder="交付物、验收标准、约束条件…"]','采样后应用守恒律校验');await click('保存项目')
    await wait("document.querySelector('.row-list')?.textContent.includes('振动测量项目')")
    const project=(await call('projects','list'))[0]
    await js(`location.hash='/projects/${project.id}'`);await wait("document.querySelector('h1')?.textContent==='振动测量项目'")
    await set('input[placeholder="新里程碑，如：完成建模与求解"]','完成测量与报告');await click('+ 里程碑');await wait("document.body.innerText.includes('完成测量与报告')")
    const milestone=(await call('projects','detail',project.id)).milestones[0]
    await set('input[placeholder="新任务"]','建立测量模型');await set('.page select:has(option[value="'+milestone.id+'"])',milestone.id);await click('+ 任务');await wait("document.body.innerText.includes('建立测量模型')")
    await click('⚛ 关联知识点');await set('.page select:has(option[value="'+concept.id+'"])',concept.id);await set('input[placeholder="这个任务如何用到该知识点（选填）"]','用于验证测量前后动量');await click('保存')
    await wait("!!document.querySelector('.pill[title=\"用于验证测量前后动量\"]')")
    const task=(await call('projects','detail',project.id)).tasks[0];assert.equal(JSON.parse(task.knowledge_refs_json)[0].concept_id,concept.id)
    await capture('project.png')
    const now=new Date(),today=new Date(now.getFullYear(),now.getMonth(),now.getDate(),12).getTime()
    const complete=await call('tasks','create',{title:'一次勾选完成',due_at:today}), reminder=await call('tasks','create',{title:'今日提醒样例',due_at:today})
    await call('tasks','create',{title:'逾期样例',due_at:today-86400000});await call('tasks','create',{title:'未来样例',due_at:today+86400000})
    await js("location.hash='/review'");await wait("document.body.innerText.includes('一次勾选完成')")
    assert.match(await js('document.body.innerText'),/已逾期/);assert.match(await js('document.body.innerText'),/今日到期/);assert.match(await js('document.body.innerText'),/待安排（无截止日期）/)
    await js("document.querySelector('input[aria-label=\"完成任务：一次勾选完成\"]').click()")
    await wait("!document.querySelector('input[aria-label=\"完成任务：一次勾选完成\"]')")
    assert.equal((await call('tasks','listAll')).find(t=>t.id===complete.id).status,'done','日程复选框一次勾选即完成')
    await capture('schedule.png')
    await js("location.hash='/inspirations'");await wait("!!document.querySelector('.page .math-input-wrap textarea')")
    await set('.page .math-input-wrap textarea','$ $');await js("(()=>{const e=document.querySelector('.page textarea');e.focus();e.setSelectionRange(1,2);document.querySelector('.page .math-toggle').click();return true})()")
    await wait("!!document.querySelector('.page .math-palette-below')")
    assert.equal(await js("(()=>{const b=document.querySelector('.page .math-palette').getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight})()"),true,'顶部输入的面板不可超出窗口')
    await click('模板','.page .math-palette');await js("document.querySelector('.page .math-palette button[title=\"分式\"]').click()")
    await wait("document.querySelector('.page textarea')?.value.includes('frac') && document.querySelector('.page textarea').selectionStart===7")
    const caret=await js("({value:document.querySelector('.page textarea').value,position:document.querySelector('.page textarea').selectionStart})")
    assert.equal(caret.value,'$\\frac{}{}$');assert.equal(caret.position,7)
    await set('.page textarea','$\\frac{p}{m}$');await wait("document.querySelector('.page .math-preview annotation')?.textContent===String.raw`\\frac{p}{m}`")
    await js("document.querySelector('h1').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))");await wait("!document.querySelector('.page .math-palette')")
    await capture('math-input.png')
    await set('.quickbar input','abcd');await js("(()=>{const e=document.querySelector('.quickbar input');e.focus();e.setSelectionRange(1,3);document.querySelector('.quickbar .math-toggle').click();return true})()")
    assert.equal(await js("(()=>{const b=document.querySelector('.quickbar .math-palette').getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight})()"),true,'底部输入的面板不可超出窗口')
    await click('希腊小写','.quickbar .math-palette');await click('α','.quickbar .math-palette')
    await wait("document.querySelector('.quickbar input').value.includes('alpha')");assert.equal(await js("document.querySelector('.quickbar input').value"),'a\\alpha d')
    fs.writeFileSync(path.join(root,'checkpoint.json'),JSON.stringify({project:project.id,milestone:milestone.id,concept:concept.id,completed:complete.id,reminder:reminder.id}))
    console.log('PROJECTS_NATIVE_OK real project/knowledge forms, schedule grouping and single-click completion, formula insertion/caret/preview/selection');clearTimeout(deadline);app.exit(0)
  }catch(error){console.error(error.stack||error);clearTimeout(deadline);app.exit(1)}
}))
require('../out/main/index.js')
