using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

namespace VocalStudio
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            try
            {
                string appDir = @"c:\សម្រាយរឿង";
                if (!Directory.Exists(appDir))
                {
                    appDir = @"c:\B21E~1";
                }
                if (!Directory.Exists(appDir))
                {
                    appDir = AppDomain.CurrentDomain.BaseDirectory;
                }
                Directory.SetCurrentDirectory(appDir);

                // Check if Vocal Studio backend is already running on port 8000 or 8088
                string activeUrl = null;
                if (IsVocalStudioRunning(8000))
                {
                    activeUrl = "http://127.0.0.1:8000";
                }
                else if (IsVocalStudioRunning(8088))
                {
                    activeUrl = "http://127.0.0.1:8088";
                }

                Process pythonProcess = null;

                if (activeUrl == null)
                {
                    // Launch pythonw (silent background) or python
                    ProcessStartInfo startInfo = new ProcessStartInfo
                    {
                        FileName = "pythonw.exe",
                        Arguments = "app.py",
                        WorkingDirectory = appDir,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden
                    };

                    try
                    {
                        pythonProcess = Process.Start(startInfo);
                    }
                    catch
                    {
                        startInfo.FileName = "python.exe";
                        pythonProcess = Process.Start(startInfo);
                    }

                    // Wait up to 12 seconds for Vocal Studio server to respond on 8000 or 8088
                    for (int i = 0; i < 24; i++)
                    {
                        Thread.Sleep(500);
                        if (IsVocalStudioRunning(8000))
                        {
                            activeUrl = "http://127.0.0.1:8000";
                            break;
                        }
                        if (IsVocalStudioRunning(8088))
                        {
                            activeUrl = "http://127.0.0.1:8088";
                            break;
                        }
                    }
                }

                if (activeUrl == null)
                {
                    activeUrl = "http://127.0.0.1:8000";
                }

                // Check Chrome or Edge for standalone Desktop App Mode
                string chromePath = @"C:\Program Files\Google\Chrome\Application\chrome.exe";
                string edgePath = @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";

                string browserExe = null;
                if (File.Exists(chromePath))
                {
                    browserExe = chromePath;
                }
                else if (File.Exists(edgePath))
                {
                    browserExe = edgePath;
                }

                Process browserProcess = null;
                if (browserExe != null)
                {
                    // Open in Desktop App Mode (dedicated window without browser address bars)
                    ProcessStartInfo appWindowInfo = new ProcessStartInfo
                    {
                        FileName = browserExe,
                        Arguments = string.Format("--app=\"{0}\" --window-size=1400,860", activeUrl),
                        UseShellExecute = false
                    };
                    browserProcess = Process.Start(appWindowInfo);
                }
                else
                {
                    Process.Start(new ProcessStartInfo(activeUrl) { UseShellExecute = true });
                }

                if (browserProcess != null)
                {
                    browserProcess.WaitForExit();
                    if (pythonProcess != null && !pythonProcess.HasExited)
                    {
                        try { pythonProcess.Kill(); } catch { }
                    }
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Error launching Vocal Studio:\n" + ex.Message, "Vocal Studio Launcher", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        static bool IsVocalStudioRunning(int port)
        {
            try
            {
                string url = string.Format("http://127.0.0.1:{0}/api/health", port);
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 800;
                req.Method = "GET";
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                {
                    if ((int)res.StatusCode == 200)
                    {
                        using (StreamReader reader = new StreamReader(res.GetResponseStream()))
                        {
                            string text = reader.ReadToEnd();
                            return text.Contains("VocalStudio");
                        }
                    }
                }
            }
            catch
            {
                return false;
            }
            return false;
        }
    }
}
