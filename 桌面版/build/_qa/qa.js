// QA driver v2: corrected selectors per real DOM.
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SPORT = process.argv[2] || '8931';
const PROFILE = process.argv[3] || path.join(os.tmpdir(), 'qg_qa_prof2');
const DPORT = 9800 + Math.floor(Math.random() * 150);

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok, extra });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' :: ' + extra : ''));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(port) {
    let tab = null;
    for (let i = 0; i < 80; i++) {
      try {
        const list = await getJson('http://127.0.0.1:' + port + '/json/list');
        tab = list.find(t => t.type === 'page');
        if (tab) break;
      } catch (e) { }
      await sleep(250);
    }
    if (!tab) throw new Error('no tab');
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { resolve, reject } = c.pending.get(m.id);
        c.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('EVAL-ERR: ' + (r.exceptionDetails.exception ? JSON.stringify(r.exceptionDetails.exception.description || r.exceptionDetails.exception) : r.exceptionDetails.text));
    return r.result ? r.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch (e) { } }
}
function waitFor(fn, timeout = 8000, step = 200) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      Promise.resolve().then(fn).then(v => {
        if (v) resolve(v);
        else if (Date.now() - t0 > timeout) reject(new Error('timeout'));
        else setTimeout(poll, step);
      }).catch(reject);
    })();
  });
}

async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + DPORT, '--user-data-dir=' + PROFILE,
    '--window-size=1440,900', 'about:blank'
  ], { stdio: 'ignore' });
  let c;
  try {
    c = await CDP.connect(DPORT);
    const errors = [];
    c.send('Runtime.enable');
    c.send('Log.enable');
    c.ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      let t = '';
      if (m.method === 'Runtime.exceptionThrown') {
        t = m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : (m.params.exceptionDetails.text || '');
      } else if (m.method === 'Log.entryAdded') {
        t = m.params.entry.text || '';
      }
      if (t) errors.push(String(t));
    });
    const base = 'http://127.0.0.1:' + SPORT;

    // 1) math boot
    await c.send('Page.enable');
    await c.send('Page.navigate', { url: base + '/index.html?skip=1' });
    await waitFor(() => c.eval('window.MATH_DB && window.CUR_SUBJECT==="math" && document.querySelector("#statBar")'));
    check('math boot (10 boards)', await c.eval('window.MATH_DB && MATH_DB.boards.length===10 && document.title.indexOf("高中数学")>=0'));
    // 期望值从数据推导:知识点数量会随内容补充变化,写死数字会让测试变成"绊脚石"
    const nMath = await c.eval('MATH_DB.points.length');
    const stMath = (await c.eval('document.querySelector("#statBar").textContent')) || '';
    check('statbar counts', new RegExp('节点\\s*' + nMath + '\\b').test(stMath), 'DB=' + nMath + ' | ' + stMath);
    await sleep(400);

    // 2) search & select & detail & close & clear
    await c.eval('(function(){var i=document.getElementById("searchInput"); i.value="\u5bfc\u6570"; i.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await sleep(350);
    const resCount = await c.eval('document.querySelectorAll("#searchResults li").length');
    check('search results appear', resCount > 0, 'count=' + resCount);
    const pickName = await c.eval('var li=document.querySelector("#searchResults li"); li ? li.textContent.trim() : ""');
    await c.eval('var li=document.querySelector("#searchResults li"); if(li) li.click();');
    await sleep(1100);
    const open1 = await c.eval('document.getElementById("detailPanel").classList.contains("open")');
    const dName = await c.eval('document.getElementById("dName").textContent');
    const dLen = await c.eval('document.getElementById("dContent").textContent.length');
    const mjx = await c.eval('document.querySelectorAll("#detailPanel mjx-container").length');
    check('detail opens + filled', open1 && dName.length > 0 && dLen > 300, 'picked=' + pickName.slice(0, 12) + ' -> ' + dName + ' len=' + dLen);
    check('mathjax typeset', mjx > 0, 'mjx=' + mjx);
    const dMeta = await c.eval('document.getElementById("dMeta").textContent');
    check('detail meta shows board+level', (dMeta || '').indexOf('板块') >= 0, dMeta.slice(0, 60));
    await c.eval('document.getElementById("detailClose").click()');
    await sleep(350);
    check('detail closes', !(await c.eval('document.getElementById("detailPanel").classList.contains("open")')));
    await c.eval('document.getElementById("searchClear").click()');
    await sleep(300);
    check('search clear empties input', (await c.eval('document.getElementById("searchInput").value')) === '');
    check('search results hidden after clear', await c.eval('document.getElementById("searchResults").hidden || getComputedStyle(document.getElementById("searchResults")).display==="none"'));

    // 2b) typing a new query while detail open must close the stale detail
    await c.eval('(function(){var i=document.getElementById("searchInput"); i.value="\u5bfc\u6570"; i.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await sleep(400);
    await c.eval('document.querySelector("#searchResults li").click()');
    await sleep(900);
    const openBefore = await c.eval('document.getElementById("detailPanel").classList.contains("open")');
    await c.eval('(function(){var i=document.getElementById("searchInput"); i.value="\u51fd\u6570"; i.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await sleep(450);
    const staleClosed = await c.eval('!document.getElementById("detailPanel").classList.contains("open")');
    const resShown = await c.eval('document.querySelectorAll("#searchResults li[data-id]").length');
    check('stale detail auto-closes on new search', openBefore === true && staleClosed === true, 'openBefore=' + openBefore + ' res=' + resShown);
    await c.eval('document.getElementById("searchClear").click()');
    await sleep(300);

    // 2c) custom color swatch marks selection, manual color clears it
    const selAfterBoot = await c.eval('document.querySelectorAll("#nnSwatches .swatch.sel").length');
    const swCount = await c.eval('document.querySelectorAll("#nnSwatches .swatch").length');
    const selAtBoot2 = await c.eval('(function(){var s=document.querySelectorAll("#nnSwatches .swatch.sel"); return s.length ? s[0].getAttribute("data-board") : null;})()');
    const swSel = await c.eval('document.querySelectorAll("#nnSwatches .swatch")[2].getAttribute("data-board")');
    await c.eval('document.querySelectorAll("#nnSwatches .swatch")[2].click()');
    const sel2 = await c.eval('(function(){var s=document.querySelectorAll("#nnSwatches .swatch.sel"); return s.length ? s[0].getAttribute("data-board") : null;})()');
    check('swatch sel marker', swCount === 10 && selAfterBoot === 1 && sel2 === swSel, 'n=' + swCount + ' bootSel=' + selAfterBoot + '(' + selAtBoot2 + ') after=' + sel2 + ' expect=' + swSel);
    await c.eval('var c=document.getElementById("nnColor"); c.value="#112233"; c.dispatchEvent(new Event("input",{bubbles:true}));');
    const sel3 = await c.eval('document.querySelectorAll("#nnSwatches .swatch.sel").length');
    check('manual color clears swatch sel', sel3 === 0, 'sel=' + sel3);

    // 3) board filter toggling (real checkbox)
    const item0 = await c.eval('(function(){var l=document.querySelectorAll("#boardList .board-item"); return l.length ? {name: l[0].querySelector(".b-name").textContent, kind: l[0].querySelector(".b-kind").textContent} : null;})()');
    check('board list 10 items with kind', item0 !== null && item0.kind.length > 0, JSON.stringify(item0));
    await c.eval('document.querySelector("#boardList .board-item input").click()');
    await sleep(250);
    const unchecked = await c.eval('!document.querySelector("#boardList .board-item input").checked');
    check('board checkbox toggles off', unchecked === true);
    await c.eval('document.querySelector("#boardList .board-item input").click()');
    await sleep(250);
    check('board checkbox back on', await c.eval('document.querySelector("#boardList .board-item input").checked'));

    // 3b) unchecking the board of the selected point closes its stale detail
    await c.eval('(function(){var i=document.getElementById("searchInput"); i.value="\u5bfc\u6570\u4e0e\u51fd\u6570\u7684\u5355\u8c03\u6027"; i.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await sleep(400);
    await c.eval('document.querySelector("#searchResults li").click()');
    await sleep(900);
    const selOpen = await c.eval('document.getElementById("detailPanel").classList.contains("open")');
    const calculusOff = await c.eval('(function(){var its=document.querySelectorAll("#boardList .board-item"); for(var i=0;i<its.length;i++){if((its[i].querySelector(".b-name").textContent||"").indexOf("\u51fd\u6570\u4e0e\u5bfc\u6570")>=0){ its[i].querySelector("input").click(); return true;}} return false;})()');
    await sleep(400);
    const selClosed = await c.eval('!document.getElementById("detailPanel").classList.contains("open")');
    check('unchecking selected board closes detail', selOpen === true && calculusOff === true && selClosed === true, 'open=' + selOpen + ' toggled=' + calculusOff + ' closed=' + selClosed);
    // 3c) re-select via search auto-restores that board checkbox
    await c.eval('document.getElementById("searchClear").click()');
    await sleep(200);
    await c.eval('(function(){var i=document.getElementById("searchInput"); i.value="\u5bfc\u6570\u4e0e\u51fd\u6570\u7684\u5355\u8c03\u6027"; i.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await sleep(400);
    await c.eval('document.querySelector("#searchResults li").click()');
    await sleep(900);
    const autoRe = await c.eval('(function(){var its=document.querySelectorAll("#boardList .board-item"); for(var i=0;i<its.length;i++){if((its[i].querySelector(".b-name").textContent||"").indexOf("\u51fd\u6570\u4e0e\u5bfc\u6570")>=0) return its[i].querySelector("input").checked;} return null;})()');
    check('selecting hidden-board point re-checks its board', autoRe === true, 'checked=' + autoRe);
    await c.eval('document.getElementById("detailClose").click(); document.getElementById("searchClear").click(); "ok"');
    await sleep(300);

    // 4) side sections expand / collapse
    await c.eval('document.querySelector("#leftPanel .side-sec .sec-head").click()');
    await sleep(250);
    const secOpen = await c.eval('!document.querySelector("#leftPanel .side-sec").classList.contains("collapsed")');
    check('first side section expands', secOpen === true);

    // 5) custom point form (math): boards=10, validation
    await c.eval('(function(){var h=document.querySelector("#newNodeSec .sec-head"); if(h) h.click();})()');
    await sleep(250);
    const nnOpen = await c.eval('!document.getElementById("newNodeSec").classList.contains("collapsed")');
    const nnBoards = await c.eval('document.querySelectorAll("#nnBoard option").length');
    check('new-node section opens', nnOpen === true);
    check('nn board select = 10 (math)', nnBoards === 10, 'n=' + nnBoards);
    await c.eval('document.getElementById("nnSubmit").click()');
    await sleep(300);
    const msg = await c.eval('document.getElementById("nnMsg").textContent');
    check('empty submit shows validation', (msg || '').length > 0, msg);
    // fill and submit a real custom point
    await c.eval('(function(){document.getElementById("nnName").value="QA\u6d4b\u8bd5\u70b9"; document.getElementById("nnContent").value="\u5b9a\u4e49\uff1a\u6d4b\u8bd5\u5185\u5bb9 $x^2$ \u65b9\u6cd5\u3002"; document.getElementById("nnKeys").value="qa,\u6d4b\u8bd5"; document.getElementById("nnSubmit").click();})()');
    await sleep(500);
    const msg2 = await c.eval('document.getElementById("nnMsg").textContent');
    // 2026-09-26 起自定义知识点改成逐条独立存储:qg_custom_point_v2:<科目>:<id>。
    // 旧版整表键 qg_custom_points_v1 现在只在"兼容读取"时还被认。断言因此必须查新键 ——
    // 只查旧键会把"界面明确报已加入、数据也确实写进去了"误判成失败(实测踩过这个假红)。
    const saved = await c.eval('(function(){try{var n=0,i,k;for(i=0;i<localStorage.length;i++){k=localStorage.key(i);if(k&&k.indexOf("qg_custom_point_v2:")===0){var p=JSON.parse(localStorage.getItem(k)||"{}");if(p&&p.name==="QA\u6d4b\u8bd5\u70b9")n++;}}return n;}catch(e){return -1;}})()');
    check('custom point submit ok', saved >= 1, 'msg=' + msg2 + ' saved=' + saved);
    const stAfter = await c.eval('document.getElementById("statBar").textContent');
    check('statbar updated to ' + (nMath + 1), new RegExp('节点\\s*' + (nMath + 1) + '\\b').test(stAfter || ''), 'DB=' + nMath + ' | ' + stAfter);

    // 6) chem via switch URL + mask + autoadd inert
    await c.eval('sessionStorage.setItem("qg_xin","1"); location.href="' + base + '/index.html?subject=chem"; "nav"');
    await waitFor(() => c.eval('window.CHEM_DB && window.CUR_SUBJECT==="chem"'), 10000);
    await sleep(150);
    const mask1 = await c.eval('var m=document.getElementById("xmask"); m ? (getComputedStyle(m).opacity + "/" + getComputedStyle(m).pointerEvents) : "none"');
    check('mask fully covers right after switch', mask1.indexOf('1/auto') === 0, mask1);
    check('chem title', await c.eval('document.title.indexOf("\u5316\u5b66")>=0'));
    await sleep(2500);
    const mask0 = await c.eval('var m=document.getElementById("xmask"); m ? (getComputedStyle(m).opacity + "/" + getComputedStyle(m).pointerEvents) : "none"');
    check('mask faded out', mask0.indexOf('0/none') === 0, mask0);
    check('chem boards 8 colored', await c.eval('CHEM_DB.boards.filter(function(b){return !!b.color;}).length') === 8);
    // autoadd inert on chem
    await c.eval('location.href="' + base + '/index.html?subject=chem&skip=1&autoadd=1"; "nav"');
    await waitFor(() => c.eval('window.CHEM_DB && window.CUR_SUBJECT==="chem"'), 10000);
    await sleep(700);
    const stChem = await c.eval('document.getElementById("statBar").textContent');
    check('chem statbar unchanged (86, autoadd inert)', /86/.test(stChem), stChem);
    const customChem = await c.eval('document.querySelectorAll("#newNodeSec").length ? document.querySelectorAll("#nnBoard option").length : -1');
    check('nn board select = 8 (chem)', customChem === 8, 'n=' + customChem);

    // 8) train button + mainbridge heartbeat + locate command round-trip
    await c.eval('location.href="' + base + '/index.html?subject=math&skip=1"; "nav"');
    await waitFor(() => c.eval('window.MATH_DB && document.getElementById("trainBtn")'), 10000);
    await sleep(700);
    const btnTxt = await c.eval('document.getElementById("trainBtn").textContent');
    check('train button bottom-right exists', (btnTxt || '').indexOf('破卷') >= 0, 'txt=' + btnTxt);
    const openCalls = await c.eval('(function(){ window.__openLog=[]; var o=window.open; window.open=function(u,n){ window.__openLog.push(u); return null; }; document.getElementById("trainBtn").click(); window.open=o; return window.__openLog; })()');
    check('train button opens train.html', openCalls.length === 1 && (openCalls[0] || '').indexOf('train.html') >= 0, JSON.stringify(openCalls));
    const hb = await c.eval('(function(){var s=localStorage.getItem("qg_live_state"); if(!s) return null; try{return JSON.parse(s);}catch(e){return null;}})()');
    check('mainbridge heartbeat published', hb !== null && hb.subject === 'math', JSON.stringify(hb));
    await c.eval('localStorage.setItem("qg_live_cmd", JSON.stringify({type:"locate", kw:"\u5bfc\u6570\u4e0e\u51fd\u6570\u7684\u5355\u8c03\u6027", seq:1, t:Date.now()})); "ok"');
    await waitFor(() => c.eval('document.getElementById("detailPanel").classList.contains("open") && document.getElementById("dName").textContent.indexOf("\u5bfc\u6570") >= 0'), 6000).then(() => true).catch(() => false);
    const located = await c.eval('document.getElementById("detailPanel").classList.contains("open") ? document.getElementById("dName").textContent : ""');
    check('locate command selects point in main', (located || '').indexOf('\u5bfc\u6570') >= 0, 'name=' + located);
    await c.eval('document.getElementById("detailClose").click(); localStorage.setItem("qg_live_cmd", JSON.stringify({type:"locate", kw:"\u5bfc\u6570\u4e0e\u51fd\u6570\u7684\u5355\u8c03\u6027", seq:2, t: Date.now()-10000})); "ok"');
    await sleep(1800);
    const staleOpened = await c.eval('document.getElementById("detailPanel").classList.contains("open")');
    check('stale locate command ignored', staleOpened === false, 'open=' + staleOpened);

    // 9) train window page (offline paths)
    await c.eval('location.href="' + base + '/train.html"; "nav"');
    await waitFor(() => c.eval('window.__trainTest && document.getElementById("genBtn")'), 10000);
    await sleep(600);
    const dbInfo = await c.eval('window.__trainTest.db()');
    check('train page collects subject DBs', dbInfo !== null && dbInfo.subject === 'math', JSON.stringify(dbInfo));
    const noHost = await c.eval('window.__trainTest.hasHost');
    check('headless has no host (expected)', noHost === false);
    await c.eval('localStorage.setItem("qg_live_state", JSON.stringify({t:Date.now(), subject:"math", subjectName:"\u6570\u5b66", selName:"", keyword:""})); "ok"');
    await sleep(900);
    await c.eval('document.getElementById("askInput").value = "\u5355\u8c03\u6027"; "ok"');
    const tg = await c.eval('(function(){var t=window.__trainTest.currentTarget(); return t ? {name:t.p.name, board:t.p.board, imp:t.p.importance} : null;})()');
    check('ask resolves knowledge point (math)', tg !== null && tg.name.length > 0, JSON.stringify(tg));
    await c.eval('document.getElementById("locateBtn").click(); "ok"');
    await sleep(300);
    const brHead = await c.eval('document.querySelector("#boardRes .br-head") ? document.querySelector("#boardRes .br-head").textContent : ""');
    const brRows = await c.eval('document.querySelectorAll("#boardRes .br-item").length');
    check('board locate shows board + hit count', !(await c.eval('document.getElementById("boardRes").hidden')) && (brHead || '').indexOf('\u547d\u4e2d') >= 0 && brRows > 0, 'rows=' + brRows + ' head=' + String(brHead).slice(0, 46));
    await c.eval('document.querySelector("#boardRes .br-item").click()');
    await sleep(250);
    const pickedT = await c.eval('(function(){var t=window.__trainTest.currentTarget(); return t ? {name:t.p.name, via:t.via} : null;})()');
    check('board row click picks point', pickedT !== null && pickedT.via === 'picked' && pickedT.name.length > 0, JSON.stringify(pickedT));
    const cmd = await c.eval('(function(){try{return JSON.parse(localStorage.getItem("qg_live_cmd"));}catch(e){return null;}})()');
    check('point pick syncs locate cmd', cmd !== null && cmd.type === 'locate' && (cmd.kw || '').length > 0, 'kw=' + (cmd ? cmd.kw : ''));
    await c.eval('localStorage.removeItem("qg_ds_key"); document.getElementById("genBtn").click(); "ok"');
    await sleep(300);
    const warn = await c.eval('document.getElementById("status").textContent');
    check('gen without key warns', (warn || '').indexOf('Key') >= 0, warn);
    await c.eval('localStorage.setItem("qg_ds_key","sk-fake-test"); window.__oldFetch=window.fetch; window.fetch=function(){return Promise.reject(new Error("net-off"));}; document.getElementById("genBtn").click(); "ok"');
    await waitFor(() => c.eval('!document.getElementById("genBtn").disabled && document.getElementById("status").className.indexOf("err") >= 0'), 20000).then(() => true).catch(() => false);
    const errState = await c.eval('document.getElementById("status").textContent');
    check('gen failure handled gracefully', (errState || '').length > 0, errState.slice(0, 90));
    const busyReset = await c.eval('!document.getElementById("genBtn").disabled');
    check('gen busy flag reset after failure', busyReset === true);
    await c.eval('window.__trainTest.renderQuestions([{type:"\u89e3\u7b54", difficulty:3, stem:"\u6c42 $f(x)=x^2$ \u7684\u5bfc\u6570", options:null, answer:"2x", analysis:"\u5e42\u51fd\u6570\u6c42\u5bfc", source:"AI \u751f\u6210"}]); "ok"');
    await sleep(800);
    const qCards = await c.eval('document.querySelectorAll(".qcard").length');
    const mjxCards = await c.eval('document.querySelectorAll(".qcard mjx-container").length');
    await c.eval('document.querySelector(".qcard .sol-btn").click(); "ok"');
    await sleep(200);
    const solShown = await c.eval('document.querySelector(".qcard .sol").classList.contains("show")');
    check('question cards render + mathjax + toggle', qCards === 1 && mjxCards > 0 && solShown === true, 'cards=' + qCards + ' mjx=' + mjxCards);

    // 9b) 公式必须真的被排版 —— 「LaTeX 不渲染」bug 的永久回归闸门(2026-09-27 修)
    // 症状(实测):题干里出现 \boldsymbol{a} 时,MathJax 的 autoload 会去懒加载
    // input/tex/extensions/boldsymbol.js;而桌面宿主只内嵌了单个 vendor/mathjax-tex-svg.js,
    // 该请求必然 404 → typesetPromise 整体 reject,又被 train.js 的 .catch(function(){}) 吞掉
    // → 整张卡片的公式全部保持 $...$ 裸露在用户眼前(不是"某一条公式没渲染",是整卡全废)。
    // 修法:三个页面的 tex.autoload=false + 给 \boldsymbol/\bm/\cancel/… 八个宏做等价替身。
    // 所以这里刻意用含 \boldsymbol 的题干重放原始触发条件:配置一旦被改回去,这条断言必红。
    // 注:MathJax 3.2.2 的 tex-svg 单文件构建里 **没有** window.MathJax.tex 这一层(实测 keys 只有
    // config/loader/startup/typesetPromise/tex2svg/version…),用户配置被合并进 MathJax.config.tex,
    // 因此权威读数是 MathJax.config.tex.autoload;MathJax.tex 若将来存在,也一并要求为 false。
    await c.eval('(function(){var BS=String.fromCharCode(92); window.__trainTest.renderQuestions([{type:"解答", difficulty:2, stem:"已知向量 $"+BS+"boldsymbol{a}=(1,-2)$,求 $|"+BS+"boldsymbol{a}|$", options:null, answer:"$"+BS+"sqrt{5}$", analysis:"由模长公式 $|"+BS+"boldsymbol{a}|="+BS+"sqrt{5}$;$"+BS+"cancel{AB}$ 表示消去", source:"AI \u751f\u6210"}]); return "ok";})()');
    // 等排版真正落到 DOM:修好了通常几十毫秒;真坏了这里必然超时,下面的断言就会红(而不是随机假红)
    await waitFor(() => c.eval('document.querySelectorAll("#qaArea .qcard mjx-container").length > 0'), 8000).then(() => true).catch(() => false);
    const tex = await c.eval('(function(){var M=window.MathJax;var card=document.querySelector("#qaArea .qcard");var t=card?card.textContent:"";var a=(M&&M.config&&M.config.tex)?M.config.tex.autoload:undefined;var b=(M&&M.tex)?M.tex.autoload:undefined;return {mjxAll:document.querySelectorAll("mjx-container").length,cardMjx:card?card.querySelectorAll("mjx-container").length:-1,cardHasDollar:t.indexOf("$")>=0,cfgAutoload:(a===undefined?null:a),texLayerAutoload:(b===undefined?null:b),autoloadOff:(a===false)&&(b===undefined||b===false),text:String(t).slice(0,90)};})()');
    check('formulas typeset, no raw $ latex (autoload off)', !!tex && tex.mjxAll > 0 && tex.cardMjx > 0 && tex.cardHasDollar === false && tex.autoloadOff === true,
      tex ? ('mjxAll=' + tex.mjxAll + ' cardMjx=' + tex.cardMjx + ' cardHasDollar=' + tex.cardHasDollar + ' autoload(cfg/tex)=' + tex.cfgAutoload + '/' + tex.texLayerAutoload + ' text=' + JSON.stringify(tex.text)) : 'eval returned undefined');

    // 10) console exceptions
    await sleep(400);
    const bad = errors.filter(e => !/404|Failed to load resource|favicon|net::|ERR_/.test(e));
    check('no JS exceptions', bad.length === 0, 'n=' + bad.length + (bad[0] ? ' :: ' + bad[0].slice(0, 300) : ''));
  } catch (e) {
    check('harness error', false, String(e && e.message || e).slice(0, 300));
  } finally {
    if (c) c.close();
    edge.kill();
  }
  const fails = results.filter(r => !r.ok);
  console.log('==== QA v2: ' + (results.length - fails.length) + '/' + results.length + ' passed ====');
  process.exit(fails.length ? 1 : 0);
}
main();
