// Landing page served at GET /. Self-contained: inline CSS/JS, Google Fonts only.
// The demo replays real decisions returned by the live model (not simulated scores).

export const LANDING_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Checkpoint: a safety gate for AI agents</title>
<meta name="description" content="Checkpoint checks every risky action your AI agent takes, in under a second. It allows it, blocks it, or sends it to your phone for approval.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{
  --paper:#F5F7F8; --ink:#14213D; --steel:#5C6B73; --line:#D5DCE0;
  --go:#1B998B; --wait:#E09F00; --stop:#D7263D; --lamp-off:#25324F;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font-family:Archivo,system-ui,sans-serif;font-size:18px;line-height:1.55;font-variation-settings:"wdth" 100}
a{color:inherit}
:focus-visible{outline:3px solid var(--wait);outline-offset:3px;border-radius:4px}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px}
header.top{display:flex;justify-content:space-between;align-items:center;padding:22px 0}
.mark{display:flex;align-items:center;gap:10px;font-weight:800;font-variation-settings:"wdth" 112;font-size:20px;text-decoration:none}
.mark i{display:inline-flex;gap:3px;padding:5px;background:var(--ink);border-radius:8px}
.mark i b{width:7px;height:7px;border-radius:50%;display:block}
.top nav a{font-size:16px;color:var(--steel);text-decoration:none;margin-left:22px}
.top nav a:hover{color:var(--ink)}

/* hero */
.hero{display:grid;grid-template-columns:1.05fr .95fr;gap:56px;align-items:center;padding:48px 0 88px}
h1{font-size:clamp(44px,7.4vw,92px);line-height:.95;margin:0 0 26px;font-weight:800;font-variation-settings:"wdth" 118;letter-spacing:-.01em}
.lede{font-size:21px;max-width:34ch;color:#2C3A57;margin:0 0 32px}
.cta{display:flex;flex-wrap:wrap;gap:14px;align-items:center}
.btn{display:inline-block;background:var(--ink);color:#fff;text-decoration:none;font-weight:700;padding:15px 24px;border-radius:12px;border:0;font:inherit;font-weight:700;cursor:pointer}
.btn:hover{background:#0A1430}
.btn.ghost{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 2px var(--ink)}

/* signal demo */
.signal{background:var(--ink);color:#E8EDF4;border-radius:28px;padding:28px;display:grid;grid-template-columns:auto 1fr;gap:26px;align-items:start}
.lamps{display:flex;flex-direction:column;gap:14px;background:#0E1830;padding:16px;border-radius:999px}
.lamp{width:58px;height:58px;border-radius:50%;background:var(--lamp-off);transition:background .25s,box-shadow .25s}
.lamp.on.stop{background:var(--stop);box-shadow:0 0 34px var(--stop)}
.lamp.on.wait{background:var(--wait);box-shadow:0 0 34px var(--wait)}
.lamp.on.go{background:var(--go);box-shadow:0 0 34px var(--go)}
.panel h2{margin:0 0 4px;font-size:15px;font-weight:600;color:#9FB0C8}
.choices{display:flex;flex-direction:column;gap:8px;margin:12px 0 20px}
.choice{all:unset;cursor:pointer;padding:11px 14px;border-radius:12px;background:#1D2B4A;font-size:16px;line-height:1.35}
.choice:hover{background:#26375C}
.choice[aria-pressed="true"]{background:#E8EDF4;color:var(--ink)}
.choice:focus-visible{outline:3px solid var(--wait)}
.verdict{border-top:1px solid #2C3B5C;padding-top:16px;min-height:132px}
.verdict .word{font-size:34px;font-weight:800;font-variation-settings:"wdth" 120;line-height:1}
.verdict .word.stop{color:#FF5A6E}.verdict .word.wait{color:#FFC233}.verdict .word.go{color:#3CD2BF}
.verdict p{margin:8px 0 0;font-size:15px;color:#B8C5D8}
.verdict .meta{font-family:"JetBrains Mono",monospace;font-size:13px;color:#8A9BB5;margin-top:10px}
.note{font-size:13px;color:#8A9BB5;margin-top:14px}

/* sections */
section{padding:72px 0;border-top:1px solid var(--line)}
h2.h{font-size:clamp(30px,4.4vw,48px);line-height:1.05;margin:0 0 16px;font-weight:800;font-variation-settings:"wdth" 112}
.sub{color:var(--steel);max-width:58ch;margin:0 0 40px}
.steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:40px;counter-reset:s}
.steps li{counter-increment:s}
.steps li::before{content:counter(s);display:inline-grid;place-items:center;width:36px;height:36px;border-radius:50%;background:var(--ink);color:#fff;font-weight:700;margin-bottom:14px}
.steps h3{margin:0 0 6px;font-size:21px}
.steps p{margin:0;color:#3A4866;font-size:17px}
.outcomes{display:grid;grid-template-columns:repeat(3,1fr);gap:0;margin-top:8px}
.outcome{padding:22px 24px 22px 0}
.outcome strong{display:flex;align-items:center;gap:10px;font-size:20px}
.outcome strong::before{content:"";width:14px;height:14px;border-radius:50%;background:var(--c)}
.outcome p{margin:6px 0 0;color:#3A4866;font-size:16px}

pre{margin:0;background:var(--ink);color:#E8EDF4;border-radius:16px;padding:20px;overflow-x:auto;font:14px/1.6 "JetBrains Mono",monospace}
pre .c{color:#8A9BB5}
.code-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}
.code-grid>div,.hero>div{min-width:0}
.code-grid h3{font-size:18px;margin:0 0 10px}

form.wait{display:flex;flex-wrap:wrap;gap:12px;max-width:560px}
form.wait input[type=email]{flex:1 1 260px;font:inherit;padding:14px 16px;border-radius:12px;border:2px solid var(--ink);background:#fff;color:var(--ink)}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
#msg{margin:14px 0 0;font-size:16px;min-height:1.5em}
.keybox{max-width:640px;background:#fff;border:2px solid var(--ink);border-radius:16px;padding:20px;margin-top:8px}
.keybox p{margin:0 0 12px}
.keyrow{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.keyrow code{flex:1 1 260px;min-width:0;overflow-wrap:anywhere;font:15px/1.4 "JetBrains Mono",monospace;background:var(--paper);padding:12px;border-radius:10px}
.btn.small{padding:10px 16px}
.next{margin:16px 0 0;padding-left:20px}
.next li{margin:6px 0}
#msg.ok{color:#127368}#msg.err{color:#B01E31}

footer{padding:40px 0 60px;color:var(--steel);font-size:15px;border-top:1px solid var(--line)}

@media (max-width:880px){
  .hero{grid-template-columns:1fr;gap:40px;padding-top:24px}
  .steps,.outcomes,.code-grid{grid-template-columns:minmax(0,1fr)}
  .outcome{padding:14px 0}
  .top nav a:not(.gh){display:none}
}
@media (max-width:420px){
  .signal{grid-template-columns:1fr;padding:22px}
  .lamps{flex-direction:row;justify-content:center;width:max-content}
  .lamp{width:44px;height:44px}
}
@media (prefers-reduced-motion:reduce){.lamp{transition:none}}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <a class="mark" href="/" aria-label="Checkpoint home"><i aria-hidden="true"><b style="background:var(--stop)"></b><b style="background:var(--wait)"></b><b style="background:var(--go)"></b></i>Checkpoint</a>
    <nav><a href="#how">How it works</a><a href="#start">Get started</a><a href="/app">Dashboard</a><a class="gh" href="https://github.com/saidhamdane/checkpoint">GitHub</a></nav>
  </header>

  <main>
  <div class="hero">
    <div>
      <h1>Your agent asks before it acts.</h1>
      <p class="lede">Checkpoint checks every risky action an AI agent is about to take, like a payment, a deletion or an email to a customer. It allows it, blocks it, or sends it to your phone for a yes or no.</p>
      <div class="cta">
        <a class="btn" href="#start">Get a free API key</a>
        <a class="btn ghost" href="https://github.com/saidhamdane/checkpoint">View the code</a>
      </div>
    </div>

    <div class="signal" aria-label="Live decision examples">
      <div class="lamps" aria-hidden="true">
        <div class="lamp stop" id="l-stop"></div>
        <div class="lamp wait" id="l-wait"></div>
        <div class="lamp go" id="l-go"></div>
      </div>
      <div class="panel">
        <h2 id="pick">Pick an action your agent wants to take</h2>
        <div class="choices" role="group" aria-labelledby="pick">
          <button class="choice" data-k="0" aria-pressed="false">Send 5,000 EUR to a new IBAN</button>
          <button class="choice" data-k="1" aria-pressed="false">Reply to an angry customer and promise a full refund</button>
          <button class="choice" data-k="2" aria-pressed="false">Search the weather in Corralejo tomorrow</button>
        </div>
        <div class="verdict" aria-live="polite" id="verdict">
          <div class="word" id="v-word">Waiting for an action</div>
          <p id="v-why">Choose one above to see what Checkpoint decided.</p>
          <div class="meta" id="v-meta"></div>
        </div>
        <p class="note">These are real decisions from the live model, not mock-ups.</p>
      </div>
    </div>
  </div>

  <section id="how">
    <h2 class="h">One check before anything irreversible</h2>
    <p class="sub">Add Checkpoint to the tools your agent already uses. Rules are plain English, and every decision is logged.</p>
    <ol class="steps">
      <li><h3>The agent describes the action</h3><p>Before calling a tool, it sends what it is about to do: the tool, the amount, the recipient.</p></li>
      <li><h3>Checkpoint scores it against your rules</h3><p>A fast decision model answers one question per rule, in about half a second.</p></li>
      <li><h3>The agent gets a clear answer</h3><p>Go ahead, stop, or wait while you approve it from Telegram.</p></li>
    </ol>
    <div class="outcomes">
      <div class="outcome" style="--c:var(--go)"><strong>Allow</strong><p>Routine work runs without interrupting you.</p></div>
      <div class="outcome" style="--c:var(--wait)"><strong>Ask</strong><p>Grey areas land on your phone with Approve and Deny buttons.</p></div>
      <div class="outcome" style="--c:var(--stop)"><strong>Block</strong><p>Clear violations never run. The agent is told why.</p></div>
    </div>
  </section>

  <section id="start">
    <h2 class="h">Works with the agents you already run</h2>
    <p class="sub">Connect it as an MCP server, or wrap any function with the TypeScript or Python SDK.</p>
    <div class="code-grid">
      <div>
        <h3>Claude Code and other MCP clients</h3>
<pre>claude mcp add --transport http checkpoint \\
  https://checkpoint.saidmatorral.workers.dev/mcp \\
  --header "Authorization: Bearer $CHECKPOINT_KEY"</pre>
      </div>
      <div>
        <h3>TypeScript</h3>
<pre><span class="c">// every call is checked first</span>
const refund = cp.guard("stripe.refund", stripeRefund);
await refund({ amount: 900, customer: "cus_123" });
<span class="c">// throws CheckpointBlocked if denied</span></pre>
      </div>
    </div>

    <h2 class="h" style="margin-top:64px">Get an API key</h2>
    <p class="sub">Free for up to 10,000 checks a month. Your key appears right here.</p>
    <form class="wait" id="wait" novalidate>
      <label for="email" class="hp">Email</label>
      <input id="email" name="email" type="email" required autocomplete="email" placeholder="you@company.com" aria-describedby="msg">
      <div class="hp" aria-hidden="true"><label>Company website<input name="website" tabindex="-1" autocomplete="off"></label></div>
      <button class="btn" type="submit">Create my key</button>
    </form>
    <div id="done" class="keybox" hidden>
      <p><strong>Your API key.</strong> It is shown only once, so copy it now.</p>
      <div class="keyrow"><code id="keyval"></code><button class="btn small" type="button" id="copy">Copy</button></div>
      <ol class="next">
        <li><a id="tglink" href="#" target="_blank" rel="noopener">Connect Telegram</a> to approve actions from your phone.</li>
        <li>Add it to your agent with the MCP or SDK snippet above, using this key.</li>
        <li>Watch decisions on your <a href="/app">dashboard</a>.</li>
      </ol>
    </div>
    <p id="msg" role="status"></p>
  </section>
  </main>

  <footer>Checkpoint is open source under the MIT license. Built in Fuerteventura.</footer>
</div>

<script>
(function(){
  var data=[
    {k:"stop",word:"Blocked",why:"Moves money. This action would send funds right now.",risk:"0.964"},
    {k:"wait",word:"Ask a human",why:"Commits the business: promising a refund needs your approval on Telegram.",risk:"0.959"},
    {k:"go",word:"Allowed",why:"No policy matched.",risk:"0.079"}
  ];
  var lamps={stop:document.getElementById("l-stop"),wait:document.getElementById("l-wait"),go:document.getElementById("l-go")};
  var btns=document.querySelectorAll(".choice");
  function show(i){
    var d=data[i];
    Object.keys(lamps).forEach(function(k){lamps[k].classList.toggle("on",k===d.k)});
    btns.forEach(function(b){b.setAttribute("aria-pressed",String(b.dataset.k==i))});
    var w=document.getElementById("v-word");w.className="word "+d.k;w.textContent=d.word;
    document.getElementById("v-why").textContent=d.why;
    document.getElementById("v-meta").textContent="risk "+d.risk;
  }
  btns.forEach(function(b){b.addEventListener("click",function(){show(+b.dataset.k)})});

  var f=document.getElementById("wait"),msg=document.getElementById("msg");
  document.getElementById("copy").addEventListener("click",function(){
    var v=document.getElementById("keyval").textContent,b=this;
    (navigator.clipboard?navigator.clipboard.writeText(v):Promise.reject()).then(function(){b.textContent="Copied"},function(){b.textContent="Select and copy"});
  });
  f.addEventListener("submit",function(e){
    e.preventDefault();
    var email=f.email.value.trim();
    if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)){msg.className="err";msg.textContent="Enter a valid email address, like you@company.com.";f.email.focus();return}
    msg.className="";msg.textContent="Sending…";
    fetch("/v1/signup",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:email,website:f.website.value})})
      .then(function(r){return r.json().catch(function(){return{}}).then(function(j){return{ok:r.ok,j:j}})})
      .then(function(x){
        if(x.ok&&x.j.api_key){
          msg.className="";msg.textContent="";f.hidden=true;
          document.getElementById("keyval").textContent=x.j.api_key;
          var tl=document.getElementById("tglink");
          if(x.j.telegram_link){tl.href=x.j.telegram_link}else{tl.parentNode.textContent="Connect Telegram later from your dashboard to approve actions from your phone."}
          document.getElementById("done").hidden=false;
          try{sessionStorage.setItem("checkpoint_key",x.j.api_key)}catch(e){}
          return;
        }
        var e=x.j.error;msg.className="err";
        msg.textContent=e==="invalid_email"?"Enter a valid email address, like you@company.com."
          :e==="email_taken"?"This email already has a key. Open the dashboard with it, or use another email."
          :e==="too_many_signups"?"Too many signups from this network today. Try again tomorrow."
          :"The request did not go through. Try again in a minute.";
      })
      .catch(function(){msg.className="err";msg.textContent="No connection. Check your network and try again."});
  });
})();
</script>
</body>
</html>`;
