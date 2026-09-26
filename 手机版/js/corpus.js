/* ============================================================
 * corpus.js — 手机版「本机资料库」(包内语料)读取 + 检索
 * [原创指纹] QG-20260920-5e5d5a · 文件 js/corpus.js · © 2026 PHILlA093 · 保留所有权利
 * ------------------------------------------------------------
 * 为什么要有这个文件:
 *   桌面版的「本机资料库 / 破卷真题素材」全部由 WinForms 宿主代劳 ——
 *   宿主读 数据库\qg_corpus.txt(###SRC: 分块)与 数据库\qg_subjects.txt
 *   (###SUBJ: 科目上传区),解析后由 kind:'mats' 消息返回命中片段。
 *   手机版(Capacitor APK / 手机浏览器)**没有宿主**,那条路走不通。
 *   本文件就是把宿主那一套解析与检索口径**原样搬到 JS 侧**,
 *   数据源换成同一个包内的 数据库\*.txt(fetch 自己的 https://localhost/ 资源)。
 *
 * 口径来源(桌面版 build\Program.cs,只读参考,未改动):
 *   · SplitBlocks()      —— 块分隔与长度门槛
 *   · LoadSubjects()     —— ###SUBJ: 科目区段
 *   · RebuildMerged()    —— 上传区按 560 字切块,拼进检索池
 *   · BlockYear/BlockWeight() —— 真题年份权重(2017-2026 ×3)
 *   · HandleMats()       —— 分词、召回门槛、排序、输出配额
 *   · 年份意图(新增)     —— 查询里的 (19|20)\d{2} + 意图词(高考/真题/试卷…)
 *                           → 检索先按"头部含该年份"筛出该年份子池,再做原有匹配;
 *                           子池为空时退回普通检索,并把真实情况回报给界面。
 *                           同一口径由 train.js 用于 realN / 提示词 / 状态栏。
 *   逐条对应见下面每个函数上方的 "宿主对应" 注释。
 *
 * 刻意保留的宿主怪癖(改了才会"两边不一致",所以照样复刻):
 *   ① 宿主取 src 用 block.Substring(8, …),而 "###SRC:" 只有 7 个字符,
 *      于是 src 的第一位被吃掉:zt/… → "t/…",subj/… → "ubj/…"。
 *   ② 同理 ###SUBJ: 头的 key 用 Substring(8) → "math" → "ath"。
 *      两者都只影响"回传字符串",不影响召回与排序;手机版逐字节照抄。
 *
 * 性能约定(手机弱):
 *   · 懒加载:不在启动时读;只有第一次真正检索(gkMats/subjMats)时才 fetch + 解析;
 *   · 解析只用一次 String.split('\n###SRC:'),不对 44MB 全文做正则扫描;
 *     年份正则只跑在每个块的首行(与宿主一致);
 *   · 解析结果只放内存(33k 块 ≈ 47MB,localStorage 5~10MB 塞不下,
 *     IndexedDB 还要把同样字节再落一份盘 —— 都不划算,故只用内存);
 *   · 解析完立刻丢掉 45MB 原文引用,峰值过后常驻只剩块数组;
 *   · 失败一律给出可读原因(HTTP 码 / 网络异常 / 格式不符),绝不静默返回空。
 * ============================================================ */
(function () {
  'use strict';

  var VERSION = 'phone-2';

  /* 包内资源:与桌面版 数据库\qg_corpus.txt / qg_subjects.txt **同一个文件**
     (构建时按字节复制,见 _gaokao_work\语料内置说明.md 的 SHA256 对拍) */
  var CORPUS_URL = '数据库/qg_corpus.txt';
  var SUBJ_URL = '数据库/qg_subjects.txt';

  /* ---------- 与宿主一致的常量 ---------- */
  var BLOCK_SEP = '\n###SRC:';      // SplitBlocks: all.Split(new[]{"\n###SRC:"}, RemoveEmptyEntries)
  var SRC_TAG = '###SRC:';          // 7 个字符
  var SUBJ_TAG = '###SUBJ:';        // 7 个字符
  var MIN_BLOCK = 40;               // SplitBlocks: 只保留 s.Length > 40 的块
  var SUBJ_CHUNK_CHARS = 560;       // SubjChunkChars:上传区切块粒度
  var RECENT_FROM = 2017, RECENT_TO = 2026;   // 近十年区间(含)
  var W_RECENT = 3.0, W_NORMAL = 1.0;         // 年份权重
  var YEAR_RE = /(?:19|20)\d{2}(?=\s*年)/;    // BlockYearRe
  var TOKEN_SEP = /[ ,，、;；]+/;             // HandleMats: ' ' , ， 、 ; ；

  /* ---------- 年份意图(与桌面宿主 HandleMats 同一口径) ----------
   * YEAR_Q_RE:查询里的四位数年份。必须是 19xx/20xx 两个前缀 + 两位数字,
   *   「第01讲」「4题」这类 1~2 位数字、以及 1800 这种非考纲年份都不会被认成目标年份;
   *   「2026年高考」也照样识别(四位数字后面跟"年"不影响匹配)。
   * INTENT_WORDS:出现任一 → 判定"用户要找真题/试卷素材"。
   * 两者同时命中才算"年份意图"(见 parseYearIntent);只有年份(如"2026 集合")
   * 不改变既有检索,免得用户随手输个数字就被强行限定年份。 */
  var YEAR_Q_RE = /(?:19|20)\d{2}/;
  var INTENT_WORDS = ['高考', '真题', '试题', '考卷', '试卷', '模拟', '联考', '月考', '质检', '一模', '二模', '押题'];

  /* "试卷优先"排序用的路径特征词(年份主导检索时用):
   * 用户搜「2026」要的是那一年的**整卷真题**,不是"2026 年的某知识点题"。
   * 年份子池里第一段可能是任一含 2026 的块(实测多是"2008-2026"这种年份区间目录),
   * 所以按路径里是否出现下列词做一层优先,让原卷/解析/各地卷排前面。 */
  var PAPER_HINTS = ['原卷', '真题', '全卷解析', '解析', '全国卷', '新高考',
    '上海卷', '北京卷', '天津卷', '浙江卷', '模拟', '一模', '二模'];

  /* 桌面版同期的块数(仅用于"疑似不完整"提示,不参与任何判定逻辑) */
  var EXPECT_BLOCKS = 33255;

  /* ---------- 状态 ---------- */
  var state = {
    phase: 'idle',        // idle | loading | ready | error
    err: '',              // 致命错误(可读中文)
    warn: '',             // 非致命提示(如科目上传区读取失败)
    where: '',            // 数据来源描述(对应宿主的 baseWhere)
    base: null,           // string[] 基座块
    merged: null,         // string[] 检索池 = 基座 + 科目上传区切块
    subjects: [],         // [{key,name,points}]
    bytes: 0,             // 语料文件字节数
    ms: {}                // 耗时分解
  };
  var loading = null;

  function now() {
    try { return (window.performance && performance.now) ? performance.now() : Date.now(); }
    catch (e) { return Date.now(); }
  }
  function r1(v) { return Math.round(v * 10) / 10; }

  /* ============================================================
   * 解析:宿主 SplitBlocks(string all) 的逐行等价实现
   *   C#: parts = all.Split(["\n###SRC:"], RemoveEmptyEntries)
   *       s = p.StartsWith("###SRC:") ? p : "###SRC:" + p
   *       if (s.Length > 40) list.Add(s)
   * ============================================================ */
  function splitBlocks(all) {
    if (!all || all.length < MIN_BLOCK) return [];
    var parts = all.split(BLOCK_SEP);
    var list = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.length === 0) continue;                 // RemoveEmptyEntries
      var s = p.indexOf(SRC_TAG) === 0 ? p : SRC_TAG + p;
      if (s.length > MIN_BLOCK) list.push(s);
    }
    return list;
  }

  /* ============================================================
   * 解析:宿主 LoadSubjects() 的等价实现
   *   C# 用 File.ReadAllLines(Encoding.UTF8):按 \r\n | \n | \r 分行,且自动吃掉 BOM
   *   段落文本 = 逐行 AppendLine(即每行补 \r\n)
   *   头部 = line.Substring(8).Split('|') → key|hash|points|name(同样少取一位)
   * ============================================================ */
  // File.ReadAllLines 语义:文件以换行结尾时**不**产生末尾那个空行。
  // 直接 split 会多出一个 "" 元素,导致最后一块上传区切块多一个换行(实测差 1 个字符,
  // 见 _gaokao_work/verify_blocks.js 的逐块 MD5 对拍)。
  function readAllLines(text) {
    if (!text) return [];
    var lines = text.split(/\r\n|\n|\r/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  function loadSubjects(text) {
    var out = [];
    if (!text) return out;
    var lines = readAllLines(text);
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf(SUBJ_TAG) !== 0) continue;
      var h = lines[i].substring(8).split('|');      // 与宿主一致:Substring(8)
      if (h.length < 4) continue;
      var e = { key: h[0], hash: h[1], points: parseInt(h[2], 10) || 0, name: h[3], lines: [] };
      i++;
      while (i < lines.length && lines[i].indexOf(SUBJ_TAG) !== 0) { e.lines.push(lines[i]); i++; }
      i--;
      out.push(e);
    }
    return out;
  }

  /* ============================================================
   * 解析:宿主 RebuildMerged() 的等价实现
   *   上传区正文先 \r\n→\n 再按 \n 切行(段落末尾 AppendLine 会多出一个空行,照抄),
   *   然后按 560 字切块,块头 "###SRC:subj/<key>/<part> 自动上传(<points>点)"
   * ============================================================ */
  function rebuildMerged(base, subjects) {
    var list = base.slice();
    for (var si = 0; si < subjects.length; si++) {
      var e = subjects[si];
      var lines = (e.lines.join('\n') + '\n').replace(/\r\n/g, '\n').split('\n');
      var buf = '';
      var part = 0;
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        if (buf.length > 0 && buf.length + ln.length + 1 > SUBJ_CHUNK_CHARS) {
          part++;
          list.push(SRC_TAG + 'subj/' + e.key + '/' + part + ' 自动上传(' + e.points + '点)\n' + buf);
          buf = '';
        }
        if (buf.length > 0) buf += '\n';
        buf += ln;
      }
      if (buf.length > 0) {
        part++;
        list.push(SRC_TAG + 'subj/' + e.key + '/' + part + ' 自动上传(' + e.points + '点)\n' + buf);
      }
    }
    return list;
  }

  /* 宿主 BlockYear:只看块首行,取首个 (19|20)xx 后跟"年"的四位数 */
  function blockYear(block) {
    if (!block) return 0;
    var nl = block.indexOf('\n');
    var head = nl > 0 ? block.substring(0, nl) : block;
    var m = YEAR_RE.exec(head);
    if (!m) return 0;
    var y = parseInt(m[0], 10);
    return isNaN(y) ? 0 : y;
  }
  function isRecent(y) { return y >= RECENT_FROM && y <= RECENT_TO; }
  /* 宿主 BlockWeight:只有 ###SRC:zt/ 开头的真题按年份加权,其余恒为 1 */
  function blockWeight(block) {
    if (!block) return W_NORMAL;
    if (block.indexOf(SRC_TAG + 'zt/') !== 0) return W_NORMAL;
    return isRecent(blockYear(block)) ? W_RECENT : W_NORMAL;
  }
  /* 宿主 BlockLen:去掉首行后的长度 */
  function blockLen(block) {
    var sep = block.indexOf('\n');
    return sep > 0 ? block.length - sep : block.length;
  }
  /* 宿主取 src 的写法:bk.Substring(8, sep - 8)(少一位,见文件头说明)*/
  function srcOf(block, sep) {
    return sep > 8 ? block.substring(8, sep) : '';
  }

  /* ============================================================
   * 年份意图:查询解析(纯函数 —— 只依赖入参,便于离线断言)
   * ------------------------------------------------------------
   * 返回 { year, intent, word, hit, raw }:
   *   year   : 查询里第一个四位数年份(数字);没有则 null
   *   intent : 判定标签。'真题' = 命中意图词,用户要找真题/试卷素材;'' = 没有这个意图
   *            (用 !!r.intent 即为布尔判定,与桌面宿主同一判定)
   *   word   : 实际命中的那个意图词(诊断/日志用)
   *   hit    : 年份意图是否成立(= year 与 intent 同时命中),调用方用这一个字段就够
   * 为什么"年份 + 意图词"同时命中才算:
   *   只有年份(「2026 集合」)按原口径检索,不擅自把用户限定到某一年;
   *   只有意图词(「高考真题」)是既有的普通检索路径,年份为空。
   * ============================================================ */
  function parseYearIntent(q) {
    var s = q == null ? '' : String(q);
    var year = null;
    var m = YEAR_Q_RE.exec(s);
    if (m) {
      var y = parseInt(m[0], 10);
      if (y >= 1900 && y <= 2099) year = y;       // 四位 + 19xx/20xx,再兜一道范围
    }
    var word = '';
    for (var i = 0; i < INTENT_WORDS.length; i++) {
      if (s.indexOf(INTENT_WORDS[i]) >= 0) { word = INTENT_WORDS[i]; break; }
    }
    return {
      year: year,
      intent: word ? '真题' : '',
      word: word,
      hit: !!(year && word),
      raw: s
    };
  }

  /* 块首行(= "###SRC:<文件路径>")。年份筛选只看这一行,与 BlockYear 的取法一致 */
  function headOf(block) {
    if (!block) return '';
    var nl = block.indexOf('\n');
    return nl > 0 ? block.substring(0, nl) : block;
  }

  /* 该块是否属于某年份:头部(路径)含该四位年份即算。
   * 覆盖两种真实写法:
   *   ① 文件名带年份   zt/全卷解析/2026年上海卷(春)原卷.txt
   *   ② 只看路径里的年份 zt/…/2008-2026·（山东）数学高考真题/…
   * 注:②是**宽松包含**,目录名里的年份区间(2008-2026)也会命中,
   *    所以"筛出来的段"不等于"文件本身一定是该年原卷" —— 这一点由提示词里的
   *    硬规则兜住(年份只能以片段原文为准,不得凭路径年份认证来源)。 */
  function headHasYear(block, year) {
    if (!block || !(year > 0)) return false;
    return headOf(block).indexOf(String(year)) >= 0;
  }

  /* 年份子池:先按 src 前缀(可选)再过"头部含该年份",返回块引用数组。
   * 顺序保持不变(仍是原池顺序),后续匹配/排序口径一个字没改。 */
  function filterByYear(pool, year, prefix) {
    var out = [];
    if (!pool || !pool.length || !(year > 0)) return out;
    var ys = String(year);
    for (var i = 0; i < pool.length; i++) {
      var b = pool[i];
      if (prefix && b.indexOf(prefix) !== 0) continue;
      if (headOf(b).indexOf(ys) < 0) continue;
      out.push(b);
    }
    return out;
  }

  /* 试卷优先排序键(纯函数):路径命中 PAPER_HINTS → 0(优先),否则 1。
   * 只影响年份主导检索的排序;**不改动**命中门槛、评分与权重口径。 */
  function paperRank(block) {
    var h = headOf(block);
    for (var i = 0; i < PAPER_HINTS.length; i++) {
      if (h.indexOf(PAPER_HINTS[i]) >= 0) return 0;
    }
    return 1;
  }

  /* 年份候选 / 真原卷(与桌面 HandleMats 同一口径):
   *   候选   = 头部含该年份字符串的块(2026年上海卷… / …/2008-2026/… / 2026届…);
   *   真原卷 = 候选里**自身年份 == 该年份**的块(块首第一个"四位 + 年"就是它 —— 与 BlockYear 一致)。
   * 为什么必须再精筛一道:实测 zt 里"头部含 2026"的 3 665 段中只有 536 段自身就是 2026 年,
   * 其余是 "…/2008-2026/2025年高考数学试卷.txt" 这种合集目录命中 —— 自身年份是 2025。
   * 拿它们当 2026 素材,等于状态栏说"2026 年命中 N 段"、模型手里却是别的年份的卷子。
   * 年份档只用真原卷;真原卷 0 段 → 退回普通检索并如实标注(见 search)。 */
  function yearSets(pool, year, prefix) {
    var cand = [], strict = [];
    if (!pool || !pool.length || !(year > 0)) return { candidates: cand, strict: strict };
    var ys = String(year);
    for (var i = 0; i < pool.length; i++) {
      var b = pool[i];
      if (prefix && b.indexOf(prefix) !== 0) continue;
      if (headOf(b).indexOf(ys) < 0) continue;
      cand.push(b);
      if (blockYear(b) === year) strict.push(b);
    }
    return { candidates: cand, strict: strict };
  }

  /* 年份限定档的召回放宽(与桌面 HandleMats 同一手法):
   * 中文没有词边界,「函数单调性」整串去匹配常常 0 命中 —— 实测真原卷池(2026 年 536 段)
   * 命中 0 段,而年份主导档全池命中 536 段,限定档就等于白干。
   * 把长中文实词再拆成 2 字片段一起参与匹配(命中片段越多分越高 → 排越前);
   * 只对中文词生效:英文按 2 字母切会命中一大片无意义的块。 */
  function expandCjkTerms(terms) {
    var extra = [];
    for (var i = 0; i < terms.length; i++) {
      var w = terms[i];
      if (w.length < 4) continue;
      var cjk = 0;
      for (var c = 0; c < w.length; c++) {
        var code = w.charCodeAt(c);
        if (code >= 0x4e00 && code <= 0x9fff) cjk++;
      }
      if (cjk * 2 < w.length) continue;
      for (var k = 0; k + 2 <= w.length; k++) {
        var s2 = w.substring(k, k + 2);
        if (terms.indexOf(s2) >= 0 || extra.indexOf(s2) >= 0) continue;
        extra.push(s2);
      }
    }
    return terms.concat(extra);
  }

  /* 真原卷里"有几份不同的试卷"+ 前 max 个文件名(桌面 HandleMats 的 papers 同口径):
   * 文件名取路径末段,去掉 \r 与首尾空白。 */
  function paperInfo(pool, max) {
    var names = [], seen = {};
    for (var i = 0; i < (pool ? pool.length : 0); i++) {
      var h = headOf(pool[i]);
      var p = h.lastIndexOf('/');
      var s = (p >= 0 ? h.substring(p + 1) : h).replace(/\r/g, '').replace(/^\s+|\s+$/g, '');
      if (!s || seen[s]) continue;
      seen[s] = true;
      if (names.length < (max > 0 ? max : 3)) names.push(s);
    }
    var papers = 0;
    for (var k in seen) { if (Object.prototype.hasOwnProperty.call(seen, k)) papers++; }
    return { names: names, papers: papers };
  }

  /* 来源路径是否**直接写了该年份**(2026年上海卷(春)原卷.txt → 0),否则 1。
   * 为什么不直接拿"头部含 2026"当年份依据:实测 zt 里头部含 2026 的 3 665 段中,
   * 只有 536 段路径直写"2026年",其余多是 "…/2008-2026/2025年高考数学试卷….txt"
   * 这种**年份区间目录**命中 —— 块本身很可能是别的年份的卷子。
   * 年份主导检索时年份直写的排前,免得用户搜 2026 却先拿到 2022 的卷子。 */
  function yearNamedRank(block, year) {
    if (!(year > 0)) return 1;
    return headOf(block).indexOf(String(year) + '年') >= 0 ? 0 : 1;
  }

  function countYearNamed(pool, year) {
    var n = 0;
    if (!(year > 0)) return 0;
    for (var i = 0; i < (pool ? pool.length : 0); i++) {
      if (yearNamedRank(pool[i], year) === 0) n++;
    }
    return n;
  }

  /* 本机档案的年份跨度(仅用于"该年份 0 段"时如实告知能查哪些年)。
   * 口径:块首第一个 (19|20)\d{2};懒惰计算 + 按(池子引用, 前缀)缓存一次,
   * 绝不在每次检索里重扫 37k 块。
   * 同时给出 20xx 区间(from20/to20):界面文案按"档案年份 2000-2026"这种
   * 通行说法报主区间,19xx 的早期真题(实测 1952-1999 确有)另附一句说明,
   * 既不漏报也不假报。 */
  var yearRangeCache = null;
  function archiveYearRange(pool, prefix) {
    if (yearRangeCache && yearRangeCache.pool === pool && yearRangeCache.prefix === prefix) {
      return yearRangeCache.out;      // 只回传干净的区间对象(缓存内部才持有池引用)
    }
    var from = 0, to = 0, from20 = 0, to20 = 0;
    for (var i = 0; i < (pool ? pool.length : 0); i++) {
      var b = pool[i];
      if (prefix && b.indexOf(prefix) !== 0) continue;
      var m = YEAR_Q_RE.exec(headOf(b));
      if (!m) continue;
      var y = parseInt(m[0], 10);
      if (!(y >= 1900 && y <= 2099)) continue;
      if (!from || y < from) from = y;
      if (!to || y > to) to = y;
      if (y >= 2000) {
        if (!from20 || y < from20) from20 = y;
        if (!to20 || y > to20) to20 = y;
      }
    }
    // 返回对象里**不能**带 pool:它会跟着 mats 回执一路走到界面,
    // 37k 块的引用既没必要,也会让任何一次 JSON 序列化爆掉。
    yearRangeCache = {
      pool: pool, prefix: prefix,
      out: { from: from, to: to, from20: from20, to20: to20 }
    };
    return yearRangeCache.out;
  }

  /* ============================================================
   * 排序:逐位复刻宿主 .NET 的排序过程(不是"随便排一下")
   * ------------------------------------------------------------
   * 宿主用的是 List<int>.Sort(Comparison<int>),实测(_gaokao_work/sort_probe.js 与
   * sort_real2.js:把自制检索池灌进宿主真实 HandleMats,再逐批"揭示"它的完整排序顺序)
   * 走的是 .NET Framework 的经典 QuickSort:
   *   ① 每次分区前先把 low / middle / high 三个位置按比较器排好(三数取中),再取中点当枢轴;
   *   ② 双指针扫描:左指针停在 "≥ 枢轴",右指针停在 "≤ 枢轴",交换后各自前进;
   *   ③ 只递归较小的一半,另一半用循环继续(递归深度 O(log n))。
   * 为什么必须照抄:V8 的 Array.prototype.sort 自 ES2019 起是**稳定**排序,
   * 在"命中词数相同 + 块体长度相同"的块上会保留扫描顺序,而宿主的快排会打乱 ——
   * 实测 69 条查询里 53 条"命中集合一样、但首条块不同"就是这么来的。
   * 逐位复刻后,手机版与桌面版的命中顺序完全一致(69/69 逐字节相同)。
   * 注:扫描方向与枢轴都踩过坑 —— 右指针必须是 cmp(keys[j], x) > 0(而不是 cmp(x, keys[j]) > 0),
   *     两者在"键值全等"的自制池上看不出差别,只有真实比较器才暴露(会把数组排成乱序)。
   * ============================================================ */
  function swapIfGreater(keys, cmp, a, b) {
    if (a !== b && cmp(keys[a], keys[b]) > 0) {
      var t = keys[a]; keys[a] = keys[b]; keys[b] = t;
    }
  }
  function dotNetSort(keys, cmp) {
    if (keys.length < 2) return keys;
    quickSort(keys, 0, keys.length - 1, cmp);
    return keys;
  }
  function quickSort(keys, left, right, cmp) {
    do {
      var i = left, j = right;
      var middle = i + ((j - i) >> 1);
      swapIfGreater(keys, cmp, i, middle);       // 三数取中:先把 low/middle/high 排好
      swapIfGreater(keys, cmp, i, j);
      swapIfGreater(keys, cmp, middle, j);
      var x = keys[middle];                      // 枢轴取排好后的中点元素
      do {
        while (cmp(keys[i], x) < 0) i++;         // 左指针:停在 ≥ 枢轴
        while (cmp(keys[j], x) > 0) j--;         // 右指针:停在 ≤ 枢轴
        if (i > j) break;
        if (i < j) { var t = keys[i]; keys[i] = keys[j]; keys[j] = t; }
        i++; j--;
      } while (i <= j);
      // 只递归较小的一半,另一半用循环继续(与 .NET 一致)
      if ((j - left) <= (right - i)) {
        if (left < j) quickSort(keys, left, j, cmp);
        left = i;
      } else {
        if (i < right) quickSort(keys, i, right, cmp);
        right = j;
      }
    } while (left < right);
    return keys;
  }

  /* 命中排序入口:默认用宿主的 .NET 排序(QA 里可替换成别的实现做对照实验) */
  var sortHits = dotNetSort;

  /* ============================================================
   * 检索:宿主 HandleMats() 的逐行等价实现
   *   terms    = q.Split(' ', ',', '，', '、', ';', '；') 去空,Trim 后长度 ≥ 2
   *   召回     = 命中词数 ≥ (loose ? 1 : 2),单词最多数 3
   *   排序     = 加权分(命中词数 × 年份权重)降序 → 块体长度升序(用宿主的 .NET 排序)
   *   输出     = loose: ≤10 条 / 14000 字 / 每条 1200… 见下 maxHits/charCap/perCap
   * ------------------------------------------------------------
   * 年份意图(与桌面宿主同一口径,见 parseYearIntent):
   *   调用方显式给了 msg.year(>0)就用它;否则从 query 自己识别 ——
   *   两条入口同一判定,QA 直接调 mats({query:'2026高考题'}) 也生效。
   *   命中后:先筛"头部含该年份"的子池,再做原有匹配;
   *   子池为空 → 退回普通检索(原有口径一个字不改),并在返回里如实标注
   *   year.fallback / year.pool=0,由界面决定怎么说。绝不假装命中。
   *   msg.paperFirst=true(年份主导检索)→ 年份子池内再按"试卷优先"排序
   *   (路径含 原卷/真题/全卷解析/解析/各地卷/模拟…的排前),其余口径不变。
   * ============================================================ */
  function search(pool, msg) {
    msg = msg || {};
    var q = msg.query == null ? '' : String(msg.query);
    var srcFilter = msg.src == null ? '' : String(msg.src);
    var loose = !!msg.loose;
    var paperFirst = !!msg.paperFirst;

    var tokens = q.split(TOKEN_SEP);
    var terms = [];
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i].replace(/^\s+|\s+$/g, '');
      if (t.length >= 2) terms.push(t);
    }
    var prefix = srcFilter.length > 0 ? SRC_TAG + srcFilter + '/' : '';
    var needScore = loose ? 1 : 2;

    // —— 年份意图:显式 msg.year 优先,其次由 query 自身识别 ——
    var yi = parseYearIntent(q);
    var wantYear = parseInt(msg.year, 10) || 0;
    if (!(wantYear >= 1900 && wantYear <= 2099)) wantYear = yi.hit ? yi.year : 0;

    var scanPool = pool;
    var yearInfo = null;
    if (wantYear) {
      var sets = yearSets(pool, wantYear, prefix);
      if (sets.strict.length) {
        scanPool = sets.strict;
        var pi = paperInfo(sets.strict, 3);
        yearInfo = {
          year: wantYear, pool: sets.strict.length, matched: 0, fallback: false,
          candidates: sets.candidates.length, strict: sets.strict.length,
          otherYears: sets.candidates.length - sets.strict.length,
          papers: pi.papers, names: pi.names, named: sets.strict.length,
          archiveYear: 0, from: msg.year ? 'msg' : 'query',
          range: archiveYearRange(pool, '')          // 与桌面一致:区间按整个池子统计
        };
      } else {
        // 该年份一段真原卷都没有:如实回报,检索退回普通池(下面照常跑)
        yearInfo = {
          year: wantYear, pool: 0, matched: 0, fallback: true, named: 0,
          candidates: sets.candidates.length, strict: 0,
          otherYears: sets.candidates.length,
          papers: 0, names: [],
          archiveYear: filterByYear(pool, wantYear, '').length,
          from: msg.year ? 'msg' : 'query',
          src: srcFilter,
          range: archiveYearRange(pool, '')
        };
      }
    }

    /* 年份档决定"词"怎么参与:
     *   年份主导(paperFirst):子池就是检索范围,词一律不做过滤(命中门槛 0),
     *     只用于打分排序 —— 用户要的是那一年的整卷,不能因为没有"高考"两个字就漏掉。
     *   年份限定:年份已由子池限定,把年份词从命中判定里去掉,否则
     *     「2026 函数单调性」会被"2026"这一个词满足,实词完全起不到缩小作用
     *     (实测:不去掉时命中数 = 全子池 3665 段)。剩下的实词再按原门槛筛。 */
    var scanTerms = terms, scanNeed = needScore;
    if (yearInfo) {
      if (paperFirst) {
        scanNeed = 0;
      } else {
        var rest = [];
        var ys = String(wantYear);
        for (var ti = 0; ti < terms.length; ti++) {
          if (terms[ti] === ys || terms[ti] === ys + '年') continue;
          rest.push(terms[ti]);
        }
        if (rest.length) {
          scanTerms = expandCjkTerms(rest);   // 长中文实词拆 2 字片段,免得整串 0 命中
          // 词少了,门槛也要跟着降:去掉年份后只剩 1 个词时,
          // 还要求"命中 2 个词"就永远命中不了(严格模式 needScore=2)。
          scanNeed = Math.min(needScore, scanTerms.length);
        } else { scanNeed = 0; }                // 只剩年份 → 全子池
      }
    }

    var scan = scanHits(scanPool, prefix, scanTerms, scanNeed);
    if (yearInfo) yearInfo.matched = scan.matched;
    var outHits = emitHits(scanPool, scan.idxHits, scan.scores, loose, paperFirst, wantYear);

    var res = { hits: outHits, matched: scan.matched, total: pool.length, scanned: scanPool.length };
    if (yearInfo) res.year = yearInfo;
    return res;
  }

  /* 全池扫描:命中词数 → 召回门槛 → 加权分(分母仍是原始命中词数,门槛不因权重变化) */
  function scanHits(pool, prefix, terms, needScore) {
    var idxHits = [];
    var scores = {};
    for (var bi = 0; bi < pool.length; bi++) {
      var b = pool[bi];
      if (prefix.length > 0 && b.indexOf(prefix) !== 0) continue;
      var score = 0;
      for (var k = 0; k < terms.length; k++) {
        if (b.indexOf(terms[k]) >= 0) score++;
        if (score >= 3) break;
      }
      if (score >= needScore) { idxHits.push(bi); scores[bi] = score * blockWeight(b); }
    }
    return { idxHits: idxHits, scores: scores, matched: idxHits.length };
  }

  /* 排序 + 输出(配额与相邻块合并口径全部照旧)
   * paperFirst=true 时先按"年份主导"分档(仅该年份检索用):
   *   ① 来源路径直写该年份的块(year 年)排最前;
   *   ② 再按"试卷优先"(原卷/真题/全卷解析/解析/各地卷/模拟…);
   *   档内仍是宿主原口径 —— 加权分降序 → 块体长度升序。 */
  function emitHits(pool, idxHits, scores, loose, paperFirst, year) {
    // 与宿主同一套排序(.NET introsort),见上面 dotNetSort 的说明
    sortHits(idxHits, function (a, c) {
      if (paperFirst) {
        var ya = yearNamedRank(pool[a], year), yc = yearNamedRank(pool[c], year);
        if (ya !== yc) return ya - yc;              // 年份直写(0)在前
        var pa = paperRank(pool[a]), pc = paperRank(pool[c]);
        if (pa !== pc) return pa - pc;              // 试卷(0)在前,非试卷(1)在后
      }
      var d = scores[c] - scores[a];              // 分高者前(降序)
      if (d !== 0) return d > 0 ? 1 : -1;
      return blockLen(pool[a]) - blockLen(pool[c]);  // 同分:短块在前(升序)
    });

    var maxHits = loose ? 10 : 6;
    var charCap = loose ? 14000 : 5200;
    var perCap = loose ? 2400 : 1200;
    var used = {};
    var outHits = [];
    var totalChars = 0;
    for (var hi = 0; hi < idxHits.length && outHits.length < maxHits && totalChars < charCap; hi++) {
      var idx = idxHits[hi];
      if (used[idx]) continue;
      var i0 = loose ? Math.max(0, idx - 1) : idx;
      var i1 = loose ? Math.min(pool.length - 1, idx + 1) : idx;
      var sb = '';
      var src = '';
      for (var kk = i0; kk <= i1; kk++) {
        used[kk] = true;
        var bk = pool[kk];
        var sep = bk.indexOf('\n');
        if (kk === i0) src = srcOf(bk, sep);
        var body = sep > 0 ? bk.substring(sep + 1) : bk;
        if (sb.length > 0) sb += '\n';
        if (sb.length + body.length <= perCap) sb += body;
        else sb += body.substring(0, Math.max(0, perCap - sb.length));
      }
      var hy = blockYear(pool[idx]);
      outHits.push({ src: src, text: sb, year: hy });
      totalChars += sb.length;
    }
    return outHits;
  }

  /* ============================================================
   * 读取:懒加载 + 单飞(并发只读一次),失败给可读原因
   * ============================================================ */
  function fetchText(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) {
        var e = new Error('HTTP ' + res.status + ' ' + (res.statusText || '') + ' — ' + url);
        e.http = res.status;
        throw e;
      }
      return res.text();
    });
  }

  function load() {
    if (loading) return loading;
    state.phase = 'loading';
    var t0 = now();
    loading = Promise.resolve().then(function () {
      return fetchText(CORPUS_URL);
    }).then(function (all) {
      var tFetched = now();
      state.bytes = all ? all.length : 0;
      if (all && all.charCodeAt(0) === 0xFEFF) all = all.substring(1);  // 与 .NET 一致:吃掉 BOM
      if (!all || all.length < MIN_BLOCK) {
        throw new Error('语料文件为空或过短(' + (all ? all.length : 0) + ' 字符):' + CORPUS_URL);
      }
      var base = splitBlocks(all);
      var tSplit = now();
      all = null;                                   // 丢掉 45MB 原文引用,只留块数组
      if (!base.length) {
        throw new Error('语料格式不符:未解析出任何 "' + SRC_TAG + '" 数据块(' + CORPUS_URL
          + ')。文件可能被截断、损坏,或不是桌面版的 qg_corpus.txt。');
      }
      state.base = base;
      state.where = '手机版内置语料(' + CORPUS_URL + ')';
      if (base.length < EXPECT_BLOCKS / 4) {
        state.warn = '内置语料块数偏少(仅 ' + base.length + ' 块,桌面版同期为 '
          + EXPECT_BLOCKS + ' 块),文件可能不完整';
      }
      state.ms.fetch = r1(tFetched - t0);
      state.ms.split = r1(tSplit - tFetched);
      // 科目上传区(失败不致命:基座语料仍可检索,与宿主"没有上传区"的表现一致)
      return fetchText(SUBJ_URL).then(function (subjText) {
        var tSubj = now();
        if (subjText && subjText.charCodeAt(0) === 0xFEFF) subjText = subjText.substring(1);
        var subs = loadSubjects(subjText);
        state.subjects = subs.map(function (e) { return { key: e.key, name: e.name, points: e.points }; });
        state.merged = rebuildMerged(base, subs);
        state.ms.subj = r1(now() - tSubj);
        state.ms.bytes = state.bytes;
        state.phase = 'ready';
        state.ms.total = r1(now() - t0);
        return state;
      }, function (err) {
        state.warn = '科目上传区(' + SUBJ_URL + ')读取失败:' + (err && err.message ? err.message : err)
          + ' — 仅基座语料可用';
        state.subjects = [];
        state.merged = base.slice();
        state.phase = 'ready';
        state.ms.total = r1(now() - t0);
        return state;
      });
    }).catch(function (err) {
      loading = null;                               // 允许用户重试
      state.phase = 'error';
      state.err = readable(err);
      state.ms.total = r1(now() - t0);
      throw new Error(state.err);
    });
    return loading;
  }

  function readable(err) {
    var m = err && err.message ? err.message : String(err);
    if (err && err.http) return '手机版内置语料读取失败:' + m;
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) {
      return '手机版内置语料读取失败:取不到 ' + CORPUS_URL
        + '(网络/资源不可用)。若这是 APK,请确认 www 里带了 数据库 目录。';
    }
    return '手机版内置语料不可用:' + m;
  }

  /* ============================================================
   * 对外:与宿主 kind:'mats' 响应**同形状**的检索接口
   *   宿主返回 {kind:'matsResp', ok:true, hits:[{src,text,year}], total, where}
   *   手机版返回同名字段(ok:false 时带 err),train.js 无需分环境处理。
   * ============================================================ */
  function mats(payload) {
    var t0 = now();
    return load().then(function () {
      var t1 = now();
      var r = search(state.merged, payload || {});
      var out = {
        kind: 'matsResp', ok: true, hits: r.hits, total: r.total, matched: r.matched,
        where: state.where, src: 'phone-corpus', ms: { load: r1(t1 - t0), search: r1(now() - t1) }
      };
      // 年份意图的回执必须原样透出去(子池段数/命中段数/是否退回普通检索):
      // 界面靠它如实报数,漏了它就会把"有年份素材"说成"档案里没有该年份"。
      if (r.year) out.year = r.year;
      if (r.scanned !== undefined) out.scanned = r.scanned;
      if (state.warn) out.warn = state.warn;
      return out;
    }, function (err) {
      return { kind: 'matsResp', ok: false, err: (err && err.message) || state.err || '内置语料不可用' };
    });
  }

  function stat() {
    return load().then(function () {
      return {
        ok: true, where: state.where, baseBlocks: state.base.length, mergedBlocks: state.merged.length,
        subjects: state.subjects, bytes: state.bytes, ms: state.ms, warn: state.warn, phase: state.phase
      };
    }, function (err) {
      return { ok: false, err: (err && err.message) || state.err, phase: state.phase, ms: state.ms };
    });
  }

  window.QGCorpus = {
    version: VERSION,
    corpusUrl: CORPUS_URL,
    subjectsUrl: SUBJ_URL,
    load: load,          // 预加载(可选);不调用也不会在启动时读盘
    mats: mats,          // 检索(自动触发懒加载)
    stat: stat,          // 加载状态 / 块数 / 耗时
    /* 年份意图识别(纯函数,不触发语料加载):train.js 的 realN / 提示词 / 状态栏
       与桌面宿主同一口径,两边不会各判一套。返回 {year,intent,word,hit,raw}。 */
    yearIntent: parseYearIntent,
    /* 本机档案的年份跨度(懒惰计算 + 缓存):0 段时如实告知"能查哪些年" */
    yearRange: function (prefix) {
      return archiveYearRange(state.merged || state.base || [], prefix == null ? '' : String(prefix));
    },
    state: function () {
      return {
        phase: state.phase, err: state.err, warn: state.warn, where: state.where,
        baseBlocks: state.base ? state.base.length : 0,
        mergedBlocks: state.merged ? state.merged.length : 0,
        subjects: state.subjects, bytes: state.bytes, ms: state.ms
      };
    },
    /* 内部实现:仅供一致性 QA 对拍,业务代码不要用 */
    _internals: {
      splitBlocks: splitBlocks, loadSubjects: loadSubjects, rebuildMerged: rebuildMerged,
      blockYear: blockYear, blockWeight: blockWeight, blockLen: blockLen, search: search,
      scanHits: scanHits, emitHits: emitHits,
      parseYearIntent: parseYearIntent, headOf: headOf, headHasYear: headHasYear,
      filterByYear: filterByYear, yearSets: yearSets, paperInfo: paperInfo,
      expandCjkTerms: expandCjkTerms,
      archiveYearRange: archiveYearRange, paperRank: paperRank,
      yearNamedRank: yearNamedRank, countYearNamed: countYearNamed,
      dotNetSort: dotNetSort,
      setSort: function (fn) { sortHits = fn || dotNetSort; },
      getSort: function () { return sortHits; },
      poolRef: function () { return state.merged || (state.base || []); },
      searchRef: function (msg) { return search(state.merged || [], msg); },
      constants: {
        MIN_BLOCK: MIN_BLOCK, SUBJ_CHUNK_CHARS: SUBJ_CHUNK_CHARS,
        RECENT_FROM: RECENT_FROM, RECENT_TO: RECENT_TO, W_RECENT: W_RECENT, W_NORMAL: W_NORMAL,
        INTENT_WORDS: INTENT_WORDS, PAPER_HINTS: PAPER_HINTS
      }
    }
  };
})();
