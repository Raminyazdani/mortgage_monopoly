import './style.css';
import { createGame, applyAction, calculate, canLap, parsePrice } from './domain.js';
import { LedgerStore, createEnvelope, exportEnvelope, parseImport, MAX_IMPORT_BYTES } from './storage.js';

const $ = id => document.getElementById(id);
const fa = n => new Intl.NumberFormat('fa-IR').format(n);
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone = value => structuredClone(value);
const colors=['#926142','#6faec7','#ba528d','#dd913b','#c85843','#b89b34','#498955','#4973ae'];
let envelope, persistedRevision=0, dirty=false, failure=null, loadFailure=false, financialBusy=false;
let drainPromise=null, nameSession=null, confirmCallback=null;
const lastLap=new Map();
const store = new LedgerStore({onChange:async event=>{
  if(!envelope||failure||dirty||financialBusy||drainPromise) return;
  if(event.type==='check-latest'){
    try{const latest=await store.reload();if(latest.revision===persistedRevision)return;}catch{return;}
    if(failure||dirty||financialBusy||drainPromise)return;
  }else if(event.revision===persistedRevision)return;
  $('reload-latest').hidden=false;
  $('storage-status').textContent='در تب دیگری تغییر ثبت شده؛ نسخهٔ آخر را بخوان.';
}});

function message(text,error=false){$('message').textContent=text;$('message').hidden=false;$('message').classList.toggle('error',error);}
function name(player){const index=envelope.game.players.indexOf(player);return player.name || `بازیکن ${fa(index+1)}`;}
function optionLabel(player,index){return `${player.name || 'بازیکن'} · جایگاه ${fa(index+1)}`;}
function ownerName(ownerId,game=envelope.game){const index=game.players.findIndex(p=>p.id===ownerId);return game.players[index]?.name||`بازیکن ${fa(index+1)}`;}
function options(exclude){return envelope.game.players.map((p,i)=>p.id===exclude?'':`<option value="${escape(p.id)}">${escape(optionLabel(p,i))}</option>`).join('');}
function synchronizeNames(){
  const selected=$('who').value;
  $('who').innerHTML=options(); if(selected)$('who').value=selected;
  for(const select of document.querySelectorAll('[data-transfer]')){
    const card=envelope.game.cards.find(c=>c.id===select.dataset.transfer);
    if(card)select.innerHTML='<option value="">انتقال به…</option>'+options(card.ownerId);
  }
}
function controls(){
  const blocked=!envelope||!!failure||loadFailure||financialBusy;
  $('undo').disabled=blocked||!!drainPromise||!envelope?.undo.length;
  $('add').querySelector('button').disabled=blocked||!!drainPromise;
  $('reset').disabled=financialBusy||!!drainPromise;
  $('export').disabled=!envelope&&!store.readRaw();
  for(const input of document.querySelectorAll('[data-name]'))input.disabled=blocked;
  for(const button of document.querySelectorAll('[data-lap]'))button.disabled=blocked||!!drainPromise||!canLap(envelope.game,button.dataset.lap);
  for(const node of document.querySelectorAll('[data-action],[data-transfer],[data-restore-game]'))node.disabled=blocked||!!drainPromise;
}
function setStorage(){
  if(failure){$('storage-status').textContent=loadFailure?'دادهٔ قبلی باز نشد و جایگزین نشده؛ خروجی بازیابی یا فایل سالم را استفاده کن.':'ذخیره نشد؛ تغییر روی صفحه است، نسخهٔ قبلی هنوز محفوظ است.';$('retry-save').hidden=loadFailure;$('reload-latest').hidden=false;}
  else {$('storage-status').textContent=dirty||drainPromise?'در حال ذخیره…':'روی همین مرورگر ذخیره شد · برای پشتیبان، خروجی بگیر.';$('retry-save').hidden=true;}
  controls();
}
async function flush(){
  if(drainPromise)return drainPromise;
  if(!dirty||failure||loadFailure)return;
  drainPromise=(async()=>{
    while(dirty&&!failure){
      dirty=false;
      const candidate=clone(envelope);
      try{
        const saved=await store.save(candidate,persistedRevision);
        persistedRevision=saved.revision;
        envelope.revision=saved.revision;
      }catch(error){
        dirty=true;failure=error;
        message(error.code==='CONFLICT'?'در تب دیگری دفتر عوض شده. تغییر این تب ذخیره نشده؛ می‌توانی خروجی بگیری و سپس نسخهٔ آخر را بخوانی.':`ذخیره انجام نشد. ${error.message} می‌توانی دوباره تلاش کنی یا خروجی بازیابی بگیری.`,true);
      }
    }
  })();
  setStorage();
  await drainPromise;drainPromise=null;setStorage();
}
function pushUndo(label){envelope.undo.push({label,game:clone(envelope.game)});envelope.undo=envelope.undo.slice(-50);}
async function act(action,label){
  if(financialBusy||failure||loadFailure||!envelope)return false;
  financialBusy=true;controls();
  try{
    await flush();if(failure)return false;
    const next=applyAction(envelope.game,action);
    if(next===envelope.game)return false;
    pushUndo(label);envelope.game=next;nameSession=null;dirty=true;
    render();await flush();if(!failure)message(label);return !failure;
  }catch(error){message(error.message,true);return false;}
  finally{financialBusy=false;controls();}
}
function cardHTML(card){
  const amounts=calculate(card,envelope.game.model);
  const status=card.status,warning=status==='active'&&amounts.nextOver;
  const labels={active:warning?'نزدیک سقف':'در مورگیج',grace:'آخرین شانس',auction:'در مزایده'};
  const settle=`<button class="button ${status==='grace'?'primary':'secondary'}" data-action="settle" data-id="${escape(card.id)}">تسویه کرد · ${fa(amounts.debt)}</button>`;
  const transfer=`<select data-transfer="${escape(card.id)}" aria-label="انتقال ${escape(card.name)}"><option value="">انتقال به…</option>${options(card.ownerId)}</select>`;
  let note=warning?'دور بعد، بدهی از قیمت کارت رد می‌شود.':status==='grace'?'بدهی ثابت است. یک فرصت: تسویه یا مزایده.':status==='auction'?`قیمت شروع: ${fa(amounts.bid)} · بهره متوقف است.`:'';
  if(status==='grace'&&amounts.debt<=card.price)note+=' مبلغ دقیق از قیمت گذشته؛ عدد نمایشی گرد شده است.';
  return `<article class="card ${status} ${warning?'warning':''}" data-card="${escape(card.id)}" data-status="${status}" data-debt="${amounts.debt}">
    <div class="card-top"><bdi class="card-name">${escape(card.name)}</bdi><span class="tag">${labels[status]}</span></div>
    <div class="debt-row"><small>${status==='auction'?'شروع مزایده':'بدهیِ تسویه'}</small><span class="amount">${fa(status==='auction'?amounts.bid:amounts.debt)}</span></div>
    <p class="meta">قیمت ${fa(card.price)} · گرفته ${fa(amounts.loan)} · دور ${fa(card.laps)}<br>بهرهٔ انباشته ${fa(amounts.interest)}${status==='auction'?` · بدهی ثابت ${fa(amounts.debt)}`:''}</p>
    ${note?`<p class="card-note">${note}</p>`:''}
    <div class="card-actions">${status==='auction'?`<button class="button secondary" data-action="closeAuction" data-id="${escape(card.id)}">مزایده تمام شد</button>`:settle+(status==='grace'?`<button class="button secondary" data-action="auction" data-id="${escape(card.id)}">نداد، مزایده</button>`:'')+transfer}</div>
  </article>`;
}
function historyHTML(card){
  return `<article class="history-card" data-card="${escape(card.id)}" data-status="${card.status}" ${card.settlement?`data-paid="${card.settlement.amount}"`:''}>
    <div><bdi><b>${escape(card.name)}</b></bdi><p>${escape(ownerName(card.settlement?.ownerId||card.ownerId))} · قیمت ${fa(card.price)}</p></div>
    <span>${card.status==='settled'?`تسویه شد · ${fa(card.settlement.amount)} داد`:'مزایده بسته شد'}</span>
  </article>`;
}
function render(){
  if(!envelope)return controls();
  const game=envelope.game;
  $('seats').innerHTML=game.players.map((player,index)=>{
    const cards=game.cards.filter(c=>c.ownerId===player.id&&['active','grace','auction'].includes(c.status));
    const debt=cards.filter(c=>['active','grace'].includes(c.status)).reduce((sum,c)=>sum+calculate(c,game.model).debt,0);
    const grace=cards.filter(c=>c.status==='grace').length;
    return `<section class="seat" data-player="${player.id}" style="--seat:${colors[index]}">
      <div class="seat-head"><span class="seat-number">${fa(index+1)}</span><input data-name="${player.id}" maxlength="80" autocomplete="off" aria-label="اسم بازیکن ${fa(index+1)}" placeholder="اسم بازیکن ${fa(index+1)}" value="${escape(player.name)}"><button class="button primary" data-lap="${player.id}">دور زد</button></div>
      <div class="seat-stats"><span>${fa(cards.length)} کارت جاری</span><span>جمع بدهی ${fa(debt)}</span></div>
      ${grace?`<p class="seat-note">${fa(grace)} کارت در آخرین شانس؛ قبل از دور تازه تعیین تکلیف کن.</p>`:''}
      <div class="card-list">${cards.length?cards.map(cardHTML).join(''):'<p class="empty">هنوز کارتی در مورگیج ندارد.</p>'}</div>
    </section>`;
  }).join('');
  synchronizeNames();
  const closed=game.cards.filter(c=>['settled','auction_closed'].includes(c.status));
  $('history-count').textContent=`(${fa(closed.length)})`;
  $('history-list').innerHTML=closed.length?closed.map(historyHTML).join(''):'<p class="empty">سوابق بسته‌شده اینجا می‌مانند.</p>';
  $('archive-count').textContent=`(${fa(envelope.archives.length)})`;
  $('archive-list').innerHTML=envelope.archives.map((archive,index)=>`<div class="history-card"><div><b>بازی بایگانی‌شده ${fa(index+1)}</b><p>${fa(archive.cards.length)} کارت · ${escape(archive.players.map(p=>p.name||'بازیکن').join('، '))}</p></div><div class="tools"><button class="button secondary" data-export-game="${index}">خروجی</button><button class="button secondary" data-restore-game="${index}">بازگرداندن</button></div></div>`).join('')||'<p class="empty">با بازی جدید یا بازیابی، دفتر قبلی اینجا حفظ می‌شود.</p>';
  $('summary').textContent=`${fa(game.cards.filter(c=>['active','grace'].includes(c.status)).length)} کارت در مورگیج`;
  $('legacy-notice').hidden=game.model!=='legacy-simple'&&!game.migration;
  $('legacy-notice').textContent=game.model==='legacy-simple'?'این دفتر قدیمی با بهرهٔ ثابت بازیابی شده و قانون تاریخی آن حفظ می‌شود. بازی جدید همیشه مرکب است.':game.migration?.compoundDefaulted?'مدل فایل قدیمی مشخص نبود؛ طبق رفتار نسخهٔ قدیمی، مرکب در نظر گرفته شد.':'';
  document.querySelector('.rule-badge small').textContent=game.model==='legacy-simple'?'ثابتِ دفتر قدیمی':'بهرهٔ مرکب';
  controls();
}
function confirm(title,body,callback,label='تأیید'){
  $('dialog-title').textContent=title;$('dialog-body').textContent=body;$('confirm-action').textContent=label;confirmCallback=callback;$('confirm-dialog').showModal();
}
$('cancel-action').addEventListener('click',()=>{$('confirm-dialog').close();confirmCallback=null;});
$('confirm-action').addEventListener('click',async()=>{const callback=confirmCallback;confirmCallback=null;$('confirm-dialog').close();if(callback)try{await callback();}catch(error){message(error.message,true);}});
async function replaceGame(imported){
  if(financialBusy)return;
  financialBusy=true;controls();
  try{
    if(!loadFailure){await flush();if(failure)throw new Error('اول تغییر ذخیره‌نشده را ذخیره کن یا نسخهٔ آخر را بخوان.');}
    const next=clone(imported);
    if(envelope&&!loadFailure){
      const localArchives=clone(envelope.archives);
      if(localArchives.length+next.archives.length+1>30)throw new Error('مجموع بایگانی‌ها از سقف ۳۰ بازی بیشتر می‌شود؛ دفتر فعلی تغییر نکرد.');
      next.archives=[...localArchives,clone(envelope.game),...next.archives];
    }
    if(loadFailure){envelope=await store.recover(next);persistedRevision=envelope.revision;loadFailure=false;failure=null;dirty=false;}
    else{envelope=next;envelope.revision=persistedRevision;dirty=true;await flush();}
    nameSession=null;lastLap.clear();render();setStorage();if(!failure)message('دفتر آماده شد؛ بازی قبلی در بایگانی محفوظ است.');
  }finally{financialBusy=false;controls();}
}
function download(data,filename){const url=URL.createObjectURL(new Blob([data],{type:'application/json;charset=utf-8'}));const anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function exportCurrent(){
  const data=envelope?exportEnvelope(envelope):store.readRaw();
  download(data,`mortgage-${new Date().toISOString().slice(0,10)}${failure?'-recovery':''}.json`);
  message(failure?'خروجیِ بازیابی از تغییر ذخیره‌نشده دانلود شد.':'پشتیبان JSON دانلود شد.');
}
$('export').addEventListener('click',exportCurrent);
$('import-file').addEventListener('change',async event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return;
  try{
    if(file.size>MAX_IMPORT_BYTES)throw new Error(`فایل بزرگ‌تر از ${fa(MAX_IMPORT_BYTES/1024/1024)} مگابایت پذیرفته نیست.`);
    const imported=parseImport(await file.text());
    confirm('بازیابی دفتر',`${fa(imported.game.cards.length)} کارت و ${fa(imported.archives.length)} بازی بایگانی‌شده خوانده شد.\nمدل: ${imported.game.model==='legacy-simple'?'بهرهٔ ثابتِ قدیمی':'بهرهٔ مرکب'}.\nدفتر فعلی پیش از جایگزینی حفظ می‌شود.`,()=>replaceGame(imported),'بازیابی کن');
  }catch(error){message(`بازیابی انجام نشد. ${error.message}`,true);}
});
$('reset').addEventListener('click',()=>confirm('بازی جدید',loadFailure?'دادهٔ خراب پیش از جایگزینی به‌صورت خام حفظ می‌شود. اگر لازم است، ابتدا خروجی بازیابی بگیر.':'دفتر فعلی بایگانی می‌شود و هشت اسم باقی می‌مانند. کارت‌های بازی تازه از ابتدا با بهرهٔ مرکب ثبت می‌شوند.',()=>replaceGame(createEnvelope(createGame(envelope?.game.players.map(p=>p.name)||[]))),'شروع بازی جدید'));
$('add').addEventListener('submit',async event=>{
  event.preventDefault();if(financialBusy)return;
  try{
    const price=parsePrice($('cprice').value),name=$('cname').value.trim();
    if(!name)throw new Error('اسم کارت را وارد کن.');
    if(await act({type:'add',ownerId:$('who').value,name,price},`کارت ثبت شد · دریافت ${fa(Math.floor((price+1)/2))}`)){$('cname').value='';$('cprice').value='';}
  }catch(error){message(error.message,true);$('cprice').focus();}
});
$('seats').addEventListener('focusin',event=>{if(event.target.dataset.name)nameSession={ownerId:event.target.dataset.name,snapshot:false};});
$('seats').addEventListener('input',event=>{
  const ownerId=event.target.dataset.name;if(!ownerId||failure||loadFailure||financialBusy)return;
  try{
    const next=applyAction(envelope.game,{type:'rename',ownerId,name:event.target.value});
    if(next===envelope.game)return;
    if(!nameSession||nameSession.ownerId!==ownerId)nameSession={ownerId,snapshot:false};
    if(!nameSession.snapshot){pushUndo('ویرایش اسم');nameSession.snapshot=true;}
    envelope.game=next;dirty=true;synchronizeNames();void flush();
  }catch(error){message(error.message,true);}
});
$('seats').addEventListener('click',async event=>{
  const button=event.target.closest('button');if(!button||button.disabled)return;
  if(button.dataset.lap){
    const ownerId=button.dataset.lap,now=performance.now();
    if(now-(lastLap.get(ownerId)||-Infinity)<400){message('همین دور ثبت شد؛ برای ثبت دور بعد کمی مکث کن.');return;}
    lastLap.set(ownerId,now);
    await act({type:'lap',ownerId},'یک دور کامل ثبت شد؛ ۱۰٪ روی کارت‌های فعال آمد.');
  }else if(button.dataset.action){
    const labels={settle:'تسویه ثبت شد و در سوابق باقی ماند.',auction:'کارت به مزایده رفت.',closeAuction:'مزایده بسته شد و سابقه باقی ماند.'};
    await act({type:button.dataset.action,cardId:button.dataset.id},labels[button.dataset.action]);
  }
});
$('seats').addEventListener('change',async event=>{const cardId=event.target.dataset.transfer,ownerId=event.target.value;if(cardId&&ownerId)await act({type:'transfer',cardId,ownerId},'کارت همراه بدهی منتقل شد.');});
$('undo').addEventListener('click',async()=>{
  if(financialBusy||failure||!envelope.undo.length)return;
  financialBusy=true;controls();
  try{await flush();if(failure)return;const previous=envelope.undo.pop();envelope.game=previous.game;lastLap.clear();nameSession=null;dirty=true;render();await flush();if(!failure)message(`برگشت: ${previous.label}`);}
  finally{financialBusy=false;controls();}
});
$('retry-save').addEventListener('click',async()=>{failure=null;await flush();if(!failure)message('تغییر ذخیره شد.');});
$('reload-latest').addEventListener('click',()=>{
  const reload=async()=>{
    if(financialBusy)return;
    financialBusy=true;controls();
    try{
      if(drainPromise)await drainPromise;
      const latest=await store.reload();envelope=latest;persistedRevision=latest.revision;failure=null;loadFailure=false;dirty=false;nameSession=null;lastLap.clear();$('reload-latest').hidden=true;render();setStorage();message('نسخهٔ آخر دفتر خوانده شد.');
    }catch(error){message(error.message,true);}
    finally{financialBusy=false;controls();}
  };
  if(dirty||failure)confirm('خواندن نسخهٔ آخر','تغییر ذخیره‌نشدهٔ این تب کنار می‌رود. پیش از ادامه، با «خروجی JSON» یک نسخهٔ بازیابی بگیر.',reload,'نسخهٔ آخر را بخوان');else void reload();
});
$('archive-list').addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.dataset.exportGame!==undefined){const game=envelope.archives[Number(button.dataset.exportGame)];download(exportEnvelope(createEnvelope(game)),`mortgage-archive-${game.id}.json`);}
  if(button.dataset.restoreGame!==undefined){const game=envelope.archives[Number(button.dataset.restoreGame)];confirm('بازگرداندن بازی بایگانی‌شده',`${fa(game.cards.length)} کارت بازیابی می‌شود؛ دفتر فعلی هم بایگانی خواهد شد.`,()=>replaceGame(createEnvelope(clone(game))),'بازگردان');}
});
window.addEventListener('beforeunload',event=>{if(dirty||failure||drainPromise){event.preventDefault();event.returnValue='';}});
$('build-id').textContent=`نسخه ۱ · ${__BUILD_ID__}`;
try{envelope=await store.init();persistedRevision=envelope.revision;render();setStorage();}
catch(error){failure=error;loadFailure=true;message(`دفتر باز نشد. ${error.message} دادهٔ قبلی جایگزین نشده؛ خروجی بازیابی بگیر یا فایل سالم را بازیابی کن.`,true);setStorage();}
if('serviceWorker' in navigator&&import.meta.env.PROD){
  navigator.serviceWorker.register('/sw.js').then(async registration=>{
    await navigator.serviceWorker.ready;
    $('offline-status').textContent='نسخهٔ آفلاین آماده است؛ پس از این بارگذاری، همین آدرس بدون شبکه هم باز می‌شود.';
    registration.addEventListener('updatefound',()=>{const installing=registration.installing;installing?.addEventListener('statechange',()=>{if(installing.state==='installed'&&navigator.serviceWorker.controller)$('offline-status').textContent='نسخهٔ تازه آماده است؛ بعد از بستن همهٔ تب‌های دفتر، در بازکردن بعدی فعال می‌شود. بازی محفوظ می‌ماند.';});});
  }).catch(()=>{$('offline-status').textContent='صفحهٔ باز بدون شبکه کار می‌کند؛ آماده‌سازی بازشدن آفلاین انجام نشد.';});
}
