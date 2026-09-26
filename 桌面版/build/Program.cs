// ============================================================
// 穷观 V2.4.2 · 高中知识词云系统 — Windows 原生窗口宿主
// 技术:.NET Framework 4.8(Win11 出厂自带)+ WebView2 Runtime(Win11 出厂自带)
// 全部网页资源(index.html/train.html/css/js/three.js/数据)嵌入本 exe,单文件应用体
// 编译:csc.exe(Windows 自带编译器,遵守 C# 5 语法)
//
// V2.4.2 要点:
//  - 观澜接视觉模型:可附图(选图 / Ctrl+V 粘贴 / 拖入),带图请求切 deepseek-flash,
//    纯文本仍走原模型;图片在本地先缩到 ≤1300px 再传(对齐官方 48 MiB 请求体限制);
//  - 演示场景 id 自动归一化:中文 / 标点 / 超长 / 重名 / 缺 id 不再让整段演示失败,
//    引用(pt/a/b/line/…)同步改写;"不是对象"与"id 不合法"分开报错;
//  - 演示成败写入运行日志(消息 kind=note),失败原因可事后排查;
//  - 观澜拆窗不再把对话写进 URL(宿主会把新窗 URI 记进日志),改走 localStorage 握手;
//  - 高考真题按年份加权:近十年(2017-2026)×3;上传的知识云以 subj 源真正参与出题;
//  - 数据库写入改原子替换 + 失败回滚;并发集合统一加锁;联网抓取拦私网地址(SSRF);
//  - 三个页面加 CSP(meta),宿主响应头补 X-Frame-Options / nosniff;
//  - 启动方式更名:可执行文件「高中数学知识库.exe」→「穷观学习.exe」;
//    任务栏图标固化为多尺寸图标资源(../favicon.ico,/win32icon 内嵌),同时供
//    页面 /favicon.ico 使用(此前该请求 404)。
// V2.4.1 新增(观澜:AI 演示问答):
//  - 侧栏「观澜」入口 + 主窗浮动面板,对话仅内存态;
//  - 与训练窗共用同一 DeepSeek 宿主通道(消息 kind=ds)。
// 早期版本要点:
//  - 主窗右下角「破卷」按钮 → NewWindowRequested → 打开第二个原生窗口(破卷);
//  - 训练窗通过 WebMessage 请求宿主:① DeepSeek API 联网出题代理
//    (避免页面直连的 CORS/密钥暴露问题);② 本地资料语料检索
//    (数据库\qg_corpus.txt,举一反三/真题/讲义分块索引;
//     加载顺序见 EnsureCorpus:数据库文件夹 → 内嵌资源 → 无)。
//  - 主窗/训练窗同源共享 localStorage 与 BroadcastChannel,页面侧自行同步状态。
// ============================================================
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace KnowledgeNetApp
{
    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [STAThread]
        private static void Main()
        {
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
            try { SetProcessDpiAwarenessContext(new IntPtr(-2)); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }

    /* ================= 主窗 ================= */
    internal class MainForm : Form
    {
        private readonly WebView2 webView;
        private static TrainForm trainWindow;
        private static TrainForm guanlanWindow;   // 观澜无边框独立窗(与训练窗分开管理)

        public MainForm()
        {
            Text = "穷观 V2.4.2 · 高中知识词云系统";
            ClientSize = new Size(1440, 900);
            MinimumSize = new Size(980, 640);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.None;   // 无边框:自绘窗口控件(页面右上角 ─ ▢ ✕)
            try { Icon = Shared.MakeIcon(); } catch { }
            Shared.AttachRound(this);                 // 窗口圆角(最大化自动还原直角)

            webView = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(webView);
            FormClosing += delegate { Shared.Log("APP:closing"); };
            Load += MainForm_Load;

            // F11:最大化 / 还原(无边框下等同窗口最大化切换)
            KeyPreview = true;
            KeyDown += OnFormKeyDown;
        }

        private void OnFormKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.F11)
            {
                ToggleFullscreen();
                e.Handled = true;
            }
        }

        private void ToggleFullscreen()
        {
            try
            {
                WindowState = (WindowState == FormWindowState.Maximized)
                    ? FormWindowState.Normal : FormWindowState.Maximized;
                Shared.Log("FULLSCREEN:" + (WindowState == FormWindowState.Maximized));
            }
            catch (Exception ex) { Shared.Log("FS-ERR:" + ex.Message); }
        }

        private async void MainForm_Load(object sender, EventArgs e)
        {
            Shared.Log("APP:start");
            try
            {
                CoreWebView2Environment env = await Shared.EnsureEnv();
                await webView.EnsureCoreWebView2Async(env);
                CoreWebView2 cw = webView.CoreWebView2;
                Shared.AttachCommon(this, webView, cw);
                // 页面 window.open(训练页) → 宿主内开第二个原生窗口
                cw.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs ne)
                {
                    Shared.Log("NWREQ:" + ne.Uri);
                    ne.Handled = true;
                    if (!Shared.IsAppLocal(ne.Uri)) { Shared.OpenExternal(ne.Uri); return; }
                    OpenTrain(ne.Uri);
                };
                // 自动化测试通道:仅当带 --qa=… 参数时跳过开场并附加测试参数;
                // 正常启动不带参数 → 加载纯净地址,开场动画照常播放。
                string nav = "https://app.local/index.html";
                string[] cargs = Environment.GetCommandLineArgs();
                for (int i = 1; i < cargs.Length; i++)
                {
                    if (cargs[i].StartsWith("--qa="))
                    {
                        nav = "https://app.local/index.html?skip=1";
                        string qs = cargs[i].Substring(5);
                        if (qs.Length > 0) nav += "&" + qs;
                    }
                }
                cw.Navigate(nav);
            }
            catch (Exception ex)
            {
                Shared.Log("ERROR:" + ex.Message);
                MessageBox.Show(this,
                    "启动失败:" + ex.Message + "\r\n\r\n" +
                    "本程序需要 Windows 11 自带的 WebView2 运行时。\r\n" +
                    "如提示找不到,请先在「设置 → 应用 → 已安装的应用」中更新 Microsoft Edge,再重试。",
                    "穷观", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        public static void OpenTrain(string uri)
        {
            Shared.Log("OPENTRAIN:" + uri);
            bool isGuanlan = uri != null &&
                uri.IndexOf("guanlan.html", StringComparison.OrdinalIgnoreCase) >= 0;
            if (isGuanlan)
            {
                if (guanlanWindow != null && !guanlanWindow.IsDisposed)
                {
                    if (guanlanWindow.WindowState == FormWindowState.Minimized)
                        guanlanWindow.WindowState = FormWindowState.Normal;
                    guanlanWindow.Activate();
                    return;
                }
                var gw = new TrainForm(uri);
                guanlanWindow = gw;
                gw.FormClosed += delegate(object s2, FormClosedEventArgs e2) { guanlanWindow = null; };
                gw.Show();
                return;
            }
            if (trainWindow != null && !trainWindow.IsDisposed)
            {
                if (trainWindow.WindowState == FormWindowState.Minimized)
                    trainWindow.WindowState = FormWindowState.Normal;
                trainWindow.Activate();
                return;
            }
            var f = new TrainForm(uri);
            trainWindow = f;
            f.FormClosed += delegate(object s2, FormClosedEventArgs e2) { trainWindow = null; };
            f.Show();
        }
    }

    /* ================= 训练窗(第二个原生窗口) ================= */
    internal class TrainForm : Form
    {
        private readonly WebView2 webView;
        private readonly string startUri;

        public TrainForm(string uri)
        {
            startUri = string.IsNullOrEmpty(uri) ? "https://app.local/train.html" : uri;
            bool isGuanlan = startUri.IndexOf("guanlan.html", StringComparison.OrdinalIgnoreCase) >= 0;
            Text = isGuanlan ? "穷观 · 观澜(AI 演示问答)" : "穷观 · 破卷";
            FormBorderStyle = FormBorderStyle.None;   // 训练窗 / 观澜窗统一无边框,控件自绘
            if (isGuanlan)
            {
                ClientSize = new Size(1180, 820);
                MinimumSize = new Size(900, 620);
            }
            else
            {
                ClientSize = new Size(980, 780);
                MinimumSize = new Size(720, 560);
            }
            StartPosition = FormStartPosition.CenterScreen;
            try { Icon = Shared.MakeIcon(); } catch { }
            Shared.AttachRound(this);                 // 窗口圆角(最大化自动还原直角)

            webView = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(webView);
            FormClosing += delegate { Shared.Log("TRAIN:closing"); };
            Load += TrainForm_Load;
        }

        private async void TrainForm_Load(object sender, EventArgs e)
        {
            Shared.Log("TRAIN:start uri=" + startUri);
            try
            {
                CoreWebView2Environment env = await Shared.EnsureEnv();
                await webView.EnsureCoreWebView2Async(env);
                CoreWebView2 cw = webView.CoreWebView2;
                Shared.AttachCommon(this, webView, cw);
                // 无边框窗没有地址栏:外部链接交给系统浏览器,其余窗内跳转一律吞掉
                cw.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs ne)
                {
                    ne.Handled = true;
                    if (!Shared.IsAppLocal(ne.Uri)) Shared.OpenExternal(ne.Uri);
                };
                cw.Navigate(startUri);
            }
            catch (Exception ex)
            {
                Shared.Log("TRAIN-ERROR:" + ex.Message);
                MessageBox.Show(this, "训练窗启动失败:" + ex.Message, "穷观", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }

    /* ================= 公共:资源 / 日志 / 消息代理 / 语料 ================= */
    internal static class Shared
    {
        // 日志放 %LOCALAPPDATA%\穷观学习\,不放 %TEMP%:
        //  ① 临时目录会被各种清理工具整体清掉;
        //  ② 共享 Temp 下用一个固定文件名,别的东西可以抢先占位,而我们还往里写消息摘要。
        public static readonly string LogPath = BuildLogPath();

        private static string BuildLogPath()
        {
            try
            {
                string dir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "穷观学习");
                Directory.CreateDirectory(dir);
                return Path.Combine(dir, "knet_run.log");
            }
            catch
            {
                return Path.Combine(Path.GetTempPath(), "knet_run.log");   // 兜底:至少还能记
            }
        }

        private static CoreWebView2Environment env;

        // 日志上限 2 MB:超过即轮转一次(只留最近一份备份),避免长期运行无限增长
        private const long LogMaxBytes = 2 * 1024 * 1024;

        // "清除本机记录"之后不再写日志 —— 原先 wipe 删掉文件后,下一条消息立刻把它重建,
        // 等于"不留记录"的承诺是空的。另外 Log 会被 UI 线程与多个线程池线程并发调用,
        // 而 File.AppendAllText 抢占会抛 IOException 再被 catch 吞掉 → 丢日志(日志是唯一的排障手段)。
        private static volatile bool logDisabled = false;
        private static readonly object LogLock = new object();

        public static void DisableLog()
        {
            logDisabled = true;
        }

        public static void Log(string msg)
        {
            if (logDisabled) { return; }
            lock (LogLock)
            {
                try
                {
                    var fi = new FileInfo(LogPath);
                    if (fi.Exists && fi.Length > LogMaxBytes)
                    {
                        string bak = LogPath + ".1";
                        try { if (File.Exists(bak)) File.Delete(bak); File.Move(LogPath, bak); } catch { }
                    }
                    File.AppendAllText(LogPath, DateTime.Now.ToString("HH:mm:ss") + " " + msg + "\r\n");
                }
                catch { }
            }
        }

        // 异步单例要防并发("env == null" 与 await 之间会 yield,两个窗口同时启动会各建一个环境),
        // 但**绝对不能**用 ContinueWith 在线程池线程上取结果 —— CoreWebView2Environment 的 RCW 是
        // STA 线程亲和的,一旦在 MTA 线程上被触碰,WebView2 之后一路报
        //   "Unable to cast to Microsoft.Web.WebView2.Core.Raw.ICoreWebView2Environment"
        // 整个 WebView2 初始化直接打死(实测:窗口能开、页面全白、日志里没有 WEBVIEW2:ready)。
        // 所以这里只用锁保证"只创建一次",对象仍在调用方的 UI 线程上 await 出来。
        private static readonly object EnvLock = new object();
        private static Task<CoreWebView2Environment> envTask = null;

        public static Task<CoreWebView2Environment> EnsureEnv()
        {
            lock (EnvLock)
            {
                if (envTask == null) { envTask = CreateEnvOnce(); }
                return envTask;
            }
        }

        private static async Task<CoreWebView2Environment> CreateEnvOnce()
        {
            env = await CoreWebView2Environment.CreateAsync(null, null);
            Log("WEBVIEW2:ready " + env.BrowserVersionString);
            return env;
        }

        // 图标只创建一次:Icon.FromHandle 持有的 HICON 不会被 GC 回收,
        // 每次调用都新建会泄漏 GDI 句柄,故缓存为进程级单例。
        private static Icon cachedIcon = null;
        private static readonly object IconLock = new object();

        public static Icon MakeIcon()
        {
            lock (IconLock)
            {
                if (cachedIcon != null) return cachedIcon;
                cachedIcon = BuildIcon();
                return cachedIcon;
            }
        }

        private static Icon BuildIcon()
        {
            using (var bmp = new Bitmap(32, 32))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.Clear(Color.Transparent);
                    using (var br = new SolidBrush(Color.FromArgb(18, 27, 48)))
                        g.FillEllipse(br, 1, 1, 30, 30);
                    using (var br2 = new SolidBrush(Color.FromArgb(79, 195, 247)))
                        g.FillEllipse(br2, 6, 6, 20, 20);
                    using (var br3 = new SolidBrush(Color.White))
                        g.FillEllipse(br3, 12, 12, 8, 8);
                }
                return Icon.FromHandle(bmp.GetHicon());
            }
        }

        // 页面是否来自内嵌资源(https://app.local/…)
        // 必须解析成 Uri 比 Host,不能做子串匹配:https://evil.example/?x=app.local 以前也算"本地页",
        // 而它正是消息桥(读语料 / 写知识库 / 代发请求)唯一的准入判断。
        public static bool IsAppLocal(string uri)
        {
            if (string.IsNullOrEmpty(uri)) { return false; }
            try
            {
                Uri u;
                if (!Uri.TryCreate(uri, UriKind.Absolute, out u)) { return false; }
                return string.Compare(u.Host, "app.local", StringComparison.OrdinalIgnoreCase) == 0;
            }
            catch { return false; }
        }

        // 外部链接交给系统默认浏览器:无边框窗没有地址栏,在窗内打开会成为死胡同
        // (训练窗的「获取 Key ↗」就是这类链接,原先被 Handled=true 直接吞掉,点了没反应)
        public static void OpenExternal(string uri)
        {
            try
            {
                if (string.IsNullOrEmpty(uri)) return;
                if (uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                    uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                {
                    Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
                    Log("EXTLINK:" + Trunc(uri, 120));
                }
            }
            catch (Exception ex) { Log("EXTLINK-ERR:" + ex.Message); }
        }

        // 只启用 TLS 1.2 及以上(原先含 Tls11/Tls 会被降级协商,且是进程级设置,会波及 AI 调用)
        private static bool tlsReady = false;
        public static void SetTls()
        {
            if (tlsReady) return;
            try { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | (SecurityProtocolType)12288; }
            catch { try { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12; } catch { } }
            tlsReady = true;
        }

        // 公网地址校验:webq 抓取的是必应返回的任意 URL,必须拦住内网/本机地址(SSRF)
        private static bool IsPublicHttpUrl(string url)
        {
            try
            {
                var u = new Uri(url);
                if (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps) return false;
                string host = u.Host.ToLowerInvariant();
                if (host.Length == 0) return false;
                if (host == "localhost" || host.EndsWith(".localhost")) return false;
                if (host.EndsWith(".local") || host.EndsWith(".internal") || host.EndsWith(".lan")) return false;
                System.Net.IPAddress ip;
                if (System.Net.IPAddress.TryParse(host, out ip))
                {
                    if (ip.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork) return false;
                    byte[] b = ip.GetAddressBytes();
                    if (b[0] == 0 || b[0] == 10 || b[0] == 127) return false;
                    if (b[0] == 172 && b[1] >= 16 && b[1] <= 31) return false;
                    if (b[0] == 192 && b[1] == 168) return false;
                    if (b[0] == 169 && b[1] == 254) return false;
                    if (b[0] >= 224) return false;                 // 组播/保留
                }
                return true;
            }
            catch { return false; }
        }

        /* ---------- 无边框窗口圆角(Region 裁剪;最大化时恢复直角) ---------- */
        public static Region RoundRegion(int w, int h, int r)
        {
            if (r <= 0 || r * 2 >= w || r * 2 >= h) return new Region(new Rectangle(0, 0, w, h));
            var p = new GraphicsPath();
            int d = r * 2;
            p.AddArc(w - d, 0, d, d, 270, 90);   // 右上
            p.AddArc(w - d, h - d, d, d, 0, 90); // 右下
            p.AddArc(0, h - d, d, d, 90, 90);    // 左下
            p.AddArc(0, 0, d, d, 180, 90);       // 左上
            p.CloseFigure();
            var reg = new Region(p);
            p.Dispose();
            return reg;
        }

        public static void AttachRound(Form f)
        {
            if (f == null) return;
            Action<Form> apply = null;
            apply = delegate(Form x)
            {
                try
                {
                    if (x.WindowState == FormWindowState.Maximized || x.WindowState == FormWindowState.Minimized)
                    {
                        // 最大化/最小化时保持直角,避免屏幕边缘缺角。
                        // Region 必须显式 Dispose(WinForms 不接管它的生命周期):直接置 null 会让
                        // 每次最大化/还原都漏一个 GDI Region,反复切换会稳定累积。
                        Region oldReg = x.Region;
                        x.Region = null;
                        if (oldReg != null) oldReg.Dispose();
                        return;
                    }
                    var rc = x.ClientRectangle;
                    if (rc.Width < 10 || rc.Height < 10) return;
                    // 圆角随 DPI:页面侧是 CSS 像素(11px),宿主按设备像素裁剪,
                    // 125%/150% 缩放下固定 12 会把弧线切掉一截。
                    int dpi;
                    try { dpi = x.DeviceDpi; } catch { dpi = 96; }
                    if (dpi <= 0) dpi = 96;
                    int r = (int)Math.Round(12.0 * dpi / 96.0);
                    if (r < 1) r = 1;
                    var reg = RoundRegion(rc.Width, rc.Height, r);
                    if (x.Region != null) { var old = x.Region; x.Region = reg; if (old != null) old.Dispose(); }
                    else x.Region = reg;
                }
                catch { /* 圆角失败不影响运行 */ }
            };
            f.Resize += delegate(object s, EventArgs e2) { apply(f); };
            f.Load += delegate(object s, EventArgs e2) { apply(f); };
        }

        // cw → 所属 Form(无边框观澜窗等需要宿主代为移动/最小化/关闭)
        // 两个必须守住的点:① 窗口关闭时要摘掉引用,否则被关掉的 Form + CoreWebView2(连着整棵
        // 控件树)会被这张静态字典永久强引用;② 写入发生在 UI 线程,读取来自线程池(HandleWnd 的
        // Task.Run),而 Dictionary 不支持并发读写 —— 统一走下面三个加锁的小函数。
        private static readonly object CwMapLock = new object();
        private static readonly Dictionary<CoreWebView2, Form> CwOwnerMap =
            new Dictionary<CoreWebView2, Form>();

        private static void CwOwnerSet(CoreWebView2 cw, Form f)
        {
            try { lock (CwMapLock) { CwOwnerMap[cw] = f; } } catch { }
        }

        private static Form CwOwnerGet(CoreWebView2 cw)
        {
            try { lock (CwMapLock) { Form f; return CwOwnerMap.TryGetValue(cw, out f) ? f : null; } }
            catch { return null; }
        }

        private static void CwOwnerDrop(CoreWebView2 cw)
        {
            try { lock (CwMapLock) { CwOwnerMap.Remove(cw); } } catch { }
        }

        public static void AttachCommon(Form owner, WebView2 wv, CoreWebView2 cw)
        {
            CwOwnerSet(cw, owner);
            if (owner != null)
            {
                // 窗口关掉就摘掉引用:否则 Form + CoreWebView2 永远不会被回收
                owner.FormClosed += delegate { CwOwnerDrop(cw); };
            }
            cw.Settings.AreDefaultContextMenusEnabled = true;
            cw.Settings.IsStatusBarEnabled = false;
            cw.Settings.AreDevToolsEnabled = false;
            cw.AddWebResourceRequestedFilter("https://app.local/*", CoreWebView2WebResourceContext.All);
            cw.WebResourceRequested += OnWebResourceRequested;
            cw.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs e2)
            {
                Log("NAV:ok=" + e2.IsSuccess + " code=" + e2.WebErrorStatus);
            };
            cw.DocumentTitleChanged += delegate { Log("TITLE:" + cw.DocumentTitle); };
            // 消息桥必须先校验来源:chrome.webview 的桥是"按控件"注入的,任何被加载进这个 WebView2
            // 的文档(哪怕远端页面)都能 postMessage。而协议里有 mats(读走本机 47MB 语料)、
            // dbAdd(往用户知识库写任意内容)、webq(借用户 IP 发请求)—— 不校验来源等于全开放。
            cw.WebMessageReceived += delegate(object s, CoreWebView2WebMessageReceivedEventArgs e2)
            {
                if (!Shared.IsAppLocal(e2.Source))
                {
                    Log("MSG-DROP:" + (e2.Source == null ? "(null)" : e2.Source));
                    return;
                }
                Log("MSG:" + SanitizeMsg(e2.WebMessageAsJson));
                HandleWebMessage(wv, cw, e2.WebMessageAsJson);
            };
            // 非本地页不许在主框架里打开:一来外部链接在无边框窗里是死胡同(交给系统浏览器),
            // 二来这也让"消息桥只挂在本地页"这条前提真正成立。只拦 http/https,
            // about:/blob:/data: 这类内部导航照旧放行(页面预览会用到)。
            cw.NavigationStarting += delegate(object s, CoreWebView2NavigationStartingEventArgs e2)
            {
                try
                {
                    string u = e2.Uri == null ? "" : e2.Uri;
                    bool httpish = u.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
                                || u.StartsWith("https://", StringComparison.OrdinalIgnoreCase);
                    if (httpish && !Shared.IsAppLocal(u))
                    {
                        e2.Cancel = true;
                        Shared.OpenExternal(u);
                    }
                }
                catch { }
            };
        }

        // 无边框窗口控制(观澜):op=move/min/close
        private static string HandleWnd(CoreWebView2 cw, Dictionary<string, object> msg)
        {
            try
            {
                Form f = CwOwnerGet(cw);
                string op = msg.ContainsKey("op") ? Convert.ToString(msg["op"]) : "";
                if (f == null) return Json(new { kind = "wndResp", ok = false, err = "无宿主窗口" });
                if (op == "move")
                {
                    int dx = msg.ContainsKey("dx") ? SafeInt(msg["dx"], 0) : 0;
                    int dy = msg.ContainsKey("dy") ? SafeInt(msg["dy"], 0) : 0;
                    f.Invoke((MethodInvoker)delegate
                    {
                        var loc = f.Location;
                        var np = new Point(loc.X + dx, loc.Y + dy);
                        // 无边框窗没有标题栏/系统菜单可抓,拖出屏幕就再也拿不回来
                        // —— 至少保证 120×40 留在工作区内。
                        try
                        {
                            // 用整个虚拟桌面判断"至少留多少可见"。原先用 Screen.FromHandle 取**当前所在
                            // 那块屏**的工作区做硬钳制,而它永远返回同一块屏 → 窗口永远拖不到第二台显示器
                            // (显示器摆在主屏上方、Top 为负时同理)。虚拟桌面是所有屏的并集,不会自锁。
                            Rectangle vs = SystemInformation.VirtualScreen;
                            const int keepX = 120, keepY = 40;
                            if (np.X < vs.Left - f.Width + keepX) np.X = vs.Left - f.Width + keepX;
                            if (np.X > vs.Right - keepX) np.X = vs.Right - keepX;
                            if (np.Y < vs.Top) np.Y = vs.Top;
                            if (np.Y > vs.Bottom - keepY) np.Y = vs.Bottom - keepY;
                        }
                        catch { }
                        f.Location = np;
                    });
                }
                else if (op == "min")
                {
                    f.Invoke((MethodInvoker)delegate { f.WindowState = FormWindowState.Minimized; });
                }
                else if (op == "max")
                {
                    f.Invoke((MethodInvoker)delegate
                    {
                        f.WindowState = (f.WindowState == FormWindowState.Maximized)
                            ? FormWindowState.Normal : FormWindowState.Maximized;
                    });
                }
                else if (op == "close")
                {
                    f.Invoke((MethodInvoker)delegate { f.Close(); });
                }
                return Json(new { kind = "wndResp", ok = true });
            }
            catch (Exception ex)
            {
                return Json(new { kind = "wndResp", ok = false, err = ex.Message });
            }
        }

        private static void OnWebResourceRequested(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            try
            {
                string uri = e.Request.Uri;
                const string marker = "app.local/";
                int idx = uri.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
                string path = idx >= 0 ? uri.Substring(idx + marker.Length) : "index.html";
                int q = path.IndexOf('?');
                if (q >= 0) path = path.Substring(0, q);
                if (path.Length == 0 || path.EndsWith("/")) path = path + "index.html";

                string resName = "web." + path.Replace('/', '.').Replace('\\', '.');
                Assembly asm = Assembly.GetExecutingAssembly();
                Stream st = asm.GetManifestResourceStream(resName);
                if (st == null)
                {
                    Log("404:" + resName);
                    e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "Content-Type: text/plain");
                    return;
                }
                e.Response = env.CreateWebResourceResponse(st, 200, "OK",
                    "Content-Type: " + ContentTypeOf(path) + "\r\n" +
                    "Access-Control-Allow-Origin: *\r\n" +
                    // 页面 CSP 用 meta 下发;meta 形式下 frame-ancestors 会被规范忽略,
                    // 所以防嵌套只能靠响应头。
                    "X-Frame-Options: DENY\r\n" +
                    "X-Content-Type-Options: nosniff\r\n" +
                    "Cache-Control: no-store\r\n");
            }
            catch (Exception ex2)
            {
                Log("RES-ERR:" + ex2.Message);
                e.Response = env.CreateWebResourceResponse(null, 500, "Server Error", "Content-Type: text/plain");
            }
        }

        private static string ContentTypeOf(string path)
        {
            string ext = Path.GetExtension(path).ToLowerInvariant();
            switch (ext)
            {
                case ".html": return "text/html; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".js": return "application/javascript; charset=utf-8";
                case ".json": return "application/json; charset=utf-8";
                case ".png": return "image/png";
                case ".ico": return "image/x-icon";
                case ".svg": return "image/svg+xml";
                default: return "application/octet-stream";
            }
        }

        /* ---------- 页面 → 宿主 消息 ---------- */

        private static void HandleWebMessage(WebView2 wv, CoreWebView2 cw, string json)
        {
            try
            {
                // MaxJsonLength 默认只有 2,097,152 字符,超长会直接抛异常 —— 而 dbAdd 是整包上传
                // (英语 3053 点、每点 content ≤2500 字符,折算 JSON 约 85 万字符,余量只剩 2.4 倍)。
                // 一旦踩线,页面看到的是"莫名其妙的超时",而不是任何有用信息。
                var ser = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
                var msg = ser.Deserialize<Dictionary<string, object>>(json);
                string kind = msg != null && msg.ContainsKey("kind") ? Convert.ToString(msg["kind"]) : "";
                object seq = null;
                if (msg != null && msg.ContainsKey("_seq")) seq = msg["_seq"];
                if (kind == "ds")
                    PostAsync(wv, cw, Task.Run(() => HandleDs(msg)), seq);
                else if (kind == "mats")
                    PostAsync(wv, cw, Task.Run(() => HandleMats(msg)), seq);
                else if (kind == "dbAdd")
                    PostAsync(wv, cw, Task.Run(() => HandleDbAdd(msg)), seq);
                else if (kind == "dbStat")
                    PostAsync(wv, cw, Task.Run(() => HandleDbStat(msg)), seq);
                else if (kind == "wipe")
                    PostAsync(wv, cw, Task.Run(() => HandleWipe(msg)), seq);
                else if (kind == "webq")
                    PostAsync(wv, cw, Task.Run(() => HandleWebQ(msg)), seq);
                else if (kind == "wnd")
                    PostAsync(wv, cw, Task.Run(() => HandleWnd(cw, msg)), seq);
                else if (kind == "note")
                {
                    // 页面把"演示生成成败"这类诊断信息送进来落日志 ——
                    // 这些结果原先只显示在界面气泡里,不看屏幕就无从排查。
                    string nt = msg.ContainsKey("text") ? Convert.ToString(msg["text"]) : "";
                    Log("NOTE:" + Trunc(nt.Replace("\r", " ").Replace("\n", " "), 240));
                    PostJson(wv, cw, WithSeq(Json(new { kind = "noteResp", ok = true }), seq));
                }
                else if (kind == "ping")
                    PostJson(wv, cw, WithSeq(Json(new { kind = "pong", ts = DateTime.Now.Ticks }), seq));
            }
            catch (Exception ex)
            {
                Log("MSG-ERR:" + ex.Message);
                // 兜底回包必须把 _seq 带回去:页面完全靠 _seq 配对(train.js 超时 180s、mainbridge 60s),
                // 丢了它就永远等不到回应 —— 表现成"卡住 → 超时 → 无限重试",且毫无可诊断信息。
                // JSON 已经坏了,只能从原始串里宽容地把 _seq / kind 抠出来。
                string kind2 = ExtractKind(json);
                PostJson(wv, cw, WithSeq(Json(new
                {
                    kind = (string.IsNullOrEmpty(kind2) ? "ds" : kind2) + "Resp",
                    ok = false,
                    err = "宿主消息解析失败:" + ex.Message
                }), ExtractSeq(json)));
            }
        }

        // 从"已经坏掉的"JSON 里宽容地抠出 _seq / kind —— 解析失败时唯一的补救手段
        private static readonly Regex SeqRe = new Regex("\"_seq\"\\s*:\\s*(-?\\d+)", RegexOptions.Compiled);
        private static readonly Regex KindRe = new Regex("\"kind\"\\s*:\\s*\"([A-Za-z]+)\"", RegexOptions.Compiled);

        private static object ExtractSeq(string json)
        {
            try
            {
                if (string.IsNullOrEmpty(json)) { return null; }
                Match m = SeqRe.Match(json);
                int n;
                if (m.Success && int.TryParse(m.Groups[1].Value, out n)) { return n; }
                return null;
            }
            catch { return null; }
        }

        private static string ExtractKind(string json)
        {
            try
            {
                if (string.IsNullOrEmpty(json)) { return ""; }
                Match m = KindRe.Match(json);
                return m.Success ? m.Groups[1].Value : "";
            }
            catch { return ""; }
        }

        // 页面用 _seq 配对请求/响应,宿主回包必须原样回带
        private static string WithSeq(string responseJson, object seq)
        {
            if (seq == null) return responseJson;
            int i = responseJson.LastIndexOf('}');
            if (i <= 0) return responseJson;
            return responseJson.Substring(0, i) + ",\"_seq\":" + seq + responseJson.Substring(i);
        }

        private static async void PostAsync(WebView2 wv, CoreWebView2 cw, Task<string> t, object seq)
        {
            string outJson;
            try
            {
                outJson = await t;
            }
            catch (Exception ex)
            {
                outJson = Json(new { kind = "dsResp", ok = false, err = ex.Message });
            }
            PostJson(wv, cw, WithSeq(outJson, seq));
        }

        private static void PostJson(WebView2 wv, CoreWebView2 cw, string json)
        {
            try
            {
                if (wv.IsHandleCreated)
                    wv.Invoke((MethodInvoker)delegate { cw.PostWebMessageAsJson(json); });
                else
                    cw.PostWebMessageAsJson(json);
            }
            catch (Exception ex) { Log("POST-ERR:" + ex.Message); }
        }

        private static string Json(object o)
        {
            return new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Serialize(o);
        }

        private static Dictionary<string, object> Obj(object o)
        {
            var d = o as Dictionary<string, object>;
            return d ?? new Dictionary<string, object>();
        }

        // JavaScriptSerializer 把 JSON 数组解成 ArrayList,统一转 object[]
        private static object[] AsArr(object o)
        {
            if (o == null) return null;
            var a = o as object[];
            if (a != null) return a;
            var al = o as System.Collections.ArrayList;
            if (al != null) return al.ToArray();
            return null;
        }

        /* ---------- DeepSeek 出题代理 ---------- */

        private static string HandleDs(Dictionary<string, object> msg)
        {
            string key = msg.ContainsKey("key") ? Convert.ToString(msg["key"]) : "";
            if (string.IsNullOrWhiteSpace(key))
                return Json(new { kind = "dsResp", ok = false, err = "NO_KEY" });

            string model = msg.ContainsKey("model") ? Convert.ToString(msg["model"]) : "deepseek-flash";
            string thinkingType = model == "deepseek-reasoner" ? "enabled" : "disabled";
            if (string.IsNullOrWhiteSpace(model) || model == "deepseek-chat" || model == "deepseek-reasoner" || model == "deepseek-v4-flash") model = "deepseek-flash";
            if (msg.ContainsKey("thinking"))
            {
                var thinking = Obj(msg["thinking"]);
                if (thinking.ContainsKey("type") && Convert.ToString(thinking["type"]) == "enabled") thinkingType = "enabled";
            }
            int maxTokens = msg.ContainsKey("max_tokens") ? SafeInt(msg["max_tokens"], 2400) : 2400;
            double temperature = msg.ContainsKey("temperature") ? SafeDbl(msg["temperature"], 0.6) : 0.6;
            // JSON 模式按需开启:仅当页面显式要求(破卷/演示协议等输出结构化 JSON 的提示词)
            // 才附加 response_format=json_object,普通聊天不附加 —— 避免 DeepSeek
            // 对"提示词不含 json 字样"的请求返回 400。
            bool wantJson = msg.ContainsKey("json") && Convert.ToBoolean(msg["json"]);

            var body = new Dictionary<string, object>();
            body["model"] = model;
            body["thinking"] = new { type = thinkingType };
            body["max_tokens"] = maxTokens;
            body["temperature"] = temperature;
            body["stream"] = false;
            if (wantJson)
            {
                var rf = new Dictionary<string, object>();
                rf["type"] = "json_object";
                body["response_format"] = rf;
            }
            var msgs = new List<object>();
            var arr = AsArr(msg.ContainsKey("messages") ? msg["messages"] : null);
            if (arr != null)
            {
                foreach (var it in arr)
                {
                    var d = Obj(it);
                    if (d.ContainsKey("role") && d.ContainsKey("content"))
                    {
                        var m2 = new Dictionary<string, object>();
                        m2["role"] = d["role"];
                        m2["content"] = d["content"];
                        msgs.Add(m2);
                    }
                }
            }
            body["messages"] = msgs.ToArray();

            Log("DS:req model=" + model + " msgs=" + msgs.Count + " max_tokens=" + maxTokens + " json=" + wantJson);
            string payload = new JavaScriptSerializer().Serialize(body);
            string respContent = "";
            string err = "";
            int httpCode = 0;
            try
            {
                Shared.SetTls();
                var req = (HttpWebRequest)WebRequest.Create("https://api.deepseek.com/chat/completions");
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Accept = "application/json";
                req.UserAgent = "qiongguan/2.4.2";
                req.Timeout = 150000;
                req.ReadWriteTimeout = 150000;
                req.Headers["Authorization"] = "Bearer " + key;
                byte[] pb = Encoding.UTF8.GetBytes(payload);
                req.ContentLength = pb.Length;
                using (var st = req.GetRequestStream()) st.Write(pb, 0, pb.Length);
                HttpWebResponse resp = null;
                try
                {
                    resp = (HttpWebResponse)req.GetResponse();
                }
                catch (WebException wex)
                {
                    if (wex.Response != null)
                    {
                        using (var es = wex.Response.GetResponseStream())
                        {
                            if (es != null)
                                using (var rd = new StreamReader(es, Encoding.UTF8))
                                    err = rd.ReadToEnd();
                        }
                        httpCode = (int)((HttpWebResponse)wex.Response).StatusCode;
                    }
                    else err = wex.Message;
                }
                if (resp != null)
                {
                    httpCode = (int)resp.StatusCode;
                    using (var rd = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                        respContent = rd.ReadToEnd();
                    resp.Close();
                }
            }
            catch (Exception ex)
            {
                err = ex.Message;
            }

            if (httpCode >= 200 && httpCode < 300 && respContent.Length > 0)
            {
                try
                {
                    var ser = new JavaScriptSerializer();
                    var obj = ser.Deserialize<Dictionary<string, object>>(respContent);
                    string content = "";
                    string finishReason = "";
                    var choices = obj != null && obj.ContainsKey("choices") ? AsArr(obj["choices"]) : null;
                    if (choices != null && choices.Length > 0)
                    {
                        var c0 = Obj(choices[0]);
                        if (c0.ContainsKey("finish_reason")) finishReason = Convert.ToString(c0["finish_reason"]);
                        var m0 = Obj(c0.ContainsKey("message") ? c0["message"] : null);
                        if (m0.ContainsKey("content")) content = Convert.ToString(m0["content"]);
                    }
                    // finish_reason 一定要记进日志:页面把 finish_reason='length' 当成"整批作废、不重试",
                    // 而日志里原本只有 contentChars —— 排查时看不出"这次是被输出上限截断的"(实测踩过:
                    // 四道解答题写满分步解答正好撞上 8000 token 上限,回包 11972 字)。
                    Log("DS:ok http=" + httpCode + " contentChars=" + content.Length + " finish=" + (finishReason == "" ? "(none)" : finishReason));
                    return Json(new { kind = "dsResp", ok = true, content = content, finish_reason = finishReason });
                }
                catch (Exception ex)
                {
                    return Json(new { kind = "dsResp", ok = false, err = "AI 返回解析失败:" + ex.Message });
                }
            }
            Log("DS:fail http=" + httpCode + " err=" + Trunc(err, 300));
            return Json(new { kind = "dsResp", ok = false, err = Trunc(err, 500), http = httpCode });
        }

        /* ---------- 本机资料库(只读基座 + 科目自动上传区) ---------- */

        private static readonly object CorpusLock = new object();
        private static string[] baseBlocks = null;   // 四份内置资料分块
        private static readonly List<SubjEntry> subjEntries = new List<SubjEntry>();
        private static string[] mergedBlocks = null;  // base + 当前各科目云数据
        private static string baseWhere = "";
        private static string dbDirPath = "";

        private class SubjEntry
        {
            public string key = "";      // math / chem / physics …
            public string name = "";     // 高中数学 …
            public string hash = "";
            public int points = 0;
            public string text = "";     // 序列化区段(供持久化)
        }

        private static string DbDir()
        {
            if (dbDirPath.Length > 0) return dbDirPath;
            try
            {
                dbDirPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "数据库");
                Directory.CreateDirectory(dbDirPath);
            }
            catch { dbDirPath = ""; }
            return dbDirPath;
        }

        private static string SubjectsFile()
        {
            string d = DbDir();
            return d.Length > 0 ? Path.Combine(d, "qg_subjects.txt") : "";
        }

        // 装载:1) 内置基座(磁盘数据库 → 内嵌资源 → 开发目录) 2) 科目自动上传区
        private static void EnsureCorpus()
        {
            if (baseBlocks != null) return;
            lock (CorpusLock)
            {
                if (baseBlocks != null) return;
                string all = null;
                baseWhere = "未找到本地语料";
                string file = Path.Combine(DbDir(), "qg_corpus.txt");
                if (File.Exists(file))
                {
                    try { all = File.ReadAllText(file, Encoding.UTF8); baseWhere = "本机数据库文件夹"; }
                    catch { all = null; }
                }
                if (all == null)
                {
                    // 内嵌资源兜底(web.corpus.txt):exe 单文件也能检索
                    try
                    {
                        using (var st = Assembly.GetExecutingAssembly().GetManifestResourceStream("web.corpus.txt"))
                        {
                            if (st != null)
                                using (var rd = new StreamReader(st, Encoding.UTF8))
                                    all = rd.ReadToEnd();
                        }
                        if (all != null) baseWhere = "软件内嵌资料库";
                    }
                    catch { all = null; }
                }
                baseBlocks = SplitBlocks(all);
                Log("CORPUS:loaded " + baseBlocks.Length + " blocks where=" + baseWhere);
                LoadSubjects();
                RebuildMerged();
            }
        }

        private static string[] SplitBlocks(string all)
        {
            if (all == null || all.Length < 40) return new string[0];
            string[] parts = all.Split(new string[] { "\n###SRC:" }, StringSplitOptions.RemoveEmptyEntries);
            var list = new List<string>(parts.Length);
            foreach (var p in parts)
            {
                string s = p.StartsWith("###SRC:") ? p : "###SRC:" + p;
                if (s.Length > 40) list.Add(s);
            }
            return list.ToArray();
        }

        private static void LoadSubjects()
        {
            subjEntries.Clear();
            string f = SubjectsFile();
            if (f.Length == 0 || !File.Exists(f)) return;
            try
            {
                string[] lines = File.ReadAllLines(f, Encoding.UTF8);
                for (int i = 0; i < lines.Length; i++)
                {
                    if (!lines[i].StartsWith("###SUBJ:")) continue;
                    string[] h = lines[i].Substring(8).Split('|');
                    if (h.Length < 4) continue;
                    var e = new SubjEntry();
                    e.key = h[0];
                    e.hash = h[1];
                    e.points = SafeInt(h[2], 0);
                    e.name = h[3];
                    var sb = new StringBuilder();
                    i++;
                    while (i < lines.Length && !lines[i].StartsWith("###SUBJ:"))
                    {
                        sb.AppendLine(lines[i]);
                        i++;
                    }
                    i--;
                    e.text = sb.ToString();
                    subjEntries.Add(e);
                }
                Log("SUBJ:loaded " + subjEntries.Count);
            }
            catch (Exception ex) { Log("SUBJ-LOAD-ERR:" + ex.Message); }
        }

        // 原子写入 + 保留一份备份;返回是否真的落盘 —— 调用方据此回真实结果,
        // 不再出现"界面说已上传、磁盘上什么都没写"的静默丢数据。
        private static bool PersistSubjects()
        {
            string f = SubjectsFile();
            if (f.Length == 0) { Log("SUBJ-SAVE-SKIP:数据库目录不可写"); return false; }
            try
            {
                var sb = new StringBuilder();
                foreach (var e in subjEntries)
                {
                    sb.Append("###SUBJ:").Append(e.key).Append('|').Append(e.hash).Append('|')
                      .Append(e.points).Append('|').Append(e.name).AppendLine();
                    sb.Append(e.text);
                }
                string tmp = f + ".tmp";
                File.WriteAllText(tmp, sb.ToString(), Encoding.UTF8);
                if (File.Exists(f))
                {
                    string bak = f + ".bak";
                    try
                    {
                        if (File.Exists(bak)) File.Delete(bak);
                        File.Replace(tmp, f, bak);
                    }
                    catch
                    {
                        // File.Replace 失败(被占用/杀软/权限/磁盘)时的兜底:先把当前文件复制成备份再替换。
                        // 原先这里先 Delete 再 Move —— 一旦 Move 也失败,就是"旧文件已删、新文件未就位",
                        // 而上面刚把旧 .bak 删过 → 数据与备份同时消失(用户此时关掉程序就全丢了)。
                        string bak2 = f + ".bak";
                        try { if (File.Exists(f)) File.Copy(f, bak2, true); } catch { }
                        File.Delete(f); File.Move(tmp, f);
                    }
                }
                else File.Move(tmp, f);
                return true;
            }
            catch (Exception ex) { Log("SUBJ-SAVE-ERR:" + ex.Message); return false; }
        }

        // 上传区按 ~560 字切块(与 build_corpus 一致)。
        // 原先每个科目合成一个巨块,而检索输出上限只有 1200/2400 字,
        // 导致首块之后的内容永远取不到 —— 知识点多了就等于没上传。
        private const int SubjChunkChars = 560;

        private static void RebuildMerged()
        {
            var list = new List<string>();
            if (baseBlocks != null) list.AddRange(baseBlocks);
            foreach (var e in subjEntries)
            {
                string[] lines = e.text.Replace("\r\n", "\n").Split('\n');
                var buf = new StringBuilder();
                int part = 0;
                for (int i = 0; i < lines.Length; i++)
                {
                    string ln = lines[i];
                    if (buf.Length > 0 && buf.Length + ln.Length + 1 > SubjChunkChars)
                    {
                        part++;
                        list.Add("###SRC:subj/" + e.key + "/" + part + " 自动上传(" + e.points + "点)\n" + buf.ToString());
                        buf.Length = 0;
                    }
                    if (buf.Length > 0) buf.Append('\n');
                    buf.Append(ln);
                }
                if (buf.Length > 0)
                {
                    part++;
                    list.Add("###SRC:subj/" + e.key + "/" + part + " 自动上传(" + e.points + "点)\n" + buf.ToString());
                }
            }
            mergedBlocks = list.ToArray();
        }

        private static string SubjectText(SubjEntry e)
        {
            return "###SRC:subj/" + e.key + "/" + e.points + "点\n" + e.text;
        }

        // 主窗「自动上传」:当前科目知识云数据注册进本机资料库(哈希变化才重写)。
        // 并发说明:每个消息都在线程池执行,而主窗 load 后 700ms 发 dbStat、1000ms 发 dbAdd,
        //   两个处理会并行;subjEntries / mergedBlocks 的读写必须统一走 CorpusLock,
        //   否则 HandleDbStat 的 foreach 会撞上本方法的 Add/赋值 → "Collection was modified"。
        //   CorpusLock 用的是 Monitor,同线程可重入,所以内部再调 EnsureCorpus() 不会死锁。
        private static string HandleDbAdd(Dictionary<string, object> msg)
        {
            lock (CorpusLock)
            {
                try
                {
                    EnsureCorpus();
                    string key = msg.ContainsKey("subjectKey") ? Convert.ToString(msg["subjectKey"]) : "";
                    string name = msg.ContainsKey("subjectName") ? Convert.ToString(msg["subjectName"]) : "";
                    string hash = msg.ContainsKey("hash") ? Convert.ToString(msg["hash"]) : "";
                    var pts = AsArr(msg.ContainsKey("points") ? msg["points"] : null);
                    Log("DBADD:in key=" + key + " pts=" + (pts == null ? -1 : pts.Length) + " hash=" + Trunc(hash, 12));
                    if (key.Length == 0 || pts == null || pts.Length == 0)
                        return Json(new { kind = "dbAddResp", ok = false, err = "参数缺失" });

                    // 相同哈希 = 无需更新
                    for (int i = 0; i < subjEntries.Count; i++)
                    {
                        if (subjEntries[i].key == key && subjEntries[i].hash == hash)
                            return Json(new { kind = "dbAddResp", ok = true, updated = false, points = subjEntries[i].points, where = baseWhere });
                    }

                    var sb = new StringBuilder();
                    int cnt = 0;
                    foreach (var it in pts)
                    {
                        var d = it as Dictionary<string, object>;
                        if (d == null) continue;
                        string pname = d.ContainsKey("name") ? Convert.ToString(d["name"]) : "";
                        string board = d.ContainsKey("board") ? Convert.ToString(d["board"]) : "";
                        string content = d.ContainsKey("content") ? Convert.ToString(d["content"]) : "";
                        string kws = d.ContainsKey("keywords") ? Convert.ToString(d["keywords"]) : "";
                        if (pname.Length == 0) continue;
                        string head = "知识点:" + pname + " | 板块:" + board + (kws.Length > 0 ? " | 关键词:" + kws : "");
                        sb.Append(head).Append('\n');
                        if (content.Length > 2600) content = content.Substring(0, 2600);
                        sb.Append(content).Append('\n');
                        cnt++;
                    }
                    if (cnt == 0)
                        return Json(new { kind = "dbAddResp", ok = false, err = "无知识点内容" });

                    // 先落盘再改内存:落盘失败就直接报错,绝不假报成功(否则下次启动数据全丢且无从察觉)
                    var ne = new SubjEntry();
                    ne.key = key; ne.name = name; ne.hash = hash; ne.points = cnt;
                    ne.text = sb.ToString();
                    int replacedAt = -1;
                    for (int i = 0; i < subjEntries.Count; i++)
                    {
                        if (subjEntries[i].key == key) { replacedAt = i; break; }
                    }
                    SubjEntry old = replacedAt >= 0 ? subjEntries[replacedAt] : null;
                    if (replacedAt >= 0) subjEntries[replacedAt] = ne; else subjEntries.Add(ne);
                    if (!PersistSubjects())
                    {
                        // 回滚内存,保持与磁盘一致
                        if (replacedAt >= 0) subjEntries[replacedAt] = old; else subjEntries.Remove(ne);
                        Log("DBADD:persist-failed key=" + key);
                        return Json(new { kind = "dbAddResp", ok = false, err = "本机资料库写入失败:数据库目录不可写?" });
                    }
                    RebuildMerged();
                    Log("DBADD:key=" + key + " name=" + name + " points=" + cnt + " hash=" + Trunc(hash, 16) + " total=" + mergedBlocks.Length);
                    return Json(new { kind = "dbAddResp", ok = true, updated = true, points = cnt, where = baseWhere });
                }
                catch (Exception ex)
                {
                    return Json(new { kind = "dbAddResp", ok = false, err = ex.Message });
                }
            }
        }

        // 资料库统计(侧边栏展示用)。枚举 subjEntries 必须在锁内,否则会与 HandleDbAdd 并发冲突。
        private static string HandleDbStat(Dictionary<string, object> msg)
        {
            lock (CorpusLock)
            {
                try
                {
                    EnsureCorpus();
                    var subs = new List<object>();
                    foreach (var e in subjEntries)
                    {
                        var d = new Dictionary<string, object>();
                        d["key"] = e.key;
                        d["name"] = e.name;
                        d["points"] = e.points;
                        d["hash"] = e.hash;
                        subs.Add(d);
                    }
                    return Json(new { kind = "dbStatResp", ok = true,
                        where = baseWhere, baseBlocks = baseBlocks.Length,
                        subjects = subs.ToArray() });
                }
                catch (Exception ex)
                {
                    return Json(new { kind = "dbStatResp", ok = false, err = ex.Message });
                }
            }
        }

        // 「一键清除」:删除本机运行日志。承诺是"不留记录",所以删除动作放在最后,
        // 删完不再写任何日志(原实现删完立刻 Log("WIPE:…"),等于又把日志建了回来),
        // 并回真实结果而不是无脑 ok=true。
        private static string HandleWipe(Dictionary<string, object> msg)
        {
            try
            {
                bool hadKey = msg != null && msg.ContainsKey("hadKey") && Convert.ToBoolean(msg["hadKey"]);
                bool ok = true;
                string err = "";
                try { if (File.Exists(LogPath)) File.Delete(LogPath); }
                catch (Exception ex1) { ok = false; err = "日志删除失败:" + ex1.Message; }
                try { string bak = LogPath + ".1"; if (File.Exists(bak)) File.Delete(bak); } catch { }
                if (!ok) return Json(new { kind = "wipeResp", ok = false, err = err });
                // 删完就停止记录:否则页面下一条消息(每条消息都进日志)会立刻把文件重建,
                // "不留下任何记录"这个承诺就是空的。进程重启后自动恢复记录。
                DisableLog();
                return Json(new { kind = "wipeResp", ok = true, hadKey = hadKey });
            }
            catch (Exception ex)
            {
                return Json(new { kind = "wipeResp", ok = false, err = ex.Message });
            }
        }

        // 日志脱敏:任何带 key 的消息只保留 ***,防止 API Key 落入日志。
        // 原先实现很脆:只匹配字面量 "key":"(不容空格)、只替换**第一处**,而且匹配不到转义形式
        // (页面若用字符串发消息,JSON 里是 \"key\":\"…\")—— 任何一种情况都会让 Key 明文落盘。
        // 现在改成:按字段名(容忍空格)+ 多处的正则,再用 sk- 模式兜一层,最后才截断。
        private static readonly Regex KeyFieldRe =
            new Regex("\"key\"\\s*:\\s*\"[^\"]*\"", RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static readonly Regex KeyLikeRe =
            new Regex("sk-[A-Za-z0-9_\\-]{8,}", RegexOptions.Compiled);

        private static string SanitizeMsg(string j)
        {
            if (j == null) { return ""; }
            try
            {
                j = KeyFieldRe.Replace(j, "\"key\":\"***\"");
                j = KeyLikeRe.Replace(j, "sk-***");
            }
            catch { }
            if (j.Length > 90) { j = j.Substring(0, 90) + "…"; }
            return j;
        }

        /* ---------- 真题年份权重 ----------
         * 高考真题(###SRC:zt/…)按年份分两档:近十年权重提高,较早真题视为普通题。
         * 非真题资料(举一反三 / 一轮讲义 / 公式结论)不参与年份加权,维持原有权重。
         * 调参只改下面 4 个常量:近十年区间与两档权重。
         */
        private const int RecentFrom = 2017;      // 近十年起点(含)
        private const int RecentTo = 2026;        // 近十年终点(含)
        private const double WRecent = 3.0;       // 近十年真题权重
        private const double WNormal = 1.0;       // 较早真题 / 其他资料权重

        private static readonly Regex BlockYearRe =
            new Regex(@"(?:19|20)\d{2}(?=\s*年)", RegexOptions.Compiled);

        // 块首 ###SRC: 那一行(年份只看这一行:正文里出现的年份不算来源年份)
        private static string BlockHead(string block)
        {
            if (block == null) return "";
            int nl = block.IndexOf('\n');
            return nl > 0 ? block.Substring(0, nl) : block;
        }

        // 取块首 ###SRC: 行里的四位数年份;无则 0
        private static int BlockYear(string block)
        {
            return BlockYearOfHead(BlockHead(block));
        }

        private static int BlockYearOfHead(string head)
        {
            if (head == null || head.Length == 0) return 0;
            Match m = BlockYearRe.Match(head);
            if (!m.Success) return 0;
            int y;
            return int.TryParse(m.Value, out y) ? y : 0;
        }

        private static bool IsRecent(int year)
        {
            return year >= RecentFrom && year <= RecentTo;
        }

        // 年份权重:仅高考真题(zt)按年份分档,其余一律 WNormal
        private static double BlockWeight(string block)
        {
            if (block == null) return WNormal;
            if (!block.StartsWith("###SRC:zt/", StringComparison.Ordinal)) return WNormal;
            return IsRecent(BlockYear(block)) ? WRecent : WNormal;
        }

        /* ---------- 年份意图识别(查询 → 年份 + 意图) ----------
         * 用户在破卷搜索框里输入「2026高考题」这类查询时:
         *   1) 年份 = 查询里第一个 1900–2099 的四位数。前后各加一位"非数字"边界,
         *      避免把 12026 这种编号里的后四位切出来当成年份;
         *      「第01讲」的 01、「4题」的 4 位数不够/不以 19|20 打头 → 不会命中。
         *      「2026年」这种写法天然含 2026,直接命中。
         *   2) 意图 = 命中 高考/真题/试题/考卷/试卷/模拟/联考/月考/质检/一模/二模/押题 之一,
         *      表示"要真题/试卷素材"(而不是普通知识点讲解)。
         * 只有年份没有意图词(例如「2026届一轮讲义」)不启用年份限定,保持原有检索行为。
         */
        private static readonly Regex QueryYearRe =
            new Regex(@"(?<!\d)(?:19|20)\d{2}(?!\d)", RegexOptions.Compiled);

        private static readonly Regex IntentRe =
            new Regex("高考|真题|试题|考卷|试卷|模拟|联考|月考|质检|一模|二模|押题", RegexOptions.Compiled);

        // 查询里的第一个年份;没有(或不在 1900–2099)则 0
        private static int QueryYear(string q)
        {
            if (string.IsNullOrEmpty(q)) return 0;
            Match m = QueryYearRe.Match(q);
            if (!m.Success) return 0;
            int y;
            return int.TryParse(m.Value, out y) ? y : 0;
        }

        private static bool HasExamIntent(string q)
        {
            return !string.IsNullOrEmpty(q) && IntentRe.IsMatch(q);
        }

        /* "只要年份"判定:把年份、随后的「年」、试卷类词、空白标点全部去掉后,
         * 查询里不剩任何实词 → 用户就是想看"那一年的卷子"(2026 / 2026年 / 2026高考题 /
         * 2026年高考真题 / 2026一模…)。剩下实词(2026 函数单调性)则只是"年份限定"。
         * 注意:白名单里既有 高考/真题/模拟/一模 这类整词,也有 题/卷 这类通用名词 ——
         * 「2026高考题」按用户口径就是"只要年份",不该因为多打了一个「题」字就被当成实词。
         */
        private static readonly Regex ExamWordRe = new Regex(
            "高考|真题|模拟|联考|月考|质检|一模|二模|押题|试题|考卷|试卷|原卷|全卷解析|全卷|解析|答案|整卷|套卷|题目|卷子|年|题|卷",
            RegexOptions.Compiled);

        private static readonly Regex NoiseRe = new Regex(
            @"(?:19|20)\d{2}|[\s,，、;；.。·:：!！?？""'“”‘’()（）\[\]【】\-—_/\\|]+",
            RegexOptions.Compiled);

        private static bool QueryYearOnly(string q)
        {
            if (string.IsNullOrEmpty(q)) return false;
            return NoiseRe.Replace(ExamWordRe.Replace(q, " "), "").Length == 0;
        }

        // 来源路径末段的文件名(「命中了几份不同的试卷」按它去重)
        private static string PaperName(string head)
        {
            if (head == null) return "";
            int p = head.LastIndexOf('/');
            string s = p >= 0 ? head.Substring(p + 1) : head;
            return s.Replace("\r", "").Trim();
        }

        // "像不像一份卷子"的粗判:只在年份主导模式下用于排序,不改变召回范围
        private static readonly Regex PaperMarkRe = new Regex(
            "原卷|真题|全卷解析|解析|全国卷|新高考|上海卷|北京卷|天津卷|浙江卷|模拟|一模|二模",
            RegexOptions.Compiled);

        private static bool IsPaperHead(string head)
        {
            return head != null && head.Length > 0 && PaperMarkRe.IsMatch(head);
        }

        // 块首 ###SRC: 行里是否含该年份字符串(调用方已把首行切好)。
        // 比 BlockYear(要求"年"紧跟其后)宽松,所以「2026年上海卷(春)原卷.txt」
        // 和路径中段带 2026 的资料都能被年份限定筛到(与"头部含该年份"口径一致)。
        private static bool HeadHasYear(string head, string y)
        {
            if (head == null || y == null || y.Length == 0) return false;
            return head.IndexOf(y, StringComparison.Ordinal) >= 0;
        }

        // 档案覆盖的年份区间(按块首第一个 1900–2099 四位数统计)。
        // 用途:如实告诉用户「本机档案里没有 2026 年的题(档案年份 1952-2026)」,
        // 区间由语料现算,不写死常量(语料换版本后文案不会撒谎)。
        private static void ArchiveYearRange(string[] pool, out int from, out int to)
        {
            int lo = 9999, hi = 0;
            for (int i = 0; i < pool.Length; i++)
            {
                Match m = QueryYearRe.Match(BlockHead(pool[i]));
                if (!m.Success) continue;
                int y;
                if (!int.TryParse(m.Value, out y)) continue;
                if (y < lo) lo = y;
                if (y > hi) hi = y;
            }
            from = hi > 0 ? lo : 0;
            to = hi;
        }

        private static string HandleMats(Dictionary<string, object> msg)
        {
            try
            {
                EnsureCorpus();
                string q = msg.ContainsKey("query") ? Convert.ToString(msg["query"]) : "";
                string srcFilter = msg.ContainsKey("src") ? Convert.ToString(msg["src"]) : "";
                bool loose = msg.ContainsKey("loose") && Convert.ToBoolean(msg["loose"]);
                string[] tokens = q.Split(new char[] { ' ', ',', '，', '、', ';', '；' },
                    StringSplitOptions.RemoveEmptyEntries);
                var terms = new List<string>();
                foreach (var t in tokens)
                    if (t.Trim().Length >= 2) terms.Add(t.Trim());
                string[] pool;
                // 在锁内取一次引用快照:RebuildMerged 是整体替换 mergedBlocks,
                // 取到快照后即可在锁外做耗时的全量扫描,既不阻塞上传也不会读到半成品。
                lock (CorpusLock) { pool = mergedBlocks != null ? mergedBlocks : new string[0]; }
                string prefix = srcFilter.Length > 0 ? "###SRC:" + srcFilter + "/" : "";
                int needScore = loose ? 1 : 2;                 // loose:放宽到命中 1 词
                // ---------- 年份意图(「2026」「2026高考题」「2026 函数单调性」)----------
                // 分两档(与 js/train.js 的 parseSearchIntent 同一套语义):
                //   yearOnly  查询里除年份/「年」/试卷类词外没有别的实词 → 年份主导:
                //             不按知识点过滤(用户要的是"那一年的卷子"),试卷优先排序;
                //   yearScope 年份 + 实词 → 年份先当范围,再用实词在该年份内缩小。
                // 两档都先按"头部含该年份"收候选,再用"自身年份 == 该年份"精筛:
                // zt/版本2：数学（按省份分类）2008-2026/…/2017年高考数学试卷.txt 这种
                // "合集目录名里带年份"的块自身年份是 2017,绝不能当 2026 的素材。
                int declYear = msg.ContainsKey("year") ? SafeInt(msg["year"], 0) : 0;
                int qYear = declYear > 0 ? declYear : QueryYear(q);
                bool qIntent = HasExamIntent(q);
                bool qYearOnly = QueryYearOnly(q);              // 去掉年份/年/试卷类词后不剩实词
                if (msg.ContainsKey("yearOnly") && Convert.ToBoolean(msg["yearOnly"])) qYearOnly = true;
                // 页面明确给了年份,或"只要年份",或查询里带 高考/真题 这类意图词 → 启用年份检索
                bool yearMode = qYear > 0 && (declYear > 0 || qYearOnly || qIntent);
                if (!yearMode) qYearOnly = false;
                string yearTag = yearMode ? qYear.ToString() : "";
                // 年份已经由 yearMode 单独把关,再把裸年份当成关键词只会把"限定"冲淡
                // (loose 下命中 1 词即算命中,而"2026"几乎出现在所有该年份块的头部)。
                if (yearMode)
                    terms.RemoveAll(delegate(string t) { return t == yearTag || t == yearTag + "年"; });
                int yearCand = 0;                              // 头部含该年份的候选块数
                int yearStrict = 0;                            // 上述候选中"自身年份 == 该年份"的块数(真原卷)
                int yearOther = 0;                             // 头部含该年份、但自身是别的年份的块数
                int yearMatched = 0;                           // 实际进入排序的块数(限定档=关键词命中的真原卷)
                bool yearFallback = false;
                var paperNames = new HashSet<string>();        // 该年份命中了几份不同的试卷(按来源文件名去重)
                // 年份限定档的召回放宽:中文没有词边界,「函数单调性」这种连写实词当成一个
                // 子串去匹配几乎必然 0 命中。候选此刻已被锁死在"目标年份的真原卷"里,串不了年份,
                // 所以把长中文词再拆成 2 字片段一起匹配(命中片段越多排越前)。
                // 只对中文词生效:英文按 2 字母切会命中一大片无意义的块。
                if (yearMode && !qYearOnly)
                {
                    var extraTerms = new List<string>();
                    for (int ti = 0; ti < terms.Count; ti++)
                    {
                        string tw = terms[ti];
                        if (tw.Length < 4) continue;
                        int cjk = 0;
                        for (int ci = 0; ci < tw.Length; ci++)
                            if (tw[ci] >= '\u4e00' && tw[ci] <= '\u9fff') cjk++;
                        if (cjk * 2 < tw.Length) continue;
                        for (int ci = 0; ci + 2 <= tw.Length; ci++)
                        {
                            string s2 = tw.Substring(ci, 2);
                            if (!terms.Contains(s2) && !extraTerms.Contains(s2)) extraTerms.Add(s2);
                        }
                    }
                    terms.AddRange(extraTerms);
                }
                var idxHits = new List<int>();                 // 命中块下标
                var scores = new Dictionary<int, double>();    // 加权分 = 词命中数 × 年份权重
                bool retryAll = false;
                do
                {
                    bool limitYear = yearMode && !retryAll;
                    bool onlyNow = qYearOnly && limitYear;     // 年份主导:本轮不按关键词过滤
                    idxHits.Clear();
                    scores.Clear();
                    if (limitYear) { yearCand = 0; yearStrict = 0; yearOther = 0; yearMatched = 0; paperNames.Clear(); }
                    for (int i = 0; i < pool.Length; i++)
                    {
                        string b = pool[i];
                        if (prefix.Length > 0 && !b.StartsWith(prefix, StringComparison.Ordinal)) continue;
                        string head = limitYear ? BlockHead(b) : null;
                        if (limitYear && !HeadHasYear(head, yearTag)) continue;
                        bool inYear = limitYear && BlockYearOfHead(head) == qYear;
                        if (limitYear)
                        {
                            yearCand++;
                            if (inYear) { yearStrict++; paperNames.Add(PaperName(head)); }
                            else yearOther++;
                        }
                        if (onlyNow)
                        {
                            // 年份主导:不要求与任何知识点/关键词匹配 —— 「2026」要的是那一年的卷子。
                            // 排序:路径带 原卷/真题/全卷解析/…卷 的排前面,其余按原有权重。
                            if (!inYear) continue;
                            idxHits.Add(i);
                            scores[i] = (IsPaperHead(head) ? 100000.0 : 0.0) + BlockWeight(b);
                            yearMatched++;
                            continue;
                        }
                        int score = 0;
                        for (int k = 0; k < terms.Count; k++)
                        {
                            if (b.IndexOf(terms[k], StringComparison.Ordinal) >= 0) score++;
                            if (score >= 3) break;
                        }
                        // 阈值仍按原始词命中数判定(权重只影响排序,不改变召回门槛)
                        if (score < needScore) continue;
                        // 年份限定下只认真原卷:合集目录里的其他年份卷子绝不能当该年份素材,
                        // 否则状态栏说"2026 年命中 12 段"、模型拿到的却是 2017 年的题。
                        if (limitYear && !inYear) continue;
                        idxHits.Add(i);
                        scores[i] = score * BlockWeight(b);
                        if (limitYear) yearMatched++;
                    }
                    // 该年份一段真原卷都没有 → 退回普通检索(结果里仍如实标注该年份 0 段)
                    if (!(yearMode && !retryAll && yearStrict == 0)) break;
                    retryAll = true;
                    yearFallback = true;
                } while (true);
                idxHits.Sort(delegate(int a, int b2)
                {
                    int c = scores[b2].CompareTo(scores[a]);
                    if (c != 0) return c;
                    int la = BlockLen(pool[a]), lb = BlockLen(pool[b2]);
                    return la.CompareTo(lb);
                });

                // 输出:命中块为主体,loose 时并入前后相邻块(题目常跨 560 字分块边界)
                var outHits = new List<object>();
                int totalChars = 0;
                int nOutRecent = 0;                            // 输出命中里属近十年真题的条数(诊断用)
                int maxHits = loose ? 10 : 6;
                int charCap = loose ? 14000 : 5200;
                int perCap = loose ? 2400 : 1200;
                var usedIdx = new HashSet<int>();
                for (int hi = 0; hi < idxHits.Count && outHits.Count < maxHits && totalChars < charCap; hi++)
                {
                    int i = idxHits[hi];
                    if (usedIdx.Contains(i)) continue;
                    int i0 = loose ? Math.Max(0, i - 1) : i;
                    int i1 = loose ? Math.Min(pool.Length - 1, i + 1) : i;
                    var sb = new StringBuilder();
                    string src = "";
                    for (int k = i0; k <= i1; k++)
                    {
                        usedIdx.Add(k);
                        string bk = pool[k];
                        int sep = bk.IndexOf('\n');
                        // "###SRC:" 是 7 个字符(# # # S R C :),原先从索引 8 开始切 → 每个来源标签
                        // 都少掉第一个字(zt/全卷解析 → t/全卷解析,连"真题/讲义"的类型前缀都被吃掉);
                        // 空来源(sep==7)时 Substring(8, -1) 还会抛异常,整个 matsResp 变成失败。
                        if (k == i0) src = sep > 7 ? bk.Substring(7, sep - 7) : "";
                        string body = sep > 0 ? bk.Substring(sep + 1) : bk;
                        if (sb.Length > 0) sb.Append('\n');
                        if (sb.Length + body.Length <= perCap) sb.Append(body);
                        else sb.Append(body.Substring(0, Math.Max(0, perCap - sb.Length)));
                    }
                    var h = new Dictionary<string, object>();
                    h["src"] = src;
                    h["text"] = sb.ToString();
                    int hy = BlockYear(pool[i]);
                    h["year"] = hy;
                    if (IsRecent(hy)) nOutRecent++;
                    outHits.Add(h);
                    totalChars += sb.Length;
                }
                int yFrom = 0, yTo = 0;
                if (yearMode) ArchiveYearRange(pool, out yFrom, out yTo);
                // 日志尾部固定带 year=/intent=/filtered= —— 下次排查一眼就能看出年份意图有没有生效。
                // filtered = 头部含该年份的候选数(规格口径);strict = 其中自身年份就是该年份的真原卷数;
                // matched  = 实际进入排序的段数(限定档=真原卷里关键词命中的);only=1 表示年份主导
                // (不按知识点过滤);papers = 该年份命中了几份不同试卷;fallback=1 表示该年份真原卷 0 段。
                string yearLog = " year=" + qYear + " intent=" + (qIntent ? "真题" : "-") +
                    " filtered=" + yearCand;
                if (yearMode)
                    yearLog += " only=" + (qYearOnly ? 1 : 0) + " strict=" + yearStrict +
                        " otherYears=" + yearOther + " matched=" + yearMatched +
                        " papers=" + paperNames.Count + " fallback=" + (yearFallback ? 1 : 0) +
                        " yrange=" + yFrom + "-" + yTo;
                Log("MATS:query=" + Trunc(q, 40) + " src=" + (srcFilter.Length > 0 ? srcFilter : "*") +
                    " loose=" + loose + " hits=" + outHits.Count + " recent=" + nOutRecent +
                    "/" + RecentFrom + "-" + RecentTo + " scanned=" + pool.Length + yearLog);
                return Json(new { kind = "matsResp", ok = true, hits = outHits.ToArray(),
                    total = pool.Length, where = baseWhere,
                    year = qYear, intent = qIntent, yearMode = yearMode, yearOnly = qYearOnly,
                    filtered = yearCand, strict = yearStrict, otherYears = yearOther,
                    matched = yearMatched, papers = paperNames.Count, fallback = yearFallback,
                    yearFrom = yFrom, yearTo = yTo });
            }
            catch (Exception ex)
            {
                return Json(new { kind = "matsResp", ok = false, err = ex.Message });
            }
        }

        private static int BlockLen(string block)
        {
            int sep = block.IndexOf('\n');
            return sep > 0 ? block.Length - sep : block.Length;
        }

        private static int SafeInt(object o, int def)
        {
            try { return Convert.ToInt32(o); } catch { return def; }
        }

        private static double SafeDbl(object o, double def)
        {
            try { return Convert.ToDouble(o); } catch { return def; }
        }

        private static string Trunc(string s, int n)
        {
            if (s == null) return "";
            return s.Length <= n ? s : s.Substring(0, n);
        }

        /* ================= 必应联网搜索(webq,免密钥) =================
         * 用途:为"真实高考真题"档补充素材(本地库不足或非数学科目)。
         * 1) 抓取必应搜索结果(标题/链接/摘要);2) 取前 2 个链接正文窗口;
         * 3) 回传页面,由页面注入提示词。结果真实来源=网页,标记"联网"。
         */
        private class WebHit
        {
            public string url = "";
            public string title = "";
            public string snippet = "";
            public string text = "";
        }

        private static string HandleWebQ(Dictionary<string, object> msg)
        {
            var resp = new Dictionary<string, object>();
            resp["kind"] = "webqResp";
            try
            {
                string query = msg != null && msg.ContainsKey("query") ? Convert.ToString(msg["query"]) : "";
                if (query.Trim().Length < 2) { resp["ok"] = false; resp["err"] = "查询过短"; return Json(resp); }

                List<WebHit> hits = BingSearch(query);
                // 抓取前 2 个链接正文(找关键词附近窗口)
                int bodies = 0;
                foreach (var h in hits)
                {
                    if (bodies >= 2) { h.text = ""; continue; }
                    if (h.url.Length == 0) continue;
                    try
                    {
                        string html = HttpGet(h.url, 40);
                        if (html != null)
                        {
                            string clean = HtmlToText(html, 6000);
                            h.text = WindowAround(clean, msgQueryTerms(msg, query), 900);
                        }
                        bodies++;
                    }
                    catch (Exception ex) { Log("WEBQ-BODY-ERR:" + Trunc(ex.Message, 120)); }
                }
                var arr = new List<object>();
                foreach (var h in hits)
                {
                    var d = new Dictionary<string, object>();
                    d["url"] = h.url;
                    d["title"] = h.title;
                    d["snippet"] = h.snippet;
                    d["text"] = h.text;
                    arr.Add(d);
                }
                resp["ok"] = true;
                resp["hits"] = arr.ToArray();
                resp["query"] = query;
                Log("WEBQ:query=" + Trunc(query, 50) + " hits=" + arr.Count);
                return Json(resp);
            }
            catch (Exception ex)
            {
                resp["ok"] = false;
                resp["err"] = "联网搜索失败:" + Trunc(ex.Message, 160);
                Log("WEBQ-ERR:" + Trunc(ex.Message, 200));
                return Json(resp);
            }
        }

        private static List<string> msgQueryTerms(Dictionary<string, object> msg, string fallback)
        {
            var list = new List<string>();
            if (msg != null && msg.ContainsKey("terms"))
            {
                var arr = AsArr(msg["terms"]);
                if (arr != null)
                    foreach (var a in arr)
                        if (a != null && Convert.ToString(a).Trim().Length >= 2)
                            list.Add(Convert.ToString(a).Trim());
            }
            if (list.Count == 0 && fallback.Length > 0) list.Add(fallback);
            return list;
        }

        // 必应搜索(依次尝试 www / cn),解析 b_algo 结果块
        private static List<WebHit> BingSearch(string query)
        {
            string[] hosts = { "https://www.bing.com/search?q=", "https://cn.bing.com/search?q=" };
            string html = null;
            string lastErr = "";
            foreach (var h in hosts)
            {
                try
                {
                    html = HttpGet(h + Uri.EscapeDataString(query) + "&count=10&setlang=zh-hans", 45);
                    if (html != null && html.IndexOf("b_algo", StringComparison.OrdinalIgnoreCase) >= 0) break;
                    html = null;
                }
                catch (Exception ex) { lastErr = ex.Message; }
            }
            var hits = new List<WebHit>();
            if (html == null)
            {
                if (lastErr.Length > 0) throw new Exception(lastErr);
                return hits;
            }
            var re = new Regex("<li[^>]*class=\"b_algo\"[^>]*>(?<body>.*?)</li>",
                RegexOptions.Singleline | RegexOptions.IgnoreCase);
            foreach (Match m in re.Matches(html))
            {
                if (hits.Count >= 5) break;
                string body = m.Groups["body"].Value;
                var h = new WebHit();
                Match a = Regex.Match(body, "<a[^>]+href=\"(?<u>https?://[^\"]+)\"[^>]*>(?<t>.*?)</a>",
                    RegexOptions.Singleline | RegexOptions.IgnoreCase);
                if (a.Success)
                {
                    h.url = a.Groups["u"].Value;
                    h.title = CleanText(a.Groups["t"].Value);
                    h.url = StripTrack(h.url);
                }
                else continue;
                Match p = Regex.Match(body, "<p[^>]*>(?<s>.*?)</p>", RegexOptions.Singleline | RegexOptions.IgnoreCase);
                if (p.Success) h.snippet = CleanText(p.Groups["s"].Value);
                if (h.snippet.Length == 0)
                {
                    Match sp = Regex.Match(body, "class=\"b_lineclamp[^\"]*\"[^>]*>(?<s>.*?)</",
                        RegexOptions.Singleline | RegexOptions.IgnoreCase);
                    if (sp.Success) h.snippet = CleanText(sp.Groups["s"].Value);
                }
                if (h.url.Length > 0 && h.title.Length > 0) hits.Add(h);
            }
            // 兜底:抓不到 b_algo 时,退化解析任意 h2>a
            if (hits.Count == 0)
            {
                var re2 = new Regex("<h2[^>]*>\\s*<a[^>]+href=\"(?<u>https?://[^\"]+)\"[^>]*>(?<t>.*?)</a>\\s*</h2>",
                    RegexOptions.Singleline | RegexOptions.IgnoreCase);
                foreach (Match m in re2.Matches(html))
                {
                    if (hits.Count >= 5) break;
                    var h = new WebHit();
                    h.url = StripTrack(m.Groups["u"].Value);
                    h.title = CleanText(m.Groups["t"].Value);
                    if (h.url.Length > 0 && h.title.Length > 0) hits.Add(h);
                }
            }
            return hits;
        }

        private static string StripTrack(string url)
        {
            int q = url.IndexOf('?');
            if (q > 0)
            {
                // 必应跳转链:保留真实目标参数 rurl 或直接截断
                Match r = Regex.Match(url, "[?&]rurl=(?<r>[^&]+)", RegexOptions.IgnoreCase);
                if (r.Success)
                {
                    try { return Uri.UnescapeDataString(r.Groups["r"].Value); } catch { }
                }
                int sh = url.IndexOf("&form=", StringComparison.OrdinalIgnoreCase);
                if (sh > 0) url = url.Substring(0, sh);
                else url = url.Substring(0, q);
            }
            return url;
        }

        private static string HttpGet(string url, int timeoutSec)
        {
            try
            {
                // 抓取的是必应搜索结果里的任意 URL —— 必须拦住内网/本机地址(SSRF)
                if (!IsPublicHttpUrl(url)) { Log("HTTP-BLOCK:" + Trunc(url, 100)); return null; }
                SetTls();
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "GET";
                req.UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0";
                req.Accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
                req.Timeout = timeoutSec * 1000;
                req.ReadWriteTimeout = timeoutSec * 1000;
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var st = resp.GetResponseStream())
                {
                    if (st == null) return null;
                    // 优先按响应字符集,兜底 UTF-8
                    string cs = null;
                    try { cs = resp.CharacterSet; } catch { }
                    Encoding enc = Encoding.UTF8;
                    if (!string.IsNullOrEmpty(cs))
                    {
                        try { enc = Encoding.GetEncoding(cs); }
                        catch { enc = Encoding.UTF8; }
                    }
                    using (var rd = new StreamReader(st, enc))
                    {
                        var sb = new StringBuilder();
                        char[] buf = new char[8192];
                        int n;
                        int total = 0;
                        while ((n = rd.Read(buf, 0, buf.Length)) > 0 && total < 260000)
                        {
                            sb.Append(buf, 0, n);
                            total += n;
                        }
                        return sb.ToString();
                    }
                }
            }
            catch (Exception ex)
            {
                Log("HTTP-ERR:" + Trunc(ex.Message, 140));
                return null;
            }
        }

        // HTML → 正文:去 script/style/标签、解实体、压空白
        private static string HtmlToText(string html, int cap)
        {
            if (html == null) return "";
            string s = Regex.Replace(html, "(?is)<(script|style|noscript|svg|head)[^>]*>.*?</\\1>", " ");
            s = Regex.Replace(s, "(?s)<[^>]+>", " ");
            s = s.Replace("&nbsp;", " ").Replace("&amp;", "&").Replace("&lt;", "<").Replace("&gt;", ">")
                 .Replace("&quot;", "\"").Replace("&#39;", "'").Replace("&apos;", "'");
            s = Regex.Replace(s, "&#(?<n>\\d+);", delegate(Match mm)
            {
                try { return ((char)int.Parse(mm.Groups["n"].Value)).ToString(); }
                catch { return " "; }
            });
            s = Regex.Replace(s, "[ \\t\\r\\n]+", " ").Trim();
            return s.Length > cap ? s.Substring(0, cap) : s;
        }

        // 取正文中第一个关键词(或题干词)附近的窗口,便于抓到题目主体
        private static string WindowAround(string text, List<string> terms, int radius)
        {
            if (string.IsNullOrEmpty(text)) return "";
            int at = -1;
            foreach (var t in terms)
            {
                if (t == null || t.Length < 2) continue;
                int i = text.IndexOf(t, StringComparison.OrdinalIgnoreCase);
                if (i >= 0 && (at < 0 || i < at)) at = i;
            }
            if (at < 0) at = 0;
            int from = Math.Max(0, at - 200);
            int to = Math.Min(text.Length, at + radius);
            if (to - from < 300 && to < text.Length) to = Math.Min(text.Length, from + 900);
            string w = text.Substring(from, to - from);
            return w.Length > 1600 ? w.Substring(0, 1600) : w;
        }

        private static string CleanText(string s)
        {
            return HtmlToText(s, 300);
        }
    }
}
