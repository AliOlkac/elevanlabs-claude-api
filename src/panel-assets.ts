/** Static assets of the monitoring panel (Turkish UI). Served from memory; no build step. */

export const LOGIN_HTML = (error: boolean) => `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ses Atölyesi — Giriş</title><link rel="stylesheet" href="/app.css"></head>
<body><main class="login">
<h1>Ses Atölyesi</h1>
<form method="post" action="/login">
<label for="p">Parola</label>
<input id="p" name="password" type="password" autocomplete="current-password" autofocus required>
${error ? '<p class="err" role="alert">Parola hatalı.</p>' : ""}
<button type="submit">Giriş yap</button>
</form></main></body></html>`;

export const APP_HTML = `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ses Atölyesi</title><link rel="stylesheet" href="/app.css"></head>
<body>
<header><h1>Ses Atölyesi</h1>
<form method="post" action="/logout"><button class="ghost" type="submit">Çıkış</button></form></header>
<main>
<section class="cards" id="cards" aria-live="polite"></section>

<section>
<h2>Bütçe</h2>
<form id="budget" class="row">
<label>İş başına karakter sınırı <input name="per_job_char_limit" type="number" min="0" step="1" required></label>
<label>Aylık karakter sınırı <input name="monthly_char_limit" type="number" min="0" step="1" required></label>
<button type="submit">Kaydet</button><span id="budgetMsg" class="muted" role="status"></span>
</form>
<p class="muted small">0 = sınırsız. Sınır aşılırsa iş başlamaz ve nedeni Claude'a bildirilir.</p>
</section>

<section>
<h2>İşler</h2>
<div class="tablewrap"><table id="jobs"><thead><tr>
<th>İş</th><th>Durum</th><th>İlerleme</th><th>Model</th><th class="num">Kredi</th><th>Tarih</th>
</tr></thead><tbody></tbody></table></div>
<p id="empty" class="muted" hidden>Henüz iş yok. Claude bir iş gönderdiğinde burada görünür.</p>
</section>

<section id="detail" hidden>
<h2 id="dTitle"></h2>
<p id="dMeta" class="muted"></p>
<p id="dMsg" class="err" hidden></p>
<p><button id="dCancel" class="ghost" hidden>İşi iptal et</button></p>
<ol id="dItems" class="items"></ol>
</section>
</main>
<script src="/app.js"></script>
</body></html>`;

export const APP_CSS = `:root{--bg:#f6f5f2;--card:#fff;--ink:#1c1b19;--muted:#6b6862;--line:#e2dfd8;--accent:#0f6b5c;--bad:#b3261e;--warn:#8a5a00}
@media (prefers-color-scheme:dark){:root{--bg:#151614;--card:#1f201d;--ink:#eceae4;--muted:#a09c93;--line:#33342f;--accent:#5fc9b4;--bad:#ff8a80;--warn:#f0c060}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;justify-content:space-between;align-items:center;padding:14px 20px;border-bottom:1px solid var(--line)}
h1{font-size:18px;margin:0;letter-spacing:.01em}
h2{font-size:15px;margin:0 0 10px}
main{max-width:980px;margin:0 auto;padding:20px 16px 60px}
section{margin-bottom:28px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card b{display:block;font-size:20px;font-variant-numeric:tabular-nums}
.card span{color:var(--muted);font-size:13px}
.row{display:flex;flex-wrap:wrap;gap:12px;align-items:end}
label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
input{font:inherit;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:7px 10px;min-width:0}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:var(--bg);padding:7px 14px}
button.ghost{background:transparent;color:var(--ink);border-color:var(--line)}
button:focus-visible,input:focus-visible,tr:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.tablewrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:560px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-size:12px;color:var(--muted);font-weight:600}
tbody tr{cursor:pointer}tbody tr:last-child td{border-bottom:0}
tbody tr:hover,tbody tr.sel{background:color-mix(in srgb,var(--accent) 9%,transparent)}
.num{text-align:right;font-variant-numeric:tabular-nums}
.st{font-weight:600}.st-done{color:var(--accent)}.st-error{color:var(--bad)}.st-running,.st-queued{color:var(--warn)}.st-cancelled{color:var(--muted)}
.muted{color:var(--muted)}.small{font-size:13px}.err{color:var(--bad)}
.items{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.items li{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.items .top{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline;justify-content:space-between}
.items .name{font-weight:600;overflow-wrap:anywhere}
.items .txt{margin:4px 0 8px;overflow-wrap:anywhere}
.items audio{width:100%;height:36px}
.login{max-width:320px;margin:14vh auto;padding:0 16px}
.login form{display:grid;gap:10px;margin-top:16px}
`;

export const APP_JS = `(function(){
var $=function(s){return document.querySelector(s)};
var ST={queued:"Sırada",running:"Çalışıyor",done:"Bitti",error:"Hata",cancelled:"İptal edildi"};
var selected=null,timer=null,budgetDirty=false;
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function num(n){return (n==null?"—":Number(n).toLocaleString("tr-TR"))}
function when(s){return s?new Date(s).toLocaleString("tr-TR",{dateStyle:"short",timeStyle:"short"}):"—"}
function api(path,opt){return fetch(path,Object.assign({headers:{"content-type":"application/json"},credentials:"same-origin"},opt||{})).then(function(r){
  if(r.status===401){location.href="/";throw new Error("401")}
  return r.json().then(function(j){if(!r.ok)throw new Error(j.detail||j.error||("HTTP "+r.status));return j})})}
function card(label,value){var c=el("div","card");c.appendChild(el("b",null,value));c.appendChild(el("span",null,label));return c}
function overview(){
  return api("/api/overview").then(function(d){
    var cards=$("#cards");cards.textContent="";
    if(d.account){
      cards.appendChild(card("Kalan kredi",num(d.account.credits_remaining)));
      cards.appendChild(card("Plan",d.account.plan||"—"));
      cards.appendChild(card("Dönem sonu",when(d.account.period_ends_at)));
    }else{cards.appendChild(card("ElevenLabs hesabı",d.account_error?"Ulaşılamadı":"—"))}
    cards.appendChild(card("Bu ay üretilen karakter",num(d.usage.characters)));
    cards.appendChild(card("Bu ay harcanan kredi",num(d.usage.credits)));
    if(!budgetDirty){var f=$("#budget");f.per_job_char_limit.value=d.settings.per_job_char_limit;f.monthly_char_limit.value=d.settings.monthly_char_limit}
    var tb=$("#jobs tbody");tb.textContent="";
    $("#empty").hidden=d.jobs.length>0;
    var active=false;
    d.jobs.forEach(function(j){
      if(j.status==="queued"||j.status==="running")active=true;
      var tr=el("tr",selected===j.job_id?"sel":"");tr.tabIndex=0;
      tr.appendChild(el("td",null,j.job));
      tr.appendChild(el("td","st st-"+j.status,ST[j.status]||j.status));
      tr.appendChild(el("td",null,j.done+" / "+j.total));
      tr.appendChild(el("td",null,j.model));
      tr.appendChild(el("td","num",num(j.credits)));
      tr.appendChild(el("td",null,when(j.created_at)));
      var open=function(){selected=j.job_id;detail(true);overview()};
      tr.addEventListener("click",open);
      tr.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();open()}});
      tb.appendChild(tr);
    });
    clearTimeout(timer);
    timer=setTimeout(function(){overview();if(selected)detail(false)},active?4000:30000);
  }).catch(function(e){if(e.message!=="401")console.error(e)});
}
var shown={};
function detail(reset){
  if(!selected)return;
  api("/api/jobs/"+encodeURIComponent(selected)).then(function(j){
    $("#detail").hidden=false;
    $("#dTitle").textContent=j.job+" — "+(ST[j.status]||j.status);
    var meta=j.done+" / "+j.total+" satır · "+num(j.credits_spent)+" kredi · "+j.model+" · "+(j.mode==="dialogue"?"diyalog":"satır satır");
    if(j.github)meta+=" · GitHub: "+j.github.path+" @ "+j.github.commit_sha.slice(0,7);
    $("#dMeta").textContent=meta;
    var msg=[];if(j.warning)msg.push(j.warning);if(j.error)msg.push(j.error.detail);(j.warnings||[]).forEach(function(w){msg.push(w)});
    $("#dMsg").hidden=!msg.length;$("#dMsg").textContent=msg.join(" — ");
    $("#dCancel").hidden=!(j.status==="queued"||j.status==="running");
    var list=$("#dItems");
    if(reset){list.textContent="";shown={}}
    (j.items||[]).forEach(function(it){
      var key=it.index+":"+(it.ready?1:0)+":"+(it.error?1:0);
      var id="it"+it.index, old=document.getElementById(id);
      if(old&&shown[it.index]===key)return;
      shown[it.index]=key;
      var li=el("li");li.id=id;
      var top=el("div","top");top.appendChild(el("span","name",it.name));
      var info=it.error?"hata":it.ready?((it.duration_sec||0).toFixed(1)+" sn"+(it.cached?" · önbellekten":" · "+num(it.credits)+" kredi")):"bekliyor";
      top.appendChild(el("span","muted small",info));li.appendChild(top);
      li.appendChild(el("p","txt",it.text));
      if(it.error)li.appendChild(el("p","err small",it.error));
      if(it.ready){var a=document.createElement("audio");a.controls=true;a.preload="none";a.src="/api/audio/"+encodeURIComponent(j.job_id)+"/"+it.index;li.appendChild(a)}
      if(old)list.replaceChild(li,old);else list.appendChild(li);
    });
  }).catch(function(e){if(e.message!=="401"){$("#detail").hidden=false;$("#dTitle").textContent="İş okunamadı";$("#dMeta").textContent=e.message}});
}
$("#budget").addEventListener("input",function(){budgetDirty=true});
$("#budget").addEventListener("submit",function(e){
  e.preventDefault();var f=e.target;
  api("/api/settings",{method:"PUT",body:JSON.stringify({per_job_char_limit:Number(f.per_job_char_limit.value),monthly_char_limit:Number(f.monthly_char_limit.value)})})
   .then(function(){budgetDirty=false;$("#budgetMsg").textContent="Kaydedildi."}).catch(function(err){$("#budgetMsg").textContent="Kaydedilemedi: "+err.message});
});
$("#dCancel").addEventListener("click",function(){
  if(!selected||!confirm("Bu iş iptal edilsin mi?"))return;
  api("/api/jobs/"+encodeURIComponent(selected)+"/cancel",{method:"POST"}).then(function(){overview();detail(false)});
});
overview();
})();`;
