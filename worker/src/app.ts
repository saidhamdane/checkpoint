// Dashboard served at GET /app. Talks to the JSON API with the user's key.
// The key is kept in sessionStorage by default (cleared when the tab closes);
// "Remember on this device" switches it to localStorage.

export const APP_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Checkpoint dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--paper:#F5F7F8;--ink:#14213D;--steel:#5C6B73;--line:#D5DCE0;--go:#1B998B;--wait:#E09F00;--stop:#D7263D;--card:#fff}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:Archivo,system-ui,sans-serif;font-size:17px;line-height:1.5}
a{color:inherit}
:focus-visible{outline:3px solid var(--wait);outline-offset:2px;border-radius:4px}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
header{display:flex;justify-content:space-between;align-items:center;padding:20px 0}
.mark{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px;text-decoration:none;font-variation-settings:"wdth" 112}
.mark i{display:inline-flex;gap:3px;padding:5px;background:var(--ink);border-radius:8px}
.mark i b{width:7px;height:7px;border-radius:50%;display:block}
h1{font-size:clamp(30px,5vw,44px);line-height:1.05;margin:24px 0 8px;font-weight:800;font-variation-settings:"wdth" 112}
h2{font-size:22px;margin:0 0 12px}
.sub{color:var(--steel);margin:0 0 24px}
.btn{display:inline-block;background:var(--ink);color:#fff;border:0;border-radius:10px;padding:12px 18px;font:inherit;font-weight:700;cursor:pointer;text-decoration:none}
.btn.ghost{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 2px var(--ink)}
.btn.small{padding:8px 12px;font-size:15px}
input[type=password],input[type=text],textarea{font:inherit;width:100%;padding:12px 14px;border:2px solid var(--ink);border-radius:10px;background:#fff;color:var(--ink)}
textarea{font:14px/1.5 "JetBrains Mono",monospace;min-height:260px}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.panel{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px;margin-bottom:20px}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}
.stat strong{display:block;font-size:30px;font-weight:800;font-variation-settings:"wdth" 112}
.stat span{color:var(--steel);font-size:15px}
.bar{height:8px;background:#E6EBEE;border-radius:99px;overflow:hidden;margin-top:8px}
.bar b{display:block;height:100%;background:var(--ink)}
table{width:100%;border-collapse:collapse;font-size:15px}
th{text-align:left;color:var(--steel);font-weight:600;padding:8px 10px;border-bottom:1px solid var(--line)}
td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top}
.tag{display:inline-flex;align-items:center;gap:7px;font-weight:700}
.tag::before{content:"";width:10px;height:10px;border-radius:50%;background:var(--c)}
.muted{color:var(--steel)}
.mono{font-family:"JetBrains Mono",monospace;font-size:13px}
#msg{min-height:1.5em;margin:10px 0 0}
.err{color:#B01E31}.ok{color:#127368}
.hidden{display:none}
.table-wrap{overflow-x:auto}
@media (max-width:720px){.stats{grid-template-columns:1fr}.hide-sm{display:none}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <a class="mark" href="/"><i aria-hidden="true"><b style="background:var(--stop)"></b><b style="background:var(--wait)"></b><b style="background:var(--go)"></b></i>Checkpoint</a>
    <button class="btn ghost small hidden" id="signout">Sign out</button>
  </header>

  <main>
  <section id="login">
    <h1>Open your dashboard</h1>
    <p class="sub">Paste the API key you got when you signed up. It stays in this browser and is only sent to Checkpoint.</p>
    <form id="loginForm" class="panel">
      <label for="key"><strong>API key</strong></label>
      <div class="row" style="margin-top:8px">
        <input id="key" type="password" autocomplete="off" placeholder="ck_live_…" style="flex:1 1 280px">
        <button class="btn" type="submit">Open dashboard</button>
      </div>
      <label class="row" style="margin-top:12px;font-size:15px"><input type="checkbox" id="remember"> Remember on this device</label>
      <p id="loginMsg" role="status"></p>
      <p class="muted" style="margin:8px 0 0;font-size:15px">No key yet? <a href="/#start">Create one on the home page</a>.</p>
    </form>
  </section>

  <section id="dash" class="hidden">
    <h1 id="hello">Your checkpoint</h1>
    <p class="sub" id="who"></p>

    <div class="panel stats">
      <div class="stat"><strong id="used">–</strong><span id="usedLabel">checks this month</span><div class="bar"><b id="usedBar" style="width:0"></b></div></div>
      <div class="stat"><strong id="tgState">–</strong><span>approvals channel</span></div>
      <div class="stat"><strong id="polState">–</strong><span>policies</span></div>
    </div>

    <div class="panel" id="tgPanel">
      <h2>Approvals on your phone</h2>
      <p class="muted" id="tgText" style="margin:0 0 12px"></p>
      <button class="btn small" id="tgLink">Connect Telegram</button>
      <p id="tgMsg" role="status"></p>
    </div>

    <div class="panel">
      <div class="row" style="justify-content:space-between;margin-bottom:8px">
        <h2 style="margin:0">Recent decisions</h2>
        <button class="btn ghost small" id="refresh">Refresh</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Decision</th><th>Action</th><th class="hide-sm">Reason</th><th class="hide-sm">When</th></tr></thead>
          <tbody id="rows"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <h2>Policies</h2>
      <p class="muted" style="margin:0 0 12px">Each policy is a fact about the action and what to do when it is true: <span class="mono">block</span> or <span class="mono">ask</span>. These apply to every check that does not send its own policies.</p>
      <label for="pol" class="hidden">Policies JSON</label>
      <textarea id="pol" spellcheck="false"></textarea>
      <div class="row" style="margin-top:12px">
        <button class="btn" id="savePol">Save policies</button>
        <button class="btn ghost" id="resetPol">Use defaults</button>
      </div>
      <p id="polMsg" role="status"></p>
    </div>

    <div class="panel">
      <h2>Connect your agent</h2>
      <p class="muted" style="margin:0 0 8px">MCP clients such as Claude Code:</p>
      <pre class="mono" style="background:var(--ink);color:#E8EDF4;padding:16px;border-radius:12px;overflow-x:auto;margin:0 0 16px">claude mcp add --transport http checkpoint \\
  <span id="origin1"></span>/mcp \\
  --header "Authorization: Bearer YOUR_KEY"</pre>
      <div class="row">
        <button class="btn ghost small" id="rotate">Rotate key</button>
        <span class="muted" style="font-size:15px">Revokes this key and shows a new one once.</span>
      </div>
      <p id="rotMsg" role="status"></p>
    </div>
  </section>
  </main>
</div>

<script>
(function(){
  var KEY_NAME="checkpoint_key", key=null;
  function load(){try{return localStorage.getItem(KEY_NAME)||sessionStorage.getItem(KEY_NAME)}catch(e){return null}}
  function save(k,remember){try{(remember?localStorage:sessionStorage).setItem(KEY_NAME,k)}catch(e){}}
  function clear(){try{localStorage.removeItem(KEY_NAME);sessionStorage.removeItem(KEY_NAME)}catch(e){}}
  var $=function(id){return document.getElementById(id)};
  function say(el,text,cls){el.className=cls||"";el.textContent=text}
  function api(method,path,body){
    return fetch(path,{method:method,headers:{"authorization":"Bearer "+key,"content-type":"application/json"},body:body?JSON.stringify(body):undefined})
      .then(function(r){return r.json().catch(function(){return{}}).then(function(j){return{ok:r.ok,status:r.status,j:j}})});
  }
  var COLORS={allow:"var(--go)",ask:"var(--wait)",block:"var(--stop)"};
  var LABELS={allow:"Allowed",ask:"Asked",block:"Blocked"};
  function ago(ts){var s=Math.round((Date.now()-ts)/1000);if(s<60)return s+"s ago";if(s<3600)return Math.round(s/60)+" min ago";if(s<86400)return Math.round(s/3600)+" h ago";return new Date(ts).toLocaleDateString()}
  function text(s){var d=document.createElement("span");d.textContent=s==null?"":String(s);return d}

  function showDash(me){
    $("login").classList.add("hidden");$("dash").classList.remove("hidden");$("signout").classList.remove("hidden");
    $("origin1").textContent=location.origin;
    $("who").textContent=me.owner?"Owner key":(me.email||"");
    $("used").textContent=me.used_this_month.toLocaleString();
    if(me.monthly_limit){$("usedLabel").textContent="of "+me.monthly_limit.toLocaleString()+" checks this month";$("usedBar").style.width=Math.min(100,100*me.used_this_month/me.monthly_limit)+"%"}
    else{$("usedLabel").textContent="checks this month (no limit)";$("usedBar").style.width="0"}
    $("tgState").textContent=me.telegram_linked?"Telegram":"Not connected";
    $("tgText").textContent=me.telegram_linked?"Approval requests go to your linked Telegram chat. Connect again to move them to another chat.":"Without a channel, actions that need approval wait and then expire. Connect Telegram to approve or deny them from your phone.";
    if(me.owner){$("tgPanel").classList.add("hidden");$("rotate").parentNode.classList.add("hidden")}
    $("polState").textContent=me.using_default_policies?"Defaults":"Custom";
    $("pol").value=JSON.stringify(me.policies,null,2);
  }
  function loadDecisions(){
    api("GET","/v1/decisions?limit=50").then(function(x){
      var tb=$("rows");tb.textContent="";
      var list=(x.j&&x.j.decisions)||[];
      if(!list.length){var tr=tb.insertRow();var td=tr.insertCell();td.colSpan=4;td.className="muted";td.textContent="No decisions yet. Your agent's first check will appear here.";return}
      list.forEach(function(d){
        var tr=tb.insertRow();
        var c1=tr.insertCell();var t=document.createElement("span");t.className="tag";t.style.setProperty("--c",COLORS[d.decision]||"var(--steel)");
        var label=LABELS[d.decision]||d.decision;if(d.decision==="ask"&&d.status)label+=" · "+d.status;t.textContent=label;c1.appendChild(t);
        var c2=tr.insertCell();var b=document.createElement("div");b.textContent=d.description||d.tool;c2.appendChild(b);var s=document.createElement("div");s.className="mono muted";s.textContent=d.tool+(d.agent_id?" · "+d.agent_id:"");c2.appendChild(s);
        var c3=tr.insertCell();c3.className="hide-sm";c3.appendChild(text(d.reason));
        var c4=tr.insertCell();c4.className="hide-sm muted";c4.textContent=ago(d.created_at);
      });
    });
  }
  function open(k,remember){
    key=k;
    return api("GET","/v1/me").then(function(x){
      if(!x.ok){clear();key=null;say($("loginMsg"),x.status===401?"This key was not recognised. Check it and try again.":"Could not load your account. Try again in a minute.","err");return}
      if(remember!==undefined)save(k,remember);
      showDash(x.j);loadDecisions();
    }).catch(function(){say($("loginMsg"),"No connection. Check your network and try again.","err")});
  }
  $("loginForm").addEventListener("submit",function(e){e.preventDefault();var k=$("key").value.trim();if(!/^ck_live_[0-9a-f]{40}$/.test(k)&&k.length<10){say($("loginMsg"),"Paste the full key, starting with ck_live_.","err");return}open(k,$("remember").checked)});
  $("signout").addEventListener("click",function(){clear();location.reload()});
  $("refresh").addEventListener("click",loadDecisions);
  $("tgLink").addEventListener("click",function(){
    api("POST","/v1/telegram/link").then(function(x){
      if(x.ok&&x.j.telegram_link){say($("tgMsg"),"Opening Telegram. Press Start in the chat to finish connecting.","ok");window.open(x.j.telegram_link,"_blank","noopener")}
      else say($("tgMsg"),"Telegram is not available right now. Try again later.","err");
    });
  });
  $("savePol").addEventListener("click",function(){
    var v;try{v=JSON.parse($("pol").value)}catch(e){say($("polMsg"),"This is not valid JSON. Check commas and quotes.","err");return}
    api("PUT","/v1/policies",{policies:v}).then(function(x){
      if(x.ok){say($("polMsg"),"Policies saved. New checks use them right away.","ok");$("polState").textContent="Custom"}
      else say($("polMsg"),"Not saved: "+(x.j.error||"unknown error"),"err");
    });
  });
  $("resetPol").addEventListener("click",function(){
    api("PUT","/v1/policies",{policies:null}).then(function(x){if(x.ok){say($("polMsg"),"Back to the default policies.","ok");open(key)}});
  });
  $("rotate").addEventListener("click",function(){
    if(!confirm("Rotate this key? Agents using it will stop working until you give them the new key."))return;
    api("POST","/v1/keys/rotate").then(function(x){
      if(!x.ok){say($("rotMsg"),"Not rotated: "+(x.j.error||"unknown error"),"err");return}
      key=x.j.api_key;var remember=false;try{remember=!!localStorage.getItem(KEY_NAME)}catch(e){}clear();save(key,remember);
      say($("rotMsg"),"New key (shown once): "+x.j.api_key,"ok");
    });
  });
  var k=load();if(k)open(k);
})();
</script>
</body>
</html>`;
