// Run: node --test tests/regression.cjs. Uses isolated memory; never reads user profiles/API keys.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const train = read('js/train.js');
const app = read('js/app.js');
function fn(source, name) {
  const start = source.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, 'missing function ' + name);
  const end = source.indexOf('\n  }', start);
  return source.slice(start, end + 4);
}
function context(functions, globals = {}) {
  const ctx = vm.createContext({ console, ...globals });
  vm.runInContext(functions.join('\n'), ctx);
  return ctx;
}
function storage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.get(k) ?? null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); }
  };
}
const clone = v => JSON.parse(JSON.stringify(v));
function question(i = 0) {
  return { type: '单选', difficulty: 3, stem: '已知函数 f(x)=x+' + i + ',求函数在指定点的值。',
    options: ['A. 1', 'B. 2', 'C. 3', 'D. 4'], answer: 'A', analysis: '代入函数式计算并核对。', source: 'AI 生成', sourceId: '' };
}
const quality = context(['parseAI', 'validateBatch', 'verifySource', 'buildPrompt', 'modelConfig'].map(n => fn(train, n)));

test('all scripts parse and all five databases retain valid IDs, boards and links', () => {
  for (const name of fs.readdirSync(path.join(root, 'js')).filter(n => n.endsWith('.js'))) {
    new vm.Script(read('js/' + name), { filename: name });
  }
  for (const name of ['data.js', 'data_chem.js', 'data-physics.js', 'data_eng.js', 'data_bio.js']) {
    const ctx = context([], { window: {} });
    vm.runInContext(read('js/' + name), ctx);
    const db = Object.values(ctx.window).find(v => v && v.points);
    const ids = new Set(db.points.map(p => p.id));
    assert.equal(ids.size, db.points.length, name);
    const boards = new Set(db.boards.map(b => b.id));
    for (const p of db.points) {
      assert.ok(boards.has(p.board), name + '/' + p.id);
      assert.ok(p.content && p.name);
      assert.ok((p.links || []).every(id => ids.has(id)), name + '/' + p.id);
    }
  }
});

test('legacy notes load and two stale windows can add notes without overwriting each other', () => {
  const old = { id: 'legacy', subject: 'math', name: '旧笔记', links: ['base'] };
  const ls = storage({ qg_custom_points_v1: JSON.stringify([old]) });
  const make = subject => context([fn(app, 'readCustomStore'), fn(app, 'saveCustomPoints')], {
    CUSTOM_PREFIX: 'qg_custom_point_v2:', DB: { subject }, localStorage: ls
  });
  const a = make('math'), b = make('math'), chem = make('chem');
  assert.equal(a.readCustomStore().length, 1);
  assert.equal(b.readCustomStore().length, 1);
  assert.equal(a.saveCustomPoints({ id: 'a', name: 'A', content: 'A', links: ['legacy'] }), true);
  assert.equal(b.saveCustomPoints({ id: 'b', name: 'B', content: 'B', links: [] }), true);
  assert.equal(chem.saveCustomPoints({ id: 'c', name: 'C', content: 'C' }), true);
  assert.deepEqual(new Set(a.readCustomStore().map(p => p.id)), new Set(['legacy', 'a', 'b', 'c']));
  assert.deepEqual(JSON.parse(ls.getItem('qg_custom_points_v1')), [old]);
  assert.deepEqual(clone(a.readCustomStore().find(p => p.id === 'a').links), ['legacy']);
});

test('quota errors are reported without modifying prior notes', () => {
  const ls = storage({ qg_custom_points_v1: '[{"id":"old","name":"keep"}]' });
  ls.setItem = () => { throw new Error('QuotaExceededError'); };
  const ctx = context([fn(app, 'saveCustomPoints')], { DB: { subject: 'math' }, CUSTOM_PREFIX: 'qg_custom_point_v2:', localStorage: ls });
  assert.equal(ctx.saveCustomPoints({ id: 'new', name: 'new' }), false);
  assert.equal(ls.getItem('qg_custom_points_v1'), '[{"id":"old","name":"keep"}]');
  const commit = app.slice(app.indexOf('    function commitCustomPointCore('), app.indexOf('    // 提交'));
  assert.ok(commit.indexOf('if (!saveCustomPoints(p)) return null;') < commit.indexOf('DB.points.push(p)'));
  const submit = app.slice(app.indexOf("submitBtn.addEventListener('click'"));
  assert.ok(submit.indexOf('if (!p) return;') < submit.indexOf("nameEl.value = ''"));
});

test('one malformed stored note cannot hide intact old and new notes', () => {
  const ls = storage({ qg_custom_points_v1: 'broken', 'qg_custom_point_v2:math:bad': '{',
    'qg_custom_point_v2:math:ok': JSON.stringify({ id: 'ok', subject: 'math', name: '笔记' }) });
  const ctx = context([fn(app, 'readCustomStore')], { localStorage: ls, CUSTOM_PREFIX: 'qg_custom_point_v2:' });
  assert.deepEqual(clone(ctx.readCustomStore()).map(p => p.id), ['ok']);
});

test('valid choice/fill/essay batches pass; invalid batches fail instead of rendering', () => {
  assert.equal(quality.validateBatch([0, 1, 2, 3].map(question), '单选', 3, 4), '');
  for (const type of ['多选', '填空', '解答']) {
    const qs = [0, 1, 2, 3].map(question).map(q => ({ ...q, type, options: type === '多选' ? q.options : null, answer: type === '多选' ? 'AC' : '答案' }));
    assert.equal(quality.validateBatch(qs, type, 3, 4), '');
  }
  const mutations = [q => q.type = '解答', q => q.difficulty = 1, q => q.difficulty = '3',
    q => q.stem = '', q => q.answer = '', q => q.analysis = '', q => q.options = [],
    q => q.options[1] = 'B. 1', q => q.answer = 'E', q => q.answer = 'AA',
    q => q.options[0] = 'D. 1', q => q.stem = { fake: true }];
  for (const mutate of mutations) {
    const qs = [0, 1, 2, 3].map(question); mutate(qs[0]);
    assert.notEqual(quality.validateBatch(qs, '单选', 3, 4), '');
  }
  assert.notEqual(quality.validateBatch([question(), question(), question(), question()], '单选', 3, 4), '');
  assert.notEqual(quality.validateBatch([null, 1, false, 'bad'], '单选', 3, 4), '');
  assert.throws(() => quality.parseAI('{"questions":"bad"}'));
});

test('invented sources, unrelated same-year text and forged verification fields never become verified', () => {
  for (const source of ['真题·历年全国卷', '真题·2016全国卷I', '联网·2025全国卷']) {
    const q = { ...question(), source, _sourceKind: 'local' };
    quality.verifySource(q, [], []);
    assert.equal(q._sourceKind, 'unverified');
    assert.match(q.source, /待核实/);
  }
  const q = { ...question(), source: '真题·2016全国卷I', sourceId: 'local-1' };
  quality.verifySource(q, [{ year: 2016, src: 'zt/2016全国卷', text: '这是完全不相关的素材。' }], []);
  assert.equal(q._sourceKind, 'unverified');
});

test('matching source must include unchanged stem and all options in the original order', () => {
  const original = question();
  const hit = { src: 'zt/测试原卷', text: original.stem + '\n' + original.options.join('\n') };
  const q = { ...clone(original), sourceId: 'local-1' };
  quality.verifySource(q, [hit], []);
  assert.equal(q._sourceKind, 'local');
  assert.equal(q.source, '本地原文匹配·zt/测试原卷');
  for (const mutate of [q => q.stem = q.stem.replace('x+0', 'x-0'), q => q.options[3] = 'D. 9', q => q.options.reverse()]) {
    const changed = { ...clone(original), sourceId: 'local-1' }; mutate(changed);
    quality.verifySource(changed, [hit], []);
    assert.equal(changed._sourceKind, 'unverified');
  }
  const web = { ...clone(original), sourceId: 'web-1' };
  quality.verifySource(web, [], [{ ...hit, src: '', title: '测试网页' }]);
  assert.equal(web._sourceKind, 'web');
});

test('English prompts use English tasks, stable subject snapshots and explicit source IDs', () => {
  const t = { p: { name: '定语从句', board: 'grammar', keywords: [], content: '语法讲解', importance: 3 } };
  const ctx = { subject: 'eng', subjectName: '高中英语', boards: [{ id: 'grammar', name: '语法' }] };
  const prompt = quality.buildPrompt(t, [{ text: 'local' }], [{ text: 'web' }], [], 3, 2, 4, { label: '阅读理解', jsonType: '单选' }, ctx);
  assert.match(prompt.system, /使用英语;解析用中文/);
  assert.doesNotMatch(prompt.system, /题干、选项、答案均用中文/);
  assert.match(prompt.user, /科目:高中英语/);
  assert.match(prompt.user, /sourceId=local-1/);
  assert.match(prompt.user, /sourceId=web-1/);
  t.p.content = '错误资料，待人工校对';
  assert.doesNotMatch(quality.buildPrompt(t, [], [], [], 3, 0, 4, null, ctx).user, /错误资料/);
});

test('default and legacy DeepSeek names migrate; explicit model choices remain intact', () => {
  for (const name of ['', null, 'deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash']) assert.equal(quality.modelConfig(name).model, 'deepseek-flash');
  assert.equal(quality.modelConfig('deepseek-reasoner').thinking.type, 'enabled');
  assert.equal(quality.modelConfig('deepseek-chat').thinking.type, 'disabled');
  assert.equal(quality.modelConfig('deepseek-v4-pro').model, 'deepseek-v4-pro');
  assert.equal(quality.modelConfig('explicit-vision-model').model, 'explicit-vision-model');
});

test('browser requests preserve JSON format, explicit thinking mode and token budget', async () => {
  for (const file of ['js/train.js', 'js/demo.js']) {
    const code = read(file);
    let sent;
    const ctx = context([fn(code, 'modelConfig'), fn(code, 'dsAsk')], {
      hasHost: false, LS_MODEL: 'model', load: () => 'deepseek-chat',
      AbortController, setTimeout, clearTimeout,
      fetch: async (url, opts) => {
        sent = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }) };
      }
    });
    await ctx.dsAsk([{ role: 'user', content: 'JSON' }], 'mock', file.endsWith('train.js') ? 8000 : { json: true, max_tokens: 8000 });
    assert.equal(sent.model, 'deepseek-flash');
    assert.deepEqual(sent.thinking, { type: 'disabled' });
    assert.deepEqual(sent.response_format, { type: 'json_object' });
    assert.equal(sent.max_tokens, 8000);
  }
});

function runContext(responder, onMaterials, opts = {}) {
  const p = { name: '导数', board: 'calc', importance: 3, keywords: ['导数'], content: '数学讲解' };
  const els = { qType: { value: 'single' }, qDiff: { value: '3' }, qSource: { value: '2' }, genBtn: {},
    askInput: { value: '' },
    qaArea: { innerHTML: 'old questions', insertBefore() {}, firstChild: null } };
  const status = [], messages = [], mats = [], cards = [];
  if (opts.ask !== undefined) els.askInput.value = opts.ask;
  if (opts.source !== undefined) els.qSource.value = opts.source;
  if (opts.target) Object.assign(p, opts.target);
  const ctx = context(['runGen', 'buildPrompt', 'parseAI', 'validateBatch', 'verifySource',
    'parseYearIntent', 'parseSearchIntent', 'yearTopic', 'pickRealN', 'targetLabel', 'sourceLabels',
    'yearIntentNote'].map(n => fn(train, n)), {
    busy: false, curDB: 'curDB' in opts ? opts.curDB : { subject: opts.subject || 'math', subjectName: opts.subjectName || '高中数学', boards: [] }, els,
    currentTarget: () => (opts.noTarget ? null : { p, kw: opts.kw }),
    keyState: () => 'mock-only', tag() {}, setSteps() {},
    setStatus: (s, kind) => status.push({ s, kind }),
    subjMats: async () => { if (onMaterials) onMaterials(ctx); return []; },
    gkMats: async (query, meta, req) => {
      mats.push({ query, req, meta });
      if (!opts.matsMeta) return [];
      Object.assign(meta, opts.matsMeta);
      return opts.matsHits || [];
    },
    webMats: async () => [],
    dsAsk: async ms => { messages.push(ms); return responder(messages.length); },
    renderQuestions: qs => { els.qaArea.innerHTML = JSON.stringify(qs); },
    document: { createElement: () => ({ set textContent(v) { cards.push(v); }, className: '' }) }
  });
  return { ctx, els, status, messages, mats, cards, p };
}
test('a network failure leaves the previous batch intact and unlocks all controls', async () => {
  const r = runContext(() => { throw new Error('模拟断网'); });
  await r.ctx.runGen();
  assert.equal(r.els.qaArea.innerHTML, 'old questions');
  assert.equal(r.ctx.busy, false);
  assert.equal(r.els.genBtn.disabled, false);
  assert.equal(r.status.at(-1).kind, 'err');
});
test('truncated model output does not trigger repeated paid requests or clear previous questions', async () => {
  const r = runContext(() => ({ ok: true, content: '{', finish_reason: 'length' }));
  await r.ctx.runGen();
  assert.equal(r.messages.length, 1);
  assert.equal(r.els.qaArea.innerHTML, 'old questions');
  assert.equal(r.status.at(-1).kind, 'err');
});
test('malformed responses retry finitely then preserve old questions; a subsequent valid response recovers', async () => {
  const invalid = () => ({ ok: true, content: JSON.stringify({ questions: [null, null, null, null] }) });
  const failed = runContext(invalid);
  await failed.ctx.runGen();
  assert.equal(failed.messages.length, 3);
  assert.equal(failed.els.qaArea.innerHTML, 'old questions');
  const recovered = runContext(n => n === 1 ? invalid() : ({ ok: true, content: JSON.stringify({ questions: [0, 1, 2, 3].map(question) }) }));
  await recovered.ctx.runGen();
  assert.equal(recovered.messages.length, 2);
  assert.notEqual(recovered.els.qaArea.innerHTML, 'old questions');
});
test('no-source fallback uses one AI call; changing subjects mid-request does not change the captured context', async () => {
  const r = runContext(() => ({ ok: true, content: JSON.stringify({ questions: [0, 1, 2, 3].map(question) }) }), ctx => {
    ctx.curDB = { subject: 'eng', subjectName: '高中英语', boards: [] };
  });
  await r.ctx.runGen();
  assert.equal(r.messages.length, 1);
  assert.match(r.messages[0][1].content, /科目:高中数学/);
  assert.match(r.messages[0][1].content, /知识点:导数/);
  assert.doesNotMatch(r.messages[0][1].content, /高中英语/);
  assert.equal(r.ctx.busy, false);
});

test('desktop database acknowledgments resolve independently and do not mutate messages for other listeners', async () => {
  const source = read('js/mainbridge.js');
  const start = source.indexOf('  (function dbAuto() {');
  const end = source.indexOf('  // 自动化测试通道', start);
  const listeners = [], timers = new Map(), sent = [], state = { textContent: '' }, rows = {};
  let timerSeq = 0;
  const ls = storage();
  const win = { CUR_SUBJECT: 'math', addEventListener() {}, MATH_DB: {
    subject: 'math', subjectName: '高中数学', boards: [], points: [{ id: 'x', name: '知识点', keywords: [], content: '正文' }]
  }, chrome: { webview: {
    addEventListener: (type, f) => listeners.push(f),
    postMessage(msg) { sent.push(msg); }
  } } };
  const ctx = context([], { window: win, localStorage: ls,
    document: { getElementById: id => id === 'dbRows' ? rows : id === 'dbState' ? state : { textContent: '数学' } },
    setTimeout: f => { const id = ++timerSeq; timers.set(id, f); return id; },
    clearTimeout: id => timers.delete(id), setInterval() {}
  });
  vm.runInContext(source.slice(start, end), ctx);
  assert.equal(listeners.length, 1);
  win.__dbAuto.stat(); win.__dbAuto.doUpload(false);
  const upload = sent.find(m => m.kind === 'dbAdd');
  const stat = sent.find(m => m.kind === 'dbStat');
  const reply = { _seq: upload._seq, ok: true, points: 1, updated: true };
  listeners[0]({ data: { _seq: 99999, ok: true } });
  listeners[0]({ data: reply });
  await new Promise(setImmediate);
  listeners[0]({ data: { _seq: stat._seq, ok: true, baseBlocks: 12, subjects: [] } });
  await new Promise(setImmediate);
  assert.equal(reply._seq, upload._seq);
  assert.match(state.textContent, /已自动上传/);
  assert.match(rows.innerHTML, /12/);
  assert.ok(ls.getItem('qg_db_digest_math'));
  assert.equal(timers.size, 0);
  win.__dbAuto.doUpload(false);
  assert.equal(sent.filter(m => m.kind === 'dbAdd').length, 1);
});

/* ============================================================
 * 年份检索(「2026」/「2026高考题」/「2026 函数单调性」)与"只给检索词也能搜"
 * ============================================================ */
const yi = context(['parseYearIntent', 'parseSearchIntent', 'yearTopic', 'pickRealN',
  'yearIntentNote', 'sourceLabels'].map(n => fn(train, n)));
const okBatch = () => ({ ok: true, content: JSON.stringify({ questions: [0, 1, 2, 3].map(question) }) });

test('year intent: a four-digit 1900-2099 year plus an exam-intent word is recognised', () => {
  assert.deepEqual(clone(yi.parseYearIntent('2026高考题')), { year: 2026, intent: true });
  assert.equal(yi.parseYearIntent('2026年高考真题').year, 2026);
  assert.equal(yi.parseYearIntent('2026年高考真题').intent, true);
  assert.equal(yi.parseYearIntent('高考真题 2024 2026').year, 2024, '多个年份取第一个');
  assert.equal(yi.parseYearIntent('1999年高考题').year, 1999, '1900 是下界');
});

test('year intent: lesson numbers, question counts and intent-only queries are not years', () => {
  for (const q of ['第01讲 集合', '4题', '第4讲 三角函数 12题', '导数 1899', '导数 2100', '编号12026']) {
    assert.equal(yi.parseYearIntent(q).year, null, q);
  }
  assert.deepEqual(clone(yi.parseYearIntent('高考真题')), { year: null, intent: true });
  assert.deepEqual(clone(yi.parseYearIntent('一轮复习讲义')), { year: null, intent: false });
});

test('search intent: a bare year dominates, a year plus content words only scopes', () => {
  for (const q of ['2026', '2026年', '2026高考', '2026高考题', '2026年高考真题', '2026 一模', '2026真题卷']) {
    assert.equal(yi.parseSearchIntent(q).mode, 'yearOnly', q);
    assert.equal(yi.parseSearchIntent(q).year, 2026, q);
  }
  for (const q of ['2026 函数单调性', '2026导数压轴', '2026数学', '2026 函数 与 导数']) {
    assert.equal(yi.parseSearchIntent(q).mode, 'yearScope', q);
    assert.ok(yi.parseSearchIntent(q).words.length > 0, q);
  }
  assert.equal(yi.parseSearchIntent('2026 函数单调性').words, '函数单调性');
  assert.equal(yi.parseSearchIntent('2026导数压轴').words, '导数压轴');
  for (const q of ['函数与导数', '第01讲 集合', '高考真题', '']) {
    assert.equal(yi.parseSearchIntent(q).mode, 'none', q);
    assert.equal(yi.parseSearchIntent(q).year, null, q);
  }
  assert.equal(yi.yearTopic(2026, '2026高考题'), '2026 年高考真题');
  assert.equal(yi.yearTopic(2026, '2026一模'), '2026 年模拟题');
});

test('year-only requests take four material questions unless the user chose AI-only', () => {
  assert.equal(yi.pickRealN(2, true), 4);
  assert.equal(yi.pickRealN(4, true), 4);
  assert.equal(yi.pickRealN('', true), 4, '非法值先回退 2,再按年份主导提到 4');
  assert.equal(yi.pickRealN(0, true), 0, '用户选 AI 原创 → 不被覆盖');
  assert.equal(yi.pickRealN(2, false), 2, '年份限定档按用户选择');
  assert.equal(yi.pickRealN(3, false), 2);
});

test('year status text reports the archive honestly: hits, papers taken and a missing year', () => {
  const only = yi.yearIntentNote(2026, { only: 1, filtered: 3666, strict: 537, matched: 537, papers: 12,
    hits: 4, tookYear: 4, yearFrom: 1952, yearTo: 2026, paper: '2026年上海卷(春)原卷.txt' });
  assert.match(only, /识别到你要 2026 年的题:本机档案命中 3666 段,其中 2026年上海卷\(春\)原卷\.txt 等 12 份试卷,已取 4 段作为素材/);
  assert.match(only, /确属 2026 年原卷 537 段/);
  const none = yi.yearIntentNote(2026, { filtered: 3666, strict: 0, matched: 0, papers: 0, hits: 0, yearFrom: 1952, yearTo: 2026 });
  assert.match(none, /本机档案里没有 2026 年的题\(档案年份 1952-2026\)。请换年份,或去掉年份按知识点出题。/);
  const fell = yi.yearIntentNote(2026, { filtered: 3666, strict: 0, matched: 0, papers: 0, hits: 2, yearFrom: 1952, yearTo: 2026 });
  assert.match(fell, /本次取的 2 段来自其他年份,按片段自身年份标注,没有一段标成 2026 年/);
  const scoped = yi.yearIntentNote(2026, { filtered: 3666, strict: 537, matched: 12, hits: 4, tookYear: 4, yearFrom: 1952, yearTo: 2026 });
  assert.match(scoped, /识别到你要 2026 年真题:本机档案 2026 年命中 12 段,已取 4 段作为素材/);
  const stale = yi.yearIntentNote(2026, { filtered: 3666, strict: 537, matched: 12, hits: 4, tookYear: 0 });
  assert.match(stale, /只有 0 段标着 2026 年/);
  const blind = yi.yearIntentNote(2026, { hits: 4, tookYear: 1 });
  assert.match(blind, /未取到本机档案的年份统计/);
  assert.match(blind, /标为 2026 年的有 1 段/);
  assert.match(yi.yearIntentNote(2026, { checked: false, why: 'subject' }), /本次未检索本机真题档案\(真题档案检索当前只对数学启用\)/);
  assert.match(yi.yearIntentNote(2026, { checked: false, why: 'source0' }), /你选择了 AI 原创\(素材题数 0\)/);
});

test('material source labels are archive file names, deduped and capped with a count', () => {
  const hits = [
    { src: 'zt/全卷解析/2026年上海卷(春)原卷.txt\r' },
    { src: 'zt/全卷解析/2026年上海卷(春)原卷.txt\r' },
    { src: 'zt/全卷解析/2026年北京卷解析.txt' },
    { src: 'zt/全卷解析/2026年天津卷解析.txt' },
    { src: 'zt/全卷解析/2026年全国I卷解析.txt' }
  ];
  assert.equal(yi.sourceLabels(hits, 3), '2026年上海卷(春)原卷.txt · 2026年北京卷解析.txt · 2026年天津卷解析.txt 等 4 段');
  assert.equal(yi.sourceLabels(hits, 1), '2026年上海卷(春)原卷.txt 等 4 段');
  assert.equal(yi.sourceLabels([{ title: '某网页' }], 3), '某网页');
  assert.equal(yi.sourceLabels([], 3), '');
});

test('searching a bare year drives the retrieval: no knowledge point in the query, prompt and status say so', async () => {
  const r = runContext(okBatch, null, {
    ask: '2026', kw: '2026', noTarget: true,
    matsMeta: { filtered: 3666, strict: 537, matched: 537, papers: 12, yearFrom: 1952, yearTo: 2026, fallback: false, yearOnly: true, year: 2026 },
    matsHits: [{ year: 2026, src: 'zt/全卷解析/2026年上海卷(春)原卷.txt', text: '2026 年真题原文' }]
  });
  await r.ctx.runGen();
  assert.equal(r.mats.length, 1);
  assert.equal(r.mats[0].query, '2026', '年份主导时检索式就是年份本身');
  assert.equal(r.mats[0].req.year, 2026);
  assert.equal(r.mats[0].req.yearOnly, true);
  assert.match(r.messages[0][0].content, /点名要 2026 年的\(高考\/试卷类\)真题/);
  assert.match(r.messages[0][0].content, /年份整卷"模式:用户要的是 2026 年那一套卷子\(不是某个知识点的专项题\)/);
  assert.match(r.messages[0][0].content, /不得凭记忆写 2026 年真题/);
  assert.match(r.messages[0][0].content, /不能凭年份认证来源/, '既有硬规则不能被年份锚定挤掉');
  assert.match(r.messages[0][0].content, /禁止凭记忆伪造真题/);
  assert.match(r.messages[0][1].content, /本次忽略当前知识点/);
  assert.doesNotMatch(r.messages[0][1].content, /知识点:导数/, '年份检索不拼当前知识点');
  assert.match(r.status[0].s, /按年份整卷检索,本次忽略当前知识点/);
  const last = r.status.at(-1).s;
  assert.match(last, /因指定年份,已把素材题数提到 4 题/);
  assert.match(last, /识别到你要 2026 年的题:本机档案命中 3666 段,其中 2026年上海卷\(春\)原卷\.txt 等 12 份试卷,已取 1 段作为素材/);
  assert.ok(r.cards.some(c => /素材来源:2026年上海卷\(春\)原卷\.txt/.test(c)), '素材来源要显示给用户');
});

test('a selected knowledge point never leaks into a bare-year query', async () => {
  const r = runContext(okBatch, null, {
    ask: '2026', noTarget: false,
    matsMeta: { filtered: 3666, strict: 537, matched: 537, papers: 12, yearFrom: 1952, yearTo: 2026 },
    matsHits: [{ year: 2026, src: 'zt/全卷解析/2026年北京卷解析.txt', text: '2026 北京卷原文' }]
  });
  await r.ctx.runGen();
  assert.equal(r.mats[0].query, '2026');
  assert.doesNotMatch(r.mats[0].query, /导数/, '主系统选中点也不参与年份检索');
  assert.match(r.status[0].s, /识别到你要 2026 年的题/);
  assert.match(r.cards.find(c => /本批次/.test(c)), /本批次:高中数学 · 2026 年高考真题/);
});

test('a year plus content words only scopes the year and keeps the user choice of material count', async () => {
  const r = runContext(okBatch, null, {
    ask: '2026 函数单调性', noTarget: true,
    matsMeta: { filtered: 3666, strict: 537, matched: 4, papers: 3, yearFrom: 1952, yearTo: 2026 },
    matsHits: [{ year: 2026, src: 'zt/全卷解析/2026年全国I卷解析.txt', text: '2026 全国I卷原文' }]
  });
  await r.ctx.runGen();
  assert.equal(r.mats[0].query, '2026 函数单调性');
  assert.equal(r.mats[0].req.yearOnly, false);
  assert.match(r.messages[0][1].content, /2026 年 \+ 函数单调性/);
  assert.doesNotMatch(r.messages[0][1].content, /知识点:导数/);
  assert.doesNotMatch(r.status.at(-1).s, /素材题数提到 4 题/, '限定档按用户选择(默认 2)');
  assert.match(r.status.at(-1).s, /识别到你要 2026 年真题:本机档案 2026 年命中 4 段,已取 1 段作为素材/);
});

test('without a year the knowledge point keeps driving retrieval exactly as before', async () => {
  const r = runContext(okBatch, null, { ask: '函数与导数', kw: '函数与导数' });
  await r.ctx.runGen();
  assert.match(r.mats[0].query, /^导数 导数 函数与导数$/);
  assert.equal(r.mats[0].req.year, 0);
  assert.equal(r.mats[0].req.yearOnly, false);
  assert.match(r.messages[0][1].content, /知识点:导数/);
  assert.doesNotMatch(r.status.at(-1).s, /素材题数提到 4 题/);
  assert.equal(r.status.at(-1).kind, 'warn', '无素材时的既有提示不变');
});

test('a year the archive does not have is reported as missing instead of faked from other years', async () => {
  const r = runContext(okBatch, null, {
    ask: '2050高考题', noTarget: true,
    matsMeta: { filtered: 0, strict: 0, matched: 0, papers: 0, yearFrom: 1952, yearTo: 2026, fallback: true },
    matsHits: [{ year: 2023, src: 'zt/全卷解析/2023年全国甲卷.txt', text: '其他年份素材' }]
  });
  await r.ctx.runGen();
  const last = r.status.at(-1).s;
  assert.match(last, /识别到你要 2050 年的题:本机档案里没有 2050 年的题\(档案年份 1952-2026\)。请换年份,或去掉年份按知识点出题。/);
  assert.match(last, /本次取的 1 段来自其他年份,按片段自身年份标注,没有一段标成 2050 年/);
  assert.match(r.messages[0][1].content, /本机档案里没有 2050 年的题\(档案年份 1952-2026\)/);
  assert.match(r.messages[0][1].content, /不得把任何题目说成\/标成 2050 年/);
});

test('an explicit AI-only choice is not overridden by a year query', async () => {
  const r = runContext(okBatch, null, {
    ask: '2026高考题', noTarget: true, source: '0',
    matsMeta: { filtered: 3666, strict: 537, matched: 537, papers: 12, yearFrom: 1952, yearTo: 2026 },
    matsHits: [{ year: 2026, src: 'zt/x.txt', text: 'y' }]
  });
  await r.ctx.runGen();
  assert.equal(r.mats.length, 0, '选了 AI 原创就不该去检索本机真题档案');
  const last = r.status.at(-1).s;
  assert.doesNotMatch(last, /素材题数提到 4 题/);
  assert.match(last, /识别到你要 2026 年的题:你选择了 AI 原创\(素材题数 0\),本次未检索本机真题档案/);
  assert.match(r.messages[0][1].content, /用户选择了 AI 原创\(素材题数 0\),本次未检索本机真题档案/);
});

test('a search-only query with no knowledge point is allowed; an empty one is refused with a hint', async () => {
  const searched = runContext(okBatch, null, { ask: '导数新题型', noTarget: true });
  await searched.ctx.runGen();
  assert.equal(searched.messages.length, 1, '只给检索词也要能出题');
  assert.equal(searched.mats[0].query, '导数新题型', '无知识点时检索式就是搜索框原话');
  assert.match(searched.status[0].s, /检索式:导数新题型/);
  assert.match(searched.messages[0][1].content, /知识点:未指定\(用户只输入了检索式/);
  assert.match(searched.messages[0][1].content, /素材为空时如实说明/);

  const empty = runContext(okBatch, null, { ask: '', noTarget: true });
  await empty.ctx.runGen();
  assert.equal(empty.messages.length, 0);
  assert.equal(empty.mats.length, 0);
  assert.equal(empty.status.at(-1).kind, 'warn');
  assert.match(empty.status.at(-1).s, /请输入要搜的题\(例如:2026高考题\),或在主系统点选知识点/);
});

test('a missing subject database still refuses to run, with the original hint', async () => {
  const r = runContext(okBatch, null, { ask: '2026高考题', noTarget: true, curDB: null });
  await r.ctx.runGen();
  assert.equal(r.messages.length, 0);
  assert.equal(r.mats.length, 0);
  assert.equal(r.status.at(-1).kind, 'warn');
  assert.match(r.status.at(-1).s, /先选目标:在主系统点选知识点,或输入关键词并定位/);
});

test('the target line shows the search expression and says the knowledge point is ignored', () => {
  const els = { targetInfo: { innerHTML: '' }, askInput: { value: '2026高考题' } };
  const ctx = context(['esc', 'parseYearIntent', 'parseSearchIntent', 'yearTopic', 'renderTarget'].map(n => fn(train, n)),
    { els, curDB: { boards: [] }, live: { selName: '' } });
  ctx.renderTarget(null);
  assert.match(els.targetInfo.innerHTML, /检索式:<b>2026高考题<\/b> ｜ 2026 年高考真题 ｜ 已按年份检索,本次忽略当前知识点/);
  els.askInput.value = '函数与导数';
  ctx.renderTarget(null);
  assert.match(els.targetInfo.innerHTML, /检索式:<b>函数与导数<\/b> ｜ 未指定知识点,按素材出题/);
  els.askInput.value = '函数与导数';
  ctx.renderTarget({ p: { name: '导数', board: 'calc', importance: 3, keywords: ['导数'], core: 3 }, via: 'ask', matched: 1 });
  assert.match(els.targetInfo.innerHTML, /目标:<b>导数<\/b>/);
  els.askInput.value = '';
  ctx.renderTarget(null);
  assert.equal(els.targetInfo.innerHTML, '');
});

test('desktop host filters by year, prefers real papers and logs the decision', () => {
  const host = fs.readFileSync(path.join(root, '桌面版/build/Program.cs'), 'utf8');
  // 年份必须是 1900-2099 的四位数,且两侧不能顶数字(不误判 第01讲 / 4题 / 12026)
  assert.ok(host.includes('(?<!\\d)(?:19|20)\\d{2}(?!\\d)'), '查询年份正则');
  assert.ok(host.includes('" year=" + qYear + " intent=" + (qIntent ? "真题" : "-")'), 'MATS 日志带 year=/intent=');
  assert.ok(host.includes('" filtered=" + yearCand'), 'MATS 日志带 filtered=');
  assert.ok(host.includes('year = qYear, intent = qIntent, yearMode = yearMode, yearOnly = qYearOnly'), '年份识别结果要回给页面');
  assert.ok(host.includes('filtered = yearCand, strict = yearStrict'), '候选数/真原卷数要回给页面');
  // 只有"自身年份 == 目标年份"的块能当该年份素材(合集目录名带年份的不算)
  assert.ok(host.includes('bool inYear = limitYear && BlockYearOfHead(head) == qYear;'));
  assert.ok(host.includes('if (limitYear && !inYear) continue;'));
  // 年份主导档不按关键词过滤,且试卷优先
  assert.ok(host.includes('scores[i] = (IsPaperHead(head) ? 100000.0 : 0.0) + BlockWeight(b);'));
  assert.ok(host.includes('原卷|真题|全卷解析|解析|全国卷|新高考|上海卷|北京卷|天津卷|浙江卷|模拟|一模|二模'), '试卷优先标记');
});
