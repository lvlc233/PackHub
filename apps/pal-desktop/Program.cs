using System.Diagnostics;

namespace PalDesktop;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Contains("--smoke")) return Smoke(args);

        using var mutex = new Mutex(true, @"Global\PalDesktop.SingleInstance", out var first);
        if (!first)
        {
            MessageBox.Show("PAL 已经在运行。", "PAL", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }

        var portIndex = Array.IndexOf(args, "--debug-port");
        var debugPort = portIndex >= 0 && portIndex + 1 < args.Length && int.TryParse(args[portIndex + 1], out var parsed)
            ? parsed
            : 0;

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainForm(debugPort));
        return 0;
    }

    /// <summary>起一次侧车并把地址写进日志，用来在无界面环境下验证壳的启动链路。</summary>
    private static int Smoke(string[] args)
    {
        var index = Array.IndexOf(args, "--log");
        var log = index >= 0 && index + 1 < args.Length ? args[index + 1] : Path.Combine(Path.GetTempPath(), "pal-smoke.log");
        Process? server = null;
        try
        {
            (server, var url) = MainForm.StartServerAsync().GetAwaiter().GetResult();
            File.WriteAllText(log, url);
            return 0;
        }
        catch (Exception ex)
        {
            File.WriteAllText(log, "ERROR " + ex.Message);
            return 1;
        }
        finally
        {
            if (server is { HasExited: false })
            {
                try
                {
                    server.Kill(entireProcessTree: true);
                }
                catch
                {
                    /* 收摊失败不影响 smoke 结果 */
                }
            }
        }
    }
}
