(() => {
  'use strict';

  const C = window.APP_CONFIG || {
    supabaseUrl: 'https://viwaclirvokwoeqqivgr.supabase.co',
    supabasePublishableKey: 'sb_publishable_OoERhmKw2t5PSwMiYX2I0A_DZE04otZ'
  };
  const VOICE_FN = 'brivviant-voice-task';
  const SYNTHETIC_DOMAIN = 'brivviant-team.invalid';
  const state = { data: null, me: null, mode: null, timer: null, recognitionTranscript: '', lang: localStorage.getItem('briv-lang') || 'ar', pendingPause: null, pendingRevision: null, pendingApproval: null };
  const esc = (v='') => String(v).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const fmt = v => v ? new Intl.DateTimeFormat('ar-EG',{dateStyle:'medium',timeStyle:'short'}).format(new Date(v)) : '—';
  const monthKey = v => String(v||'').slice(0,7);
  const isManagement = () => ['ceo','team_leader'].includes(state.me?.role);
  const isCEO = () => state.me?.role === 'ceo';
  const byId = id => document.getElementById(id);

  function session() {
    const candidates = [];
    for (let i=0;i<localStorage.length;i++) {
      const k=localStorage.key(i); if(k && /^sb-.*-auth-token$/.test(k)) candidates.push(k);
    }
    for (const key of candidates) {
      try {
        const raw = JSON.parse(localStorage.getItem(key) || 'null');
        const value = Array.isArray(raw) ? raw[0] : raw;
        if (value?.access_token && value?.user?.id) return value;
      } catch {}
    }
    return null;
  }

  async function api(path, body, options={}) {
    const s=session();
    if(!s?.access_token) throw new Error('سجّل دخولك أولًا.');
    const headers={
      apikey:C.supabasePublishableKey,
      Authorization:`Bearer ${s.access_token}`,
      'Content-Type':'application/json',
      ...options.headers
    };
    const res=await fetch(`${C.supabaseUrl}${path}`,{method:options.method||'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
    const out=await res.json().catch(()=>null);
    if(!res.ok) throw new Error(out?.message||out?.error||out?.hint||`HTTP ${res.status}`);
    return out;
  }
  async function refresh() {
    const s=session(); if(!s) return null;
    const data=await api('/rest/v1/rpc/bv_state',{});
    data.archived_tasks ||= [];
    data.point_ledger ||= [];
    data.requests ||= [];
    data.assignments ||= [];
    data.task_stages ||= [];
    data.quality_flags ||= [];
    data.revisions ||= [];
    data.profiles ||= [];
    data.tasks ||= [];
    state.data=data;
    state.me=data.profiles.find(p=>p.id===s.user.id)||null;
    return data;
  }
  async function action(name,p={}) {
    const out=await api('/rest/v1/rpc/bv_action',{p_action:name,p});
    await refresh();
    toast('تم حفظ التغيير');
    patchAll();
    if(state.mode) renderCustom(state.mode);
    return out;
  }

  function toast(msg,bad=false) {
    let el=byId('v11-toast');
    if(!el){el=document.createElement('div');el.id='v11-toast';document.body.appendChild(el);}
    el.textContent=msg;el.className=bad?'bad show':'show';
    clearTimeout(el._t);el._t=setTimeout(()=>el.className='',3200);
  }

  function modal(title, html) {
    let shell=byId('v11-modal');
    if(!shell){
      shell=document.createElement('div');shell.id='v11-modal';
      shell.innerHTML='<div class="v11-modal-backdrop"></div><div class="v11-modal-card" dir="rtl"><button class="v11-modal-x" aria-label="إغلاق">×</button><h2></h2><div class="v11-modal-body"></div></div>';
      document.body.appendChild(shell);
      shell.querySelector('.v11-modal-backdrop').onclick=closeModal;
      shell.querySelector('.v11-modal-x').onclick=closeModal;
    }
    shell.querySelector('h2').textContent=title;
    shell.querySelector('.v11-modal-body').innerHTML=html;
    shell.classList.add('open');
    return shell;
  }
  function closeModal(){byId('v11-modal')?.classList.remove('open');}

  function ensureTabs(){
    const list=document.querySelector('.main-tabs'); if(!list||!state.data) return;
    const add=(key,label,admin=false)=>{
      if(admin&&!isManagement())return;
      if(list.querySelector(`[data-v11-tab="${key}"]`))return;
      const b=document.createElement('button');b.type='button';b.className='v11-tab';b.dataset.v11Tab=key;b.textContent=label;
      b.onclick=()=>showCustom(key);list.appendChild(b);
    };
    add('workflow','المراحل / Workflow');
    add('delivered','تم التسليم');
    add('reports','التقارير الشهرية',true);
    list.querySelectorAll('[data-slot="tabs-trigger"]').forEach(btn=>{
      if(btn.dataset.v11Bound)return;btn.dataset.v11Bound='1';
      btn.addEventListener('click',()=>hideCustom(),true);
    });
  }
  function customHost(){
    let h=byId('v11-custom-content');
    if(!h){h=document.createElement('section');h.id='v11-custom-content';h.dir='rtl';const list=document.querySelector('.main-tabs');list?.insertAdjacentElement('afterend',h);}
    return h;
  }
  function showCustom(key){state.mode=key;document.querySelectorAll('[data-slot="tabs-content"]').forEach(x=>x.style.display='none');document.querySelectorAll('.v11-tab').forEach(x=>x.classList.toggle('active',x.dataset.v11Tab===key));renderCustom(key);}
  function hideCustom(){state.mode=null;document.querySelectorAll('[data-slot="tabs-content"]').forEach(x=>x.style.removeProperty('display'));document.querySelectorAll('.v11-tab').forEach(x=>x.classList.remove('active'));byId('v11-custom-content')?.remove();}
  function renderCustom(key){const h=customHost(); if(key==='workflow')renderWorkflow(h); else if(key==='delivered')renderDelivered(h); else if(key==='reports')renderReports(h); applyLanguage();}

  function pointsFor(userId, month=null){return (state.data?.point_ledger||[]).filter(x=>x.user_id===userId&&['project_score','manual_adjustment'].includes(x.kind)&&(!month||monthKey(x.created_at)===month)).reduce((n,x)=>n+Number(x.points||0),0);}
  function taskById(id){return [...(state.data?.tasks||[]),...(state.data?.archived_tasks||[])].find(t=>t.id===id);}
  function projectScoreFor(taskId,userId){return (state.data?.point_ledger||[]).filter(x=>x.task_id===taskId&&x.user_id===userId&&x.kind==='project_score').reduce((n,x)=>n+Number(x.points||0),0);}
  function person(id){return state.data?.profiles?.find(p=>p.id===id);}

  const STAGE_STATUS={pending:'بانتظار البدء',working:'قيد التنفيذ',paused:'متوقف مؤقتًا',submitted:'بانتظار الاعتماد',approved:'معتمد'};
  const STAGE_STATUS_EN={pending:'Pending',working:'In Progress',paused:'Paused',submitted:'Awaiting Approval',approved:'Approved'};
  const stageRows=taskId=>(state.data?.task_stages||[]).filter(x=>x.task_id===taskId).sort((a,b)=>Number(a.sort_order)-Number(b.sort_order));
  const hms=ms=>{const h=Math.max(0,Number(ms||0))/3600000;return `${h.toFixed(h>=10?1:2)}h`;};
  const stageElapsed=s=>Number(s.elapsed_ms||0)+(s.running_since?Math.max(0,Date.now()-Date.parse(s.running_since)):0);
  const L=(ar,en)=>state.lang==='en'?en:ar;

  function renderWorkflow(h){
    const tasks=(state.data?.tasks||[]);
    h.innerHTML=`<div class="section-title v11-title"><div><h2>${L('مراحل تنفيذ المشاريع','Project Workflow')}</h2><p class="muted">${L('توزيع المشروع على مراحل محددة بالساعات، مع اعتماد كل مرحلة قبل الانتقال لما بعدها.','Plan each project by stage and hours, with approval gates before the next stage starts.')}</p></div></div>
    <div class="v12-score-guide panel"><b>${L('طريقة احتساب النقاط','How project points are calculated')}</b><p>${L('النقاط تُحتسب عند اعتماد المشروع بالكامل بناءً على الساعات المخططة مقابل الفعلية. أي تعديل بسبب خطأ من الشخص أو إيقاف وقت بسبب تقصير منه يجعل نقاطه في المشروع = 0.','Points are posted only after final project approval, based on planned vs actual stage hours. Any self-caused error revision or negligence pause makes that person’s project score 0.')}</p></div>
    <div class="v12-workflow-stack">${tasks.map(renderWorkflowTask).join('')}</div>`;
    h.querySelectorAll('[data-v12-config]').forEach(b=>b.onclick=()=>openWorkflowConfig(taskById(b.dataset.v12Config)));
    h.querySelectorAll('[data-v12-stage-action]').forEach(b=>b.onclick=()=>handleStageAction(b.dataset.v12StageAction,b.dataset.task,b.dataset.stage));
    h.querySelectorAll('[data-v12-quality]').forEach(b=>b.onclick=()=>openQuality(taskById(b.dataset.task),b.dataset.stage));
    h.querySelectorAll('[data-v12-approve-project]').forEach(b=>b.onclick=()=>openProjectApproval(taskById(b.dataset.v12ApproveProject)));
  }

  function renderWorkflowTask(task){
    const stages=stageRows(task.id), approved=stages.filter(s=>s.status==='approved').length, owner=person(task.owner_user_id), audit=task.approved_at;
    const controls=isManagement()&&(!stages.length||stages.every(s=>s.status==='pending'))?`<button class="v12-small" data-v12-config="${task.id}">${stages.length?L('تعديل الخطة','Edit Plan'):L('إعداد المراحل والساعات','Set Stages & Hours')}</button>`:'';
    const approveBtn=isManagement()&&stages.length&&approved===stages.length&&!task.approved_at?`<button class="v12-small primary" data-v12-approve-project="${task.id}">${L('اعتماد المشروع واحتساب النقاط','Approve Project & Score')}</button>`:'';
    return `<article class="panel v12-workflow-card"><div class="v12-workflow-head"><div><h3>${esc(task.title)}</h3><small>${L('Task Owner','Task Owner')}: ${esc(owner?.name||L('غير محدد','Not Set'))}</small></div><div class="v12-progress"><b>${approved}/${stages.length||0}</b><small>${L('مراحل معتمدة','approved stages')}</small></div><div class="v12-head-actions">${controls}${approveBtn}</div></div>
    ${!stages.length?`<div class="v11-empty">${L('لم يتم إعداد Workflow لهذا المشروع بعد.','No workflow has been configured for this project yet.')}</div>`:`<div class="v12-stage-list">${stages.map(s=>renderStage(task,s)).join('')}</div>`}
    ${audit?renderApprovalAudit(task):''}</article>`;
  }

  function renderStage(task,s){
    const mine=s.assigned_user_id===state.me?.id, mgmt=isManagement(), actual=stageElapsed(s), status=(state.lang==='en'?STAGE_STATUS_EN:STAGE_STATUS)[s.status]||s.status;
    let actions='';
    if(mine&&s.status==='pending')actions+=`<button class="v12-stage-btn" data-v12-stage-action="start" data-task="${task.id}" data-stage="${s.id}">${L('بدء','Start')}</button>`;
    if(mine&&s.status==='working')actions+=`<button class="v12-stage-btn" data-v12-stage-action="pause" data-task="${task.id}" data-stage="${s.id}">${L('إيقاف','Pause')}</button><button class="v12-stage-btn primary" data-v12-stage-action="submit" data-task="${task.id}" data-stage="${s.id}">${L('تسليم المرحلة','Submit Stage')}</button>`;
    if(mine&&s.status==='paused')actions+=`<button class="v12-stage-btn" data-v12-stage-action="resume" data-task="${task.id}" data-stage="${s.id}">${L('استكمال','Resume')}</button><button class="v12-stage-btn primary" data-v12-stage-action="submit" data-task="${task.id}" data-stage="${s.id}">${L('تسليم المرحلة','Submit Stage')}</button>`;
    if(mgmt&&s.status==='submitted')actions+=`<button class="v12-stage-btn primary" data-v12-stage-action="approve" data-task="${task.id}" data-stage="${s.id}">${L('اعتماد المرحلة','Approve Stage')}</button>`;
    if(mgmt)actions+=`<button class="v12-stage-btn danger" data-v12-quality="1" data-task="${task.id}" data-stage="${s.id}">${L('ملاحظة جودة','Quality Flag')}</button>`;
    return `<div class="v12-stage-row"><span class="v12-stage-order">${s.sort_order}</span><div class="v12-stage-main"><b>${esc(state.lang==='en'?(s.title_en||s.title_ar):(s.title_ar||s.title_en))}</b><small>${esc(person(s.assigned_user_id)?.name||'—')}</small></div><span class="v12-hours"><b>${Number(s.planned_hours).toFixed(1)}h</b><small>${L('مخطط','planned')}</small></span><span class="v12-hours"><b>${hms(actual)}</b><small>${L('فعلي','actual')}</small></span><span class="v12-stage-status ${s.status}">${esc(status)}</span><div class="v12-stage-actions">${actions}</div></div>`;
  }

  function renderApprovalAudit(task){
    const who=person(task.final_approved_by), owner=person(task.owner_user_id), rev=(state.data?.revisions||[]).filter(x=>x.task_id===task.id), flags=(state.data?.quality_flags||[]).filter(x=>x.task_id===task.id);
    return `<details class="v12-audit"><summary>${L('سجل اعتماد المشروع للـCEO','Project Approval Audit')}</summary><div><p><b>${L('Task Owner','Task Owner')}:</b> ${esc(owner?.name||'—')}</p><p><b>${L('اعتمد بواسطة','Approved by')}:</b> ${esc(who?.name||'—')} · ${fmt(task.approved_at)}</p>${task.final_approval_note?`<p><b>${L('ملاحظة الاعتماد','Approval note')}:</b> ${esc(task.final_approval_note)}</p>`:''}<p><b>${L('التعديلات المسجلة','Recorded revisions')}:</b> ${rev.length}</p>${rev.map(x=>`<small class="v12-audit-line">${fmt(x.created_at)} · ${esc(x.note)}${x.is_error?` · ${L('خطأ مسؤول عنه','Error by')}: ${esc(person(x.responsible_user_id)?.name||'—')}`:''}</small>`).join('')}<p><b>${L('ملاحظات الجودة المؤثرة على النقاط','Quality flags affecting points')}:</b> ${flags.length}</p>${flags.map(x=>`<small class="v12-audit-line danger">${esc(person(x.user_id)?.name||'')} · ${esc(x.note)}</small>`).join('')}</div></details>`;
  }

  function openWorkflowConfig(task){
    if(!task)return;
    const profiles=(state.data?.profiles||[]).filter(p=>p.active), tls=profiles.filter(p=>p.role==='team_leader'), managers=profiles.filter(p=>['team_leader','ceo'].includes(p.role)), designers=profiles.filter(p=>['employee','team_leader','ceo'].includes(p.role));
    const existing=stageRows(task.id);
    const defaultUser=task.owner_user_id||designers.find(p=>p.role==='employee')?.id||designers[0]?.id||'';
    const reviewUser=tls[0]?.id||managers[0]?.id||defaultUser;
    const defaults=existing.length?existing.map(x=>({stage_key:x.stage_key,title_ar:x.title_ar,title_en:x.title_en,planned_hours:x.planned_hours,user_id:x.assigned_user_id})):[
      {stage_key:'brief_review',title_ar:'مراجعة البريف',title_en:'Brief Review',planned_hours:1,user_id:reviewUser},
      {stage_key:'direction',title_ar:'الديريكشن والاعتماد',title_en:'Direction & Approval',planned_hours:4,user_id:defaultUser},
      {stage_key:'modeling',title_ar:'Modeling / خروج العناصر',title_en:'Modeling / Element Development',planned_hours:6,user_id:defaultUser},
      {stage_key:'render',title_ar:'الرندر',title_en:'Rendering',planned_hours:8,user_id:defaultUser},
      {stage_key:'finalization',title_ar:'الفاينليزيشن',title_en:'Finalization',planned_hours:2,user_id:defaultUser},
      {stage_key:'delivery',title_ar:'التسليم',title_en:'Delivery',planned_hours:1,user_id:defaultUser},
    ];
    const opts=id=>profiles.map(p=>`<option value="${p.id}" ${p.id===id?'selected':''}>${esc(p.name)} · ${esc(p.role)}</option>`).join('');
    const m=modal(L('إعداد مراحل المشروع والساعات','Configure Project Stages & Hours'),`<form id="v12-workflow-form"><label><span>${L('Task Owner','Task Owner')}</span><select name="owner_user_id" required>${opts(task.owner_user_id||defaultUser)}</select></label><div class="v12-config-stages">${defaults.map((x,i)=>`<div class="v12-config-stage" data-row="${i}"><div><b>${i+1}. ${esc(x.title_ar)}</b>${i===2?`<select class="v12-middle-type"><option value="modeling" ${x.stage_key==='modeling'?'selected':''}>Modeling</option><option value="elements" ${x.stage_key==='elements'?'selected':''}>خروج العناصر / Elements</option></select>`:''}</div><label><span>${L('المسؤول','Assignee')}</span><select class="v12-user">${opts(x.user_id)}</select></label><label><span>${L('الساعات المخططة','Planned Hours')}</span><input class="v12-hours-input" type="number" min="0.25" max="999" step="0.25" value="${Number(x.planned_hours)}" required></label><input class="v12-stage-key" type="hidden" value="${esc(x.stage_key)}"><input class="v12-title-ar" type="hidden" value="${esc(x.title_ar)}"><input class="v12-title-en" type="hidden" value="${esc(x.title_en)}"></div>`).join('')}</div><button type="submit">${L('حفظ Workflow المشروع','Save Project Workflow')}</button></form>`);
    m.querySelectorAll('.v12-middle-type').forEach(sel=>sel.onchange=()=>{const row=sel.closest('.v12-config-stage');const model=sel.value==='modeling';row.querySelector('.v12-stage-key').value=sel.value;row.querySelector('.v12-title-ar').value=model?'Modeling / خروج العناصر':'خروج العناصر';row.querySelector('.v12-title-en').value=model?'Modeling / Element Development':'Element Development';row.querySelector('b').textContent=`3. ${model?'Modeling / خروج العناصر':'خروج العناصر'}`;});
    m.querySelector('#v12-workflow-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const stages=[...m.querySelectorAll('.v12-config-stage')].map(row=>({stage_key:row.querySelector('.v12-stage-key').value,title_ar:row.querySelector('.v12-title-ar').value,title_en:row.querySelector('.v12-title-en').value,planned_hours:Number(row.querySelector('.v12-hours-input').value),user_id:row.querySelector('.v12-user').value}));try{await action('save_workflow',{task_id:task.id,version:task.version,owner_user_id:String(f.get('owner_user_id')),stages});closeModal();showCustom('workflow')}catch(err){toast(err.message,true)}};
  }

  async function handleStageAction(kind,taskId,stageId){
    const task=taskById(taskId);if(!task)return;
    try{
      if(kind==='pause')return openStagePause(task,stageId);
      if(kind==='submit'){const note=prompt(L('ملاحظة تسليم المرحلة (اختياري)','Stage submission note (optional)'))||'';await action('stage_submit',{task_id:task.id,version:task.version,stage_id:stageId,note});}
      else if(kind==='approve')await action('stage_approve',{task_id:task.id,version:task.version,stage_id:stageId});
      else await action(`stage_${kind}`,{task_id:task.id,version:task.version,stage_id:stageId});
    }catch(e){toast(e.message,true)}
  }
  function openStagePause(task,stageId){
    const m=modal(L('إيقاف وقت المرحلة','Pause Stage Timer'),`<form id="v12-stage-pause"><label><span>${L('سبب الإيقاف','Pause reason')}</span><textarea name="pause_reason" rows="3" required></textarea></label><label><span>${L('نوع الإيقاف','Pause type')}</span><select name="pause_kind"><option value="external">${L('سبب خارجي / انتظار اعتماد / استراحة مخططة','External / approval wait / planned break')}</option><option value="negligence">${L('تقصير شخصي — يصفر نقاط المشروع','Personal negligence — project score becomes 0')}</option></select></label><button type="submit">${L('إيقاف الوقت','Pause Timer')}</button></form>`);
    m.querySelector('#v12-stage-pause').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await action('stage_pause',{task_id:task.id,version:task.version,stage_id:stageId,pause_reason:String(f.get('pause_reason')),pause_kind:String(f.get('pause_kind'))});closeModal()}catch(err){toast(err.message,true)}};
  }
  function openQuality(task,stageId){
    const stage=(state.data?.task_stages||[]).find(x=>x.id===stageId), profiles=(state.data?.profiles||[]).filter(p=>p.active);
    const m=modal(L('ملاحظة جودة تؤثر على النقاط','Quality Flag Affecting Points'),`<form id="v12-quality-form"><label><span>${L('المسؤول','Responsible Person')}</span><select name="user_id">${profiles.map(p=>`<option value="${p.id}" ${p.id===stage?.assigned_user_id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><label><span>${L('السبب','Reason')}</span><select name="kind"><option value="error_revision">${L('تعديل بسبب خطأ منه','Revision caused by own error')}</option><option value="negligent_pause">${L('إيقاف/تأخير بسبب تقصير','Pause/delay caused by negligence')}</option></select></label><label><span>${L('التفاصيل','Details')}</span><textarea name="note" rows="4" required></textarea></label><button type="submit">${L('تسجيل الملاحظة','Save Flag')}</button></form>`);
    m.querySelector('#v12-quality-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await action('flag_quality',{task_id:task.id,version:task.version,stage_id:stageId,user_id:String(f.get('user_id')),kind:String(f.get('kind')),note:String(f.get('note'))});closeModal()}catch(err){toast(err.message,true)}};
  }
  function openProjectApproval(task){
    const m=modal(L('اعتماد المشروع النهائي','Final Project Approval'),`<form id="v12-approval-form"><p>${L('سيتم حفظ Task Owner، المراحل، التعديلات، وملاحظات الجودة في Snapshot الاعتماد، ثم احتساب النقاط على مستوى المشروع.','Task owner, stages, revisions and quality flags will be saved in the approval snapshot, then project-level points will be calculated.')}</p><label><span>${L('ملاحظة الاعتماد (اختياري)','Approval note (optional)')}</span><textarea name="approval_note" rows="4"></textarea></label><button type="submit">${L('اعتماد واحتساب النقاط','Approve & Calculate Points')}</button></form>`);
    m.querySelector('#v12-approval-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await action('approve',{task_id:task.id,version:task.version,approval_note:String(f.get('approval_note')||'')});closeModal()}catch(err){toast(err.message,true)}};
  }

  function renderDelivered(h){
    const tasks=state.data?.archived_tasks||[];
    h.innerHTML=`<div class="section-title v11-title"><div><h2>تم التسليم</h2><p class="muted">التاسكات المنقولة من القائمة تفضل هنا بكل التسليمات والوقت والنقاط.</p></div><button class="v11-refresh">تحديث</button></div>${tasks.length?`<div class="panel v11-archive-list">${tasks.map(t=>{
      const as=(state.data.assignments||[]).filter(a=>a.task_id===t.id);
      const names=[...new Set(as.map(a=>person(a.user_id)?.name).filter(Boolean))];
      const pts=(state.data.point_ledger||[]).filter(x=>x.task_id===t.id).reduce((s,x)=>s+Number(x.points||0),0);
      const subs=as.filter(a=>a.submitted_at);
      return `<details class="v11-archive-row"><summary><span class="v11-archive-icon">✓</span><span><b>${esc(t.title)}</b><small>${esc(names.join(' · ')||'بدون تكليف')}</small></span><span class="v11-badge">تم التسليم</span><span><b>${fmt(t.deleted_at||t.updated_at)}</b><small>تاريخ النقل</small></span><span><b>${pts}</b><small>نقاط محفوظة</small></span></summary><div class="v11-archive-detail"><p><b>البريف:</b> ${esc(t.brief||'—')}</p><p><b>لينك البريف:</b> ${t.drive_url?`<a href="${esc(t.drive_url)}" target="_blank" rel="noreferrer">فتح Drive</a>`:'—'}</p>${subs.length?`<div class="v11-mini-table"><b>التسليمات</b>${subs.map(a=>`<div><span>${esc(person(a.user_id)?.name||'')}</span><span>${fmt(a.submitted_at)}</span><span>${a.submission_url?`<a href="${esc(a.submission_url)}" target="_blank">الملفات</a>`:'—'}</span><strong>${projectScoreFor(t.id,a.user_id)>0?'+':''}${projectScoreFor(t.id,a.user_id)}</strong></div>`).join('')}</div>`:'<p>لا توجد تسليمات محفوظة.</p>'}</div></details>`;
    }).join('')}</div>`:`<div class="panel empty-state"><h3>لا توجد تاسكات منقولة بعد</h3><p>لما الإدارة تنقل تاسك إلى تم التسليم هيظهر هنا بدل ما يختفي.</p></div>`}`;
    h.querySelector('.v11-refresh')?.addEventListener('click',async()=>{try{await refresh();renderDelivered(h)}catch(e){toast(e.message,true)}});
  }

  function renderReports(h){
    if(!isManagement()){h.innerHTML='';return;}
    const current=h.dataset.month||new Date().toISOString().slice(0,7);
    const selected=h.dataset.user||'all';
    const profiles=(state.data?.profiles||[]).filter(p=>selected==='all'||p.id===selected);
    const assignments=(state.data?.assignments||[]).filter(a=>a.submitted_at&&monthKey(a.submitted_at)===current);
    const ledger=(state.data?.point_ledger||[]).filter(x=>monthKey(x.created_at)===current);
    h.innerHTML=`<div class="section-title v11-title"><div><h2>التقارير الشهرية لكل حساب</h2><p class="muted">التسليمات، التأخير، النقاط، والزيادة/الخصم اليدوي.</p></div></div><div class="panel v11-report-filters"><label><span>الشهر</span><input id="v11-report-month" type="month" value="${esc(current)}"></label><label><span>الحساب</span><select id="v11-report-user"><option value="all">كل الحسابات</option>${(state.data.profiles||[]).map(p=>`<option value="${p.id}" ${selected===p.id?'selected':''}>${esc(p.name)} · ${esc(p.username)}</option>`).join('')}</select></label></div><div class="v11-report-stack">${profiles.map(p=>{
      const subs=assignments.filter(a=>a.user_id===p.id);
      const led=ledger.filter(x=>x.user_id===p.id);
      const late=subs.filter(a=>{const task=taskById(a.task_id);const dl=a.deadline_at||task?.due_at;return dl&&Date.parse(a.submitted_at)>Date.parse(dl);});
      const monthly=led.reduce((s,x)=>s+Number(x.points||0),0);
      const total=pointsFor(p.id);
      const adj=led.filter(x=>x.kind==='manual_adjustment');
      return `<article class="panel v11-report-card"><div class="v11-report-head"><div><h3>${esc(p.name)}</h3><small dir="ltr">${esc(p.username)}@${SYNTHETIC_DOMAIN}</small></div><div class="v11-kpis"><span><b>${subs.length}</b><small>تسليم</small></span><span class="${late.length?'danger':''}"><b>${late.length}</b><small>متأخر</small></span><span><b>${monthly}</b><small>نقطة الشهر</small></span><span><b>${total}</b><small>إجمالي النقاط</small></span></div></div>${subs.length?`<div class="v11-table-wrap"><table><thead><tr><th>التاسك</th><th>التسليم</th><th>Deadline</th><th>التأخير</th><th>النقاط</th></tr></thead><tbody>${subs.map(a=>{const t=taskById(a.task_id);const dl=a.deadline_at||t?.due_at;const l=dl&&Date.parse(a.submitted_at)>Date.parse(dl);return `<tr><td>${esc(t?.title||'تاسك مؤرشف')}</td><td>${fmt(a.submitted_at)}</td><td>${fmt(dl)}</td><td>${l?`<span class="v11-late">متأخر${a.delay_reason?` · ${esc(a.delay_reason)}`:''}</span>`:'في الموعد'}</td><td>${projectScoreFor(a.task_id,a.user_id)}</td></tr>`;}).join('')}</tbody></table></div>`:'<p class="v11-empty">لا توجد تسليمات في الشهر المحدد.</p>'}${adj.length?`<div class="v11-adjustments"><b>تعديلات الإدارة على النقاط</b>${adj.map(x=>`<div><strong class="${x.points<0?'minus':''}">${x.points>0?'+':''}${x.points}</strong><span>${esc(x.reason)}</span><small>${fmt(x.created_at)} · ${esc(person(x.created_by)?.name||'')}</small></div>`).join('')}</div>`:''}</article>`;
    }).join('')}</div>`;
    byId('v11-report-month').onchange=e=>{h.dataset.month=e.target.value;renderReports(h)};
    byId('v11-report-user').onchange=e=>{h.dataset.user=e.target.value;renderReports(h)};
  }

  function patchTeam(){
    if(!isManagement())return;
    document.querySelectorAll('.member-card').forEach(card=>{
      const text=card.textContent||'';
      const profile=(state.data.profiles||[]).find(p=>text.includes(p.username)||text.includes(p.name));
      if(!profile)return;
      const score=card.querySelector('.member-score strong'); if(score)score.textContent=String(pointsFor(profile.id));
      const actions=card.querySelector('.button-row');
      if(actions&&!actions.querySelector('.v11-points-btn')){
        const b=document.createElement('button');b.type='button';b.className='v11-points-btn';b.textContent='± نقاط';b.onclick=()=>openPoints(profile);actions.prepend(b);
      }
    });
  }
  function openPoints(profile){
    const m=modal('زيادة / خصم نقاط',`<div class="v11-person"><b>${esc(profile.name)}</b><small>${pointsFor(profile.id)} نقطة حاليًا</small></div><form id="v11-points-form"><label><span>النقاط (+ إضافة / - خصم)</span><input name="points" type="number" min="-10000" max="10000" step="1" placeholder="مثال: 25 أو -10" required></label><label><span>السبب</span><textarea name="reason" rows="3" required></textarea></label><button type="submit">حفظ تعديل النقاط</button></form>`);
    m.querySelector('#v11-points-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await action('adjust_points',{user_id:profile.id,points:Number(f.get('points')),reason:String(f.get('reason')||'')});closeModal()}catch(err){toast(err.message,true)}};
  }

  function patchRequests(){
    const body=document.querySelector('.request-table tbody'); if(!body||!state.data)return;
    const used=new Set();
    [...body.querySelectorAll('tr')].forEach(row=>{
      const cells=row.querySelectorAll('td');if(cells.length<3)return;
      const owner=(cells[0].querySelector('b')?.textContent||'').trim();
      const title=(cells[2].querySelector('b')?.textContent||'').trim();
      const q=(state.data.requests||[]).find(x=>!used.has(x.id)&&x.title===title&&(person(x.created_by)?.name||'')===owner);
      if(!q)return;used.add(q.id);row.dataset.v11Request=q.id;
      if(q.kind==='leave'){
        cells[1].textContent='طلب إجازة';
        if(q.leave_from&&!cells[2].querySelector('.v11-leave-dates')) cells[2].insertAdjacentHTML('beforeend',`<small class="table-detail v11-leave-dates">الإجازة: ${esc(q.leave_from)} → ${esc(q.leave_to||q.leave_from)}</small>`);
      }
      const badge=row.querySelector('.status');if(q.status==='rejected'&&badge)badge.textContent='مرفوض';
      if(q.status==='rejected'&&q.rejection_reason&&!cells[2].querySelector('.v12-rejection-reason')) cells[2].insertAdjacentHTML('beforeend',`<div class="v12-rejection-reason"><b>${L('سبب الرفض','Rejection reason')}:</b> ${esc(q.rejection_reason)}</div>`);
      if(q.escalation_required&&!cells[2].querySelector('.v11-escalation')) cells[2].insertAdjacentHTML('beforeend',`<small class="v11-escalation">⚠ مرفوض سابقًا — محاولة ${Number(q.attempt_no||2)} ومُصعّد للإدارة</small>`);
      if(isManagement()){
        const actions=row.querySelector('.request-actions');
        if(actions){
          const destructive=[...actions.querySelectorAll('button')].find(b=>(b.textContent||'').includes('حذف'));
          if(q.escalation_required&&state.me.role==='team_leader'&&destructive){destructive.disabled=true;destructive.title='الطلب مُصعّد؛ الـTeam Leader لا يقدر يحذفه.';}
          if(!(q.escalation_required&&state.me.role==='team_leader')&&!actions.querySelector('.v11-reject-btn')&&q.status!=='done'&&q.status!=='rejected'){
            const b=document.createElement('button');b.type='button';b.className='v11-reject-btn';b.textContent='رفض';
            b.onclick=async()=>{const reason=prompt('سبب الرفض — إجباري:');if(!reason?.trim())return;try{await action('update_request',{id:q.id,status:'rejected',response:reason.trim(),execution_due_at:''})}catch(e){toast(e.message,true)}};
            actions.appendChild(b);
          }
        }
      } else if(q.created_by===state.me?.id&&q.status==='rejected'&&!cells[2].querySelector('.v11-resubmit-btn')){
        const b=document.createElement('button');b.type='button';b.className='v11-resubmit-btn';b.textContent='إعادة تقديم — تصعيد';b.onclick=async()=>{try{await action('resubmit_request',{id:q.id})}catch(e){toast(e.message,true)}};cells[2].appendChild(b);
      }
    });
    const title=document.querySelector('[data-slot="tabs-content"][data-state="active"] .section-title');
    if(title&&(title.textContent||'').includes('طلب')&&!title.querySelector('.v11-leave-btn')){
      const b=document.createElement('button');b.type='button';b.className='v11-leave-btn';b.textContent='طلب إجازة';b.onclick=openLeave;title.appendChild(b);
    }
  }
  function openLeave(){
    const m=modal('طلب إجازة',`<form id="v11-leave-form"><div class="v11-two"><label><span>من</span><input name="leave_from" type="date" required></label><label><span>إلى</span><input name="leave_to" type="date" required></label></div><label><span>العنوان</span><input name="title" maxlength="180" value="طلب إجازة" required></label><label><span>التفاصيل</span><textarea name="body" rows="4" required></textarea></label><button type="submit">إرسال للإدارة</button></form>`);
    m.querySelector('#v11-leave-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await action('create_request',{kind:'leave',title:String(f.get('title')),body:String(f.get('body')),leave_from:String(f.get('leave_from')),leave_to:String(f.get('leave_to'))});closeModal()}catch(err){toast(err.message,true)}};
  }

  function patchDeleteCopy(){
    document.querySelectorAll('[data-slot="alert-dialog-description"]').forEach(el=>{
      if((el.textContent||'').includes('هيختفي من قوائم الفريق')) el.textContent='هيتنقل من قائمة التاسكات إلى صفحة «تم التسليم». السجل والتسليمات والوقت والنقاط هيفضلوا محفوظين بالكامل.';
    });
  }

  let recorder=null,chunks=[],recognizer=null;
  function ensureVoiceButton(){
    if(!isManagement())return;
    const heading=document.querySelector('.heading-row'); if(!heading||heading.querySelector('.v11-voice-btn'))return;
    const primary=[...heading.querySelectorAll('button')].find(b=>(b.textContent||'').includes('تاسك جديد'));
    const b=document.createElement('button');b.type='button';b.className='v11-voice-btn';b.textContent='🎙 إضافة بالصوت';b.onclick=openVoice;
    if(primary)primary.parentElement?.insertBefore(b,primary);else heading.appendChild(b);
  }
  function openVoice(){
    const m=modal('إضافة تاسك بالصوت',`<div class="v11-voice"><label><span>لينك البريف — اختياري للإدارة</span><input id="v11-voice-drive" type="url" dir="ltr" placeholder="لو فاضي هيتحط Test تلقائيًا"></label><div class="v11-recorder"><div class="v11-mic">🎙</div><b id="v11-voice-status">جاهز للتسجيل</b><p>مثال: «تاسك تصميم البوابة مع أوسكار، تسليمه بكرة الساعة 6 مساءً».</p><button id="v11-record-btn" type="button">ابدأ التسجيل</button></div><small>Gemini يجرب Pool من الموديلات المتاحة. لو كلها غير متاحة، هنستخدم التفريغ الصوتي الخاص بالمتصفح + Parser بسيط، ولو ده غير متاح هنرجع للفورم العادي بدون تعطيل السيستم.</small></div>`);
    m.querySelector('#v11-record-btn').onclick=startRecording;
  }
  let voiceStopping=false,voiceStream=null,voiceTimeout=null;
  async function startRecording(){
    const btn=byId('v11-record-btn');if(btn)btn.disabled=true;
    try{
      if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined')throw Error('المتصفح لا يدعم التسجيل. افتح الموقع في Chrome أو Safari مع إذن الميكروفون.');
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      voiceStream=stream;voiceStopping=false;chunks=[];state.recognitionTranscript='';
      const preferred=['audio/webm;codecs=opus','audio/mp4','audio/webm','audio/ogg'].find(x=>MediaRecorder.isTypeSupported?.(x));
      recorder=new MediaRecorder(stream,preferred?{mimeType:preferred}:undefined);
      recorder.ondataavailable=e=>{if(e.data?.size)chunks.push(e.data);};
      recorder.onstop=()=>{clearTimeout(voiceTimeout);void handleVoiceStop(new Blob(chunks,{type:recorder?.mimeType||'audio/webm'}),stream);};
      recorder.onerror=()=>{stream.getTracks().forEach(t=>t.stop());voiceStopping=false;toast('حصل خطأ في تسجيل الصوت.',true);};
      const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
      if(SR){try{recognizer=new SR();recognizer.lang='ar-EG';recognizer.continuous=false;recognizer.interimResults=false;recognizer.onresult=e=>{for(let i=e.resultIndex;i<e.results.length;i++)if(e.results[i].isFinal)state.recognitionTranscript+=' '+e.results[i][0].transcript;};recognizer.start();}catch{recognizer=null;}}
      recorder.start(1000);
      const status=byId('v11-voice-status');if(status)status.textContent='جاري التسجيل… اضغط إيقاف لإنشاء التاسك';
      if(btn){btn.disabled=false;btn.textContent='■ إيقاف التسجيل وإنشاء التاسك';btn.onclick=stopVoiceRecording;}
      voiceTimeout=setTimeout(()=>{if(recorder?.state==='recording')stopVoiceRecording();},90000);
    }catch(e){voiceStream?.getTracks().forEach(t=>t.stop());voiceStream=null;if(btn){btn.disabled=false;btn.textContent='ابدأ التسجيل';btn.onclick=startRecording;}toast(e?.message||'تعذر فتح الميكروفون.',true);}
  }
  function stopVoiceRecording(){
    if(voiceStopping)return;voiceStopping=true;
    const btn=byId('v11-record-btn'),status=byId('v11-voice-status');
    if(btn){btn.disabled=true;btn.textContent='جاري إيقاف التسجيل…';}
    if(status)status.textContent='جاري تجهيز التسجيل…';
    clearTimeout(voiceTimeout);
    try{recognizer?.stop();}catch{}
    try{
      if(recorder&&recorder.state!=='inactive'){recorder.requestData?.();recorder.stop();}
      else{voiceStream?.getTracks().forEach(t=>t.stop());voiceStopping=false;if(btn)btn.disabled=false;}
    }catch(e){voiceStream?.getTracks().forEach(t=>t.stop());voiceStopping=false;if(btn)btn.disabled=false;toast('تعذر إيقاف التسجيل: '+(e?.message||''),true);}
  }
  async function handleVoiceStop(blob,stream){
    stream.getTracks().forEach(t=>t.stop());
    byId('v11-voice-status').textContent='جاري تحليل التسجيل…';
    const drive=(byId('v11-voice-drive')?.value||'').trim();
    try{
      const s=session();const form=new FormData();form.append('audio',blob,blob.type.includes('mp4')?'voice.m4a':blob.type.includes('ogg')?'voice.ogg':'voice.webm');form.append('drive_url',drive);
      const res=await fetch(`${C.supabaseUrl}/functions/v1/${VOICE_FN}`,{method:'POST',headers:{apikey:C.supabasePublishableKey,Authorization:`Bearer ${s.access_token}`},body:form});
      const out=await res.json().catch(()=>({}));
      if(res.ok&&out.ok){await refresh();closeModal();toast(out.warning||`تم إنشاء «${out.title}» وتوزيعه${out.model_used?` عبر ${out.model_used}`:''}.`,!!out.warning);patchAll();return;}
      if(out.fallback_manual){
        const done=await browserVoiceFallback(state.recognitionTranscript,drive);
        if(done){closeModal();return;}
        closeModal();openOriginalCreate(drive);toast('Gemini غير متاح؛ رجعنا لإضافة التاسك العادية.',true);return;
      }
      throw new Error(out.error||'تعذر إنشاء التاسك من الصوت.');
    }catch(e){
      const done=await browserVoiceFallback(state.recognitionTranscript,drive).catch(()=>false);
      if(done){closeModal();return;}
      closeModal();openOriginalCreate(drive);toast(e.message||'تعذر تحليل الصوت؛ استخدم الإضافة العادية.',true);
    }
  }

  async function browserVoiceFallback(transcript,drive){
    const text=String(transcript||'').trim();if(!text)return false;
    const profiles=(state.data?.profiles||[]).filter(p=>p.active);
    const assignee=profiles.find(p=>text.toLowerCase().includes(p.name.toLowerCase())||text.toLowerCase().includes(p.username.toLowerCase()));
    if(!assignee)return false;
    const due=parseArabicDue(text);if(!due)return false;
    let title=text.replace(/^(تاسك|مهمة)\s*/i,'').split(/\s+(مع|لـ|مع المصمم|تسليمه|تسليمها|موعد)/)[0].trim();
    if(!title)title='تاسك من تسجيل صوتي';
    const task=await action('create_task',{title,brief:text,drive_url:drive||'',due_at:due.toISOString()});
    await action('assign',{task_id:task.id,version:1,user_ids:[assignee.id]});
    toast('تم إنشاء التاسك بالطريقة الاحتياطية بدون Gemini.');return true;
  }
  function parseArabicDue(text){
    const now=new Date();let d=new Date(now);let found=false;
    if(/بعد بكرة|بعد غد/.test(text)){d.setDate(d.getDate()+2);found=true}else if(/بكرة|غد/.test(text)){d.setDate(d.getDate()+1);found=true}else if(/النهارده|اليوم/.test(text)){found=true}
    const m=text.match(/(?:الساعة|ساعه|ساعة)?\s*(\d{1,2})(?::(\d{2}))?\s*(مساء|الصبح|صباح|ظهر|ليل|pm|am)?/i);
    if(m){let h=Number(m[1]),min=Number(m[2]||0),p=m[3]||'';if(/مساء|ليل|pm/i.test(p)&&h<12)h+=12;if(/صباح|الصبح|am/i.test(p)&&h===12)h=0;d.setHours(h,min,0,0);found=true}else if(found){d.setHours(18,0,0,0)}
    return found&&d.getTime()>Date.now()?d:null;
  }
  function openOriginalCreate(drive){
    const btn=[...document.querySelectorAll('button')].find(b=>(b.textContent||'').includes('تاسك جديد'));
    btn?.click();
    setTimeout(()=>{
      const dialogs=[...document.querySelectorAll('[role="dialog"]')];const dlg=dialogs.find(x=>(x.textContent||'').includes('إضافة تاسك'));
      const input=dlg?.querySelector('input[name="drive_url"]');if(input&&drive){input.value=drive;input.dispatchEvent(new Event('input',{bubbles:true}));}
    },150);
  }

  const TEXT_PAIRS=[
    ['مساحة الفريق','مساحة عمل الفريق','Team Workspace'],
    ['كل الشغل، قدامك.','إدارة المشاريع ومتابعة التنفيذ','Project Management & Delivery Tracking'],
    ['من البريف لبداية الشغل.','إدارة البريفات وتنسيق بدء التنفيذ','Brief Management & Project Coordination'],
    ['شغلك وتسليماتك.','مهامك ومراحل التسليم','Your Tasks & Deliverables'],
    ['التاسكات','المشاريع والمهام','Projects & Tasks'],
    ['تم التسليم','المشاريع المسلّمة','Delivered Projects'],
    ['الطلبات والشكاوى','الطلبات والإجازات والملاحظات','Requests, Leave & Feedback'],
    ['طلباتي','طلباتي وإجازاتي','My Requests & Leave'],
    ['الفريق والنقاط','أداء الفريق والنقاط','Team Performance & Points'],
    ['التقارير الشهرية','التقارير الشهرية','Monthly Reports'],
    ['سجل النشاط','سجل النشاط','Activity Log'],
    ['إجمالي التاسكات','إجمالي المهام','Total Tasks'],
    ['بانتظار التوزيع','بانتظار التوزيع','Awaiting Assignment'],
    ['شغال دلوقتي','قيد التنفيذ','In Progress'],
    ['بانتظار اعتمادك','بانتظار الاعتماد','Awaiting Approval'],
    ['بانتظار الاعتماد','بانتظار الاعتماد','Awaiting Approval'],
    ['متأخر عن التسليم','متأخر عن الموعد','Overdue'],
    ['كل التاسكات','كل المشاريع والمهام','All Projects & Tasks'],
    ['تاسك جديد','مهمة جديدة','New Task'],
    ['إضافة تاسك','إضافة مهمة','Create Task'],
    ['إضافة بالصوت','إنشاء بالصوت','Create by Voice'],
    ['طلب جديد','إرسال طلب','New Request'],
    ['مفيش تاسكات لسه','لا توجد مهام حاليًا','No tasks yet'],
    ['مفيش تاسكات بالحالة دي','لا توجد مهام بهذه الحالة','No tasks in this status'],
    ['مفيش طلبات لسه','لا توجد طلبات حاليًا','No requests yet'],
    ['شغال','قيد التنفيذ','In Progress'],
    ['موعد التسليم','موعد التسليم','Deadline'],
    ['فات موعد التسليم','تجاوز موعد التسليم','Past deadline'],
    ['وقت الفريق','وقت التنفيذ','Team Time'],
    ['بانتظار توزيع الإدارة','بانتظار توزيع الإدارة','Awaiting management assignment'],
    ['اعتماد التسليم','اعتماد المشروع','Approve Project'],
    ['طلب تعديل بموعد جديد','طلب جولة تعديل','Request Revision'],
    ['نقل إلى تم التسليم','نقل إلى المشاريع المسلّمة','Move to Delivered'],
    ['التواصل','التواصل','Communication'],
    ['التواصل مع الفريق','التواصل مع الفريق','Team Communication'],
    ['الإشعارات','الإشعارات','Notifications'],
    ['محادثات خاصة','محادثات خاصة','Private Chats'],
    ['الجديد في الفريق','آخر التحديثات','Latest Updates'],
    ['تحديد كمقروء','تحديد الكل كمقروء','Mark All as Read'],
    ['مفيش إشعارات لسه','لا توجد إشعارات حاليًا','No notifications yet'],
    ['تسجيل الخروج','تسجيل الخروج','Sign Out'],
    ['تغيير كلمة المرور','تغيير كلمة المرور','Change Password'],
    ['تحديث','تحديث','Refresh'],
    ['حفظ التوزيع','حفظ التوزيع','Save Assignment'],
    ['تسليم الشغل','تسليم العمل','Submit Work'],
    ['تسليم للمراجعة','إرسال للمراجعة','Submit for Review'],
    ['سبب التأخير','سبب التأخير','Delay Reason'],
    ['حفظ السبب','حفظ السبب','Save Reason'],
    ['إرسال للإدارة','إرسال للإدارة','Send to Management'],
    ['طلب إجازة','طلب إجازة','Leave Request'],
    ['سبب الرفض — إجباري','سبب الرفض — إجباري','Rejection reason — required'],
    ['زيادة / خصم نقاط','تعديل النقاط','Adjust Points'],
    ['حفظ تعديل النقاط','حفظ تعديل النقاط','Save Points Adjustment'],
    ['جاهز للتسجيل','جاهز للتسجيل','Ready to Record'],
    ['ابدأ التسجيل','ابدأ التسجيل','Start Recording'],
    ['جاري التسجيل…','جاري التسجيل…','Recording…'],
    ['جاري تحليل التسجيل…','جاري تحليل التسجيل…','Analyzing recording…'],
    ['المراحل / Workflow','مراحل التنفيذ','Workflow'],
    ['المشاريع المسلّمة','المشاريع المسلّمة','Delivered Projects'],
    ['طلبات الفريق والشكاوى','طلبات الفريق والإجازات','Team Requests & Leave'],
    ['طلباتي وشكاواي','طلباتي وإجازاتي','My Requests & Leave'],
    ['التقارير الشهرية لكل حساب','التقارير الشهرية لكل حساب','Monthly Account Reports'],
    ['تسليمات الشهر، التأخير، النقاط التلقائية، وأي زيادة/خصم يدوي.','ملخص شهري للتسليمات والتأخير ونقاط المشاريع والتعديلات اليدوية.','Monthly deliveries, delays, project scores and manual adjustments.'],
    ['التوتال من Ledger مستقل؛ حذف/أرشفة التاسك لا يمسح نقطة واحدة.','النقاط محفوظة في سجل مستقل ولا تتأثر بأرشفة المشروع.','Points are preserved in an independent ledger and are not affected by archiving.'],
    ['إدارة الحساب','إدارة الحساب','Account Management'],
    ['إضافة عضو','إضافة عضو','Add Team Member'],
    ['إعادة تعيين كلمة المرور','إعادة تعيين كلمة المرور','Reset Password'],
    ['الاسم','الاسم','Name'],
    ['اسم المستخدم','اسم المستخدم','Username'],
    ['الصلاحية','الصلاحية','Role'],
    ['اسم التاسك','اسم المهمة','Task Name'],
    ['البريف / المطلوب','البريف / نطاق العمل','Brief / Scope'],
    ['العنوان','العنوان','Title'],
    ['التفاصيل','التفاصيل','Details'],
    ['نوع الطلب','نوع الطلب','Request Type'],
    ['رد الإدارة','رد الإدارة','Management Response'],
    ['القرار / الحالة','القرار / الحالة','Decision / Status'],
    ['قبول / رفض الطلب','مراجعة الطلب','Review Request'],
    ['قبول / متابعة','قبول / متابعة','Accept / Follow Up'],
    ['مقبول / قيد التنفيذ','مقبول / قيد التنفيذ','Accepted / In Progress'],
    ['تم التنفيذ','تم التنفيذ','Completed'],
    ['مرفوض','مرفوض','Rejected'],
    ['شكوى','شكوى','Complaint'],
    ['جهاز أو أدوات ناقصة','جهاز أو أدوات ناقصة','Missing Equipment / Tools'],
    ['عطل في جهاز','عطل في جهاز','Equipment Fault'],
    ['طلب آخر','طلب آخر','Other Request'],
    ['من','من','From'],
    ['إلى','إلى','To'],
    ['حفظ القرار','حفظ القرار','Save Decision'],
    ['حذف','حذف','Delete'],
    ['إعادة تقديم — تصعيد','إعادة تقديم — تصعيد','Resubmit — Escalate'],
    ['توزيع التاسك','توزيع المهمة','Assign Task'],
    ['بدء المشروع','بدء التنفيذ','Start Work'],
    ['إيقاف التايمر','إيقاف الوقت','Pause Timer'],
    ['استكمال التايمر','استكمال الوقت','Resume Timer'],
    ['استكمال','استكمال','Resume'],
    ['التعديلات المطلوبة','التعديلات المطلوبة','Required Revisions'],
    ['لينك Drive لملفات التسليم','رابط Drive لملفات التسليم','Delivery Drive Link'],
    ['فتح البريف على Google Drive','فتح البريف على Google Drive','Open Brief on Google Drive'],
    ['المسؤولون عن التنفيذ','المسؤولون عن التنفيذ','Assigned Team'],
    ['لا يوجد تكليف نشط في الجولة الحالية.','لا يوجد تكليف نشط في الجولة الحالية.','No active assignment in the current round.'],
    ['الجولات والتكليفات السابقة','الجولات والتكليفات السابقة','Previous Rounds & Assignments'],
    ['سجل التاسك','سجل المهمة','Task Audit Log'],
    ['البريف والملفات','البريف والملفات','Brief & Files'],
    ['أي تاسك يتم نقله من قائمة التاسكات يظل هنا بسجله وتسليماته ونقاطه كاملة.','المشاريع المؤرشفة تظل محفوظة بسجلها وتسليماتها ونقاطها كاملة.','Archived projects remain available with their full history, deliveries and points.'],
    ['لا توجد تاسكات منقولة بعد','لا توجد مشاريع مسلّمة بعد','No delivered projects yet'],
    ['لا توجد تسليمات محفوظة.','لا توجد تسليمات محفوظة.','No saved deliveries.'],
    ['النقاط (+ إضافة / - خصم)','النقاط (+ إضافة / - خصم)','Points (+ add / - deduct)'],
    ['السبب','السبب','Reason'],
    ['التفاصيل','التفاصيل','Details'],
    ['إضافة تاسك بالصوت','إنشاء مهمة بالصوت','Create Task by Voice'],
    ['لينك البريف — اختياري للإدارة','رابط البريف — اختياري للإدارة','Brief link — optional for management'],
    ['إيقاف وإنشاء التاسك','إيقاف وإنشاء المهمة','Stop & Create Task'],
    ['سبب الرفض','سبب الرفض','Rejection Reason'],
    ['مرفوض سابقًا','مرفوض سابقًا','Previously Rejected'],
    ['ملاحظة الاعتماد','ملاحظة الاعتماد','Approval Note'],
    ['Task Owner','مسؤول المشروع','Task Owner'],
    ['المسؤول','المسؤول','Assignee'],
    ['الساعات المخططة','الساعات المخططة','Planned Hours'],
    ['اعتماد المرحلة','اعتماد المرحلة','Approve Stage'],
    ['تسليم المرحلة','تسليم المرحلة','Submit Stage'],
    ['إيقاف المرحلة','إيقاف المرحلة','Pause Stage'],
    ['بدء المرحلة','بدء المرحلة','Start Stage']
  ];
  const allVariants=new Map();
  for(const [old,ar,en] of TEXT_PAIRS){allVariants.set(old,{ar,en});allVariants.set(ar,{ar,en});allVariants.set(en,{ar,en});}

  function ensureTopbarControls(){
    const end=document.querySelector('.topbar-end');if(!end)return;
    if(!end.querySelector('.v12-lang-btn')){
      const b=document.createElement('button');b.type='button';b.className='v12-lang-btn';b.onclick=()=>{state.lang=state.lang==='ar'?'en':'ar';localStorage.setItem('briv-lang',state.lang);applyLanguage(true);if(state.mode)renderCustom(state.mode);};end.prepend(b);
    }
    if(!end.querySelector('.v12-push-btn')){
      const b=document.createElement('button');b.type='button';b.className='v12-push-btn';b.onclick=enablePush;end.prepend(b);
    }
    updateTopbarControls();
  }
  function updateTopbarControls(){
    const lb=document.querySelector('.v12-lang-btn');if(lb)lb.textContent=state.lang==='ar'?'EN':'AR';
    const pb=document.querySelector('.v12-push-btn');if(pb){const perm=('Notification'in window)?Notification.permission:'unsupported';pb.textContent=perm==='granted'?L('🔔 تنبيهات الموبايل مفعلة','🔔 Mobile Alerts On'):perm==='denied'?L('🔕 التنبيهات محظورة','🔕 Notifications Blocked'):L('🔔 تفعيل تنبيهات الموبايل','🔔 Enable Mobile Alerts');pb.classList.toggle('enabled',perm==='granted');pb.classList.toggle('blocked',perm==='denied');}
  }

  function applyLanguage(force=false){
    document.documentElement.lang=state.lang;document.documentElement.dir=state.lang==='en'?'ltr':'rtl';
    document.title=state.lang==='en'?'Brivviant Studio | Project Operations':'Brivviant Studio | إدارة المشاريع';
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{acceptNode:n=>{const p=n.parentElement;if(!p||['SCRIPT','STYLE','TEXTAREA'].includes(p.tagName))return NodeFilter.FILTER_REJECT;return n.nodeValue?.trim()?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT;}});
    const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
    for(const n of nodes){const raw=n.nodeValue||'',trim=raw.trim(),match=allVariants.get(trim);if(!match)continue;const target=state.lang==='en'?match.en:match.ar;n.nodeValue=raw.replace(trim,target);}
    document.querySelectorAll('[placeholder],[title],[aria-label]').forEach(el=>{for(const attr of ['placeholder','title','aria-label']){const raw=el.getAttribute(attr);if(!raw)continue;const match=allVariants.get(raw.trim());if(match)el.setAttribute(attr,state.lang==='en'?match.en:match.ar);}});
    document.querySelectorAll('[dir="rtl"]').forEach(el=>{if(el.matches('input,textarea'))return;if(!el.dataset.v12OrigDir)el.dataset.v12OrigDir='rtl';el.setAttribute('dir',state.lang==='en'?'ltr':'rtl');});
    document.querySelectorAll('[data-v12-orig-dir="rtl"]').forEach(el=>el.setAttribute('dir',state.lang==='en'?'ltr':'rtl'));
    const h=document.querySelector('.heading-row h1');if(h){const current=(h.textContent||'').trim();if(state.lang==='ar'){if(current.includes('كل الشغل'))h.textContent='إدارة المشاريع ومتابعة التنفيذ';else if(current.includes('من البريف'))h.textContent='إدارة البريفات وتنسيق بدء التنفيذ';else if(current.includes('شغلك'))h.textContent='مهامك ومراحل التسليم';}else{const role=state.me?.role;h.textContent=isManagement()?'Project Management & Delivery Tracking':role==='coordinator'?'Brief Management & Project Coordination':'Your Tasks & Deliverables';}}
    updateTopbarControls();
  }

  async function pushCall(body){
    const s=session();if(!s?.access_token)throw new Error(L('سجّل دخولك أولًا.','Please sign in first.'));
    const res=await fetch(`${C.supabaseUrl}/functions/v1/brivviant-push`,{method:'POST',headers:{apikey:C.supabasePublishableKey,Authorization:`Bearer ${s.access_token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const out=await res.json().catch(()=>({}));if(!res.ok||out.error)throw new Error(out.error||`HTTP ${res.status}`);return out;
  }
  function urlBase64ToUint8Array(base64String){const padding='='.repeat((4-base64String.length%4)%4),base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/'),raw=atob(base64);return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));}
  async function enablePush(){
    try{
      if(!('serviceWorker'in navigator)||!('PushManager'in window)||!('Notification'in window))throw new Error(L('المتصفح لا يدعم Push Notifications.','This browser does not support Web Push.'));
      let perm=Notification.permission;if(perm==='default')perm=await Notification.requestPermission();
      if(perm!=='granted')throw new Error(L('لازم تسمح بالإشعارات من إعدادات المتصفح/الموبايل.','Please allow notifications in your browser/device settings.'));
      const reg=await navigator.serviceWorker.register('./sw.js?v=12');await navigator.serviceWorker.ready;
      const key=await pushCall({action:'public_key'});let sub=await reg.pushManager.getSubscription();
      if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(key.public_key)});
      await pushCall({action:'subscribe',subscription:sub.toJSON(),user_agent:navigator.userAgent});
      updateTopbarControls();toast(L('تم تفعيل تنبيهات الموبايل.','Mobile notifications enabled.'));
    }catch(e){toast(e.message||L('تعذر تفعيل التنبيهات.','Could not enable notifications.'),true);updateTopbarControls();}
  }
  async function ensurePushRegistration(){
    if(!('serviceWorker'in navigator))return;try{await navigator.serviceWorker.register('./sw.js?v=12');if('Notification'in window&&Notification.permission==='granted')await enablePush();}catch{}
  }
  function patchNotifications(){
    const b=document.querySelector('.inbox-trigger');if(!b)return;const unread=b.querySelector('.unread-count');b.classList.toggle('v12-notify-highlight',!!unread&&Number((unread.textContent||'0').replace('+',''))>0);if(unread)b.setAttribute('aria-live','assertive');
  }

  function installRpcMetadataBridge(){
    if(window.__brivV12FetchBridge)return;window.__brivV12FetchBridge=true;
    const real=window.fetch.bind(window);
    window.fetch=async(input,init={})=>{
      try{
        const url=typeof input==='string'?input:input?.url||'';
        if(url.includes('/rest/v1/rpc/bv_action')&&typeof init.body==='string'){
          const body=JSON.parse(init.body);
          if(body?.p_action==='pause'&&state.pendingPause){body.p={...(body.p||{}),...state.pendingPause};state.pendingPause=null;init={...init,body:JSON.stringify(body)};}
          else if(body?.p_action==='revision'&&state.pendingRevision){body.p={...(body.p||{}),...state.pendingRevision};state.pendingRevision=null;init={...init,body:JSON.stringify(body)};}
          else if(body?.p_action==='approve'&&state.pendingApproval){body.p={...(body.p||{}),...state.pendingApproval};state.pendingApproval=null;init={...init,body:JSON.stringify(body)};}
        }
      }catch{}
      return real(input,init);
    };
    document.addEventListener('click',e=>{
      const b=e.target.closest?.('button');if(!b)return;const txt=(b.textContent||'').trim();
      if((txt.includes('إيقاف التايمر')||txt==='Pause Timer'||txt==='إيقاف الوقت'||txt==='Pause')&&!b.hasAttribute('data-v12-stage-action')){
        const reason=prompt(L('سبب إيقاف الوقت — إجباري','Pause reason — required'));if(reason===null||!reason.trim()){e.preventDefault();e.stopPropagation();return;}
        const negligence=confirm(L('هل الإيقاف بسبب تقصير شخصي؟\nOK = نعم (نقاط المشروع = 0)\nCancel = سبب خارجي/استراحة مخططة','Is this pause caused by personal negligence?\nOK = Yes (project score = 0)\nCancel = External/planned reason'));
        state.pendingPause={pause_reason:reason.trim(),pause_kind:negligence?'negligence':'external'};
      }
      if(txt.includes('اعتماد التسليم')||txt==='Approve Project'){
        const note=prompt(L('ملاحظة الاعتماد للـCEO (اختياري)','Approval note for audit (optional)'))||'';state.pendingApproval={approval_note:note.trim()};
      }
    },true);
  }

  function patchRevisionDialog(){
    document.querySelectorAll('[role="dialog"]').forEach(dlg=>{
      if(!((dlg.textContent||'').includes('طلب تعديل')||(dlg.textContent||'').includes('Request Revision')))return;
      const form=dlg.querySelector('form');if(!form||form.querySelector('.v12-revision-quality'))return;
      const box=document.createElement('div');box.className='v12-revision-quality';box.innerHTML=`<label><input type="checkbox" class="v12-error-check"> ${L('التعديل بسبب خطأ من أحد أعضاء الفريق (يصفر نقاط مشروعه)','Revision caused by a team member error (sets their project score to 0)')}</label><label class="v12-responsible-wrap" style="display:none"><span>${L('المسؤول عن الخطأ','Responsible person')}</span><select class="v12-responsible">${(state.data?.profiles||[]).filter(p=>p.active).map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>`;
      form.insertBefore(box,form.querySelector('button[type="submit"]'));
      const chk=box.querySelector('.v12-error-check'),wrap=box.querySelector('.v12-responsible-wrap');chk.onchange=()=>wrap.style.display=chk.checked?'grid':'none';
      form.addEventListener('submit',()=>{state.pendingRevision={is_error:chk.checked,responsible_user_id:chk.checked?box.querySelector('.v12-responsible').value:''};},true);
    });
  }

  function patchAll(){
    if(!state.data)return;
    ensureTabs();ensureVoiceButton();ensureTopbarControls();patchTeam();patchRequests();patchDeleteCopy();patchNotifications();patchRevisionDialog();applyLanguage();
  }

  const observer=new MutationObserver(()=>{clearTimeout(state.timer);state.timer=setTimeout(patchAll,80)});
  observer.observe(document.documentElement,{childList:true,subtree:true});
  setInterval(async()=>{if(!session())return;try{await refresh();patchAll();if(state.mode)renderCustom(state.mode)}catch{}},15000);
  window.addEventListener('focus',async()=>{if(!session())return;try{await refresh();patchAll()}catch{}});

  async function init(){
    for(let i=0;i<80;i++){if(document.querySelector('.main-work')&&session())break;await new Promise(r=>setTimeout(r,250));}
    if(!session())return;
    try{installRpcMetadataBridge();await refresh();patchAll();await ensurePushRegistration()}catch(e){console.warn('V12 patch init:',e)}
  }
  init();
})();
