using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PalDesktop;

/// <summary>
/// Windows 壳：起 pal serve（Node 侧车），把本地界面装进 WebView2。
/// 壳只负责窗口与生命周期，实例逻辑全在内核里。
/// </summary>
public sealed class MainForm : Form
{
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private readonly int _debugPort;
    private Process? _server;
    private string? _url;

    public MainForm(int debugPort = 0)
    {
        _debugPort = debugPort;
        Text = "PAL";
        MinimumSize = new Size(960, 640);
        StartPosition = FormStartPosition.CenterScreen;
        WindowState = FormWindowState.Maximized;
        BackColor = Color.FromArgb(18, 20, 23);
        Controls.Add(_web);
        Shown += async (_, _) => await BootAsync();
        FormClosing += (_, _) => StopServer();
    }

    private async Task BootAsync()
    {
        try
        {
            var (server, url) = await StartServerAsync();
            _server = server;
            _url = url;

            var dataDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pal", "webview2");
            Directory.CreateDirectory(dataDir);
            var options = new CoreWebView2EnvironmentOptions(
                _debugPort > 0 ? $"--remote-debugging-port={_debugPort}" : null);
            var env = await CoreWebView2Environment.CreateAsync(null, dataDir, options);
            await _web.EnsureCoreWebView2Async(env);
            _web.CoreWebView2.Navigate(_url);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "PAL 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    public static async Task<(Process Process, string Url)> StartServerAsync()
    {
        var (node, cli, workDir, strip) = FindRuntime();

        var psi = new ProcessStartInfo(node)
        {
            WorkingDirectory = workDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        if (strip) psi.ArgumentList.Add("--experimental-strip-types");
        psi.ArgumentList.Add(cli);
        psi.ArgumentList.Add("serve");
        psi.ArgumentList.Add("--port");
        psi.ArgumentList.Add("0");
        psi.ArgumentList.Add("--json");

        Process server;
        try
        {
            server = Process.Start(psi) ?? throw new InvalidOperationException("起不了 pal serve");
        }
        catch (System.ComponentModel.Win32Exception)
        {
            throw new InvalidOperationException("找不到可用的 Node：可以带 runtime/node.exe 一起发布，或先装 Node 22+ 放进 PATH。");
        }
        server.ErrorDataReceived += (_, _) => { };
        server.BeginErrorReadLine();

        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        while (true)
        {
            var line = await server.StandardOutput.ReadLineAsync(timeout.Token);
            if (line is null) break;
            line = line.Trim();
            if (!line.StartsWith("{")) continue;
            using var doc = JsonDocument.Parse(line);
            if (doc.RootElement.TryGetProperty("url", out var url) && url.GetString() is { } value)
            {
                return (server, value);
            }
        }
        throw new InvalidOperationException("pal serve 没有返回地址（看 packages/launcher 的输出）");
    }

    public static string FindRepo()
    {
        var fromEnv = Environment.GetEnvironmentVariable("PAL_REPO");
        if (!string.IsNullOrWhiteSpace(fromEnv) && File.Exists(Path.Combine(fromEnv, "packages", "launcher", "src", "bin.ts")))
        {
            return Path.GetFullPath(fromEnv);
        }

        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "packages", "launcher", "src", "bin.ts")))
            {
                return dir.FullName;
            }
            dir = dir.Parent;
        }
        throw new InvalidOperationException("找不到 PackHub 仓库：设 PAL_REPO 指向仓库根");
    }

    /// <summary>优先用发布目录里带的 runtime（node.exe + pal.cjs），没有才回落到仓库 + 系统 node。</summary>
    private static (string Node, string Script, string WorkDir, bool Strip) FindRuntime()
    {
        var baseDir = AppContext.BaseDirectory;
        var bundledNode = Path.Combine(baseDir, "runtime", "node.exe");
        var bundledScript = Path.Combine(baseDir, "runtime", "pal.cjs");
        if (File.Exists(bundledNode) && File.Exists(bundledScript))
        {
            return (bundledNode, bundledScript, baseDir, false);
        }

        var repo = FindRepo();
        var cli = Path.Combine(repo, "packages", "launcher", "src", "bin.ts");
        return ("node", cli, repo, true);
    }

    private void StopServer()
    {
        if (_server is null || _server.HasExited) return;
        try
        {
            var kill = new ProcessStartInfo("taskkill")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            kill.ArgumentList.Add("/PID");
            kill.ArgumentList.Add(_server.Id.ToString());
            kill.ArgumentList.Add("/T");
            kill.ArgumentList.Add("/F");
            Process.Start(kill)?.WaitForExit(3000);
        }
        catch
        {
            /* 收摊失败不挡关窗 */
        }
    }
}
