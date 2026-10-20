// CanvasTTY ConPTY bridge.
// Compiled on first run with the csc.exe that ships with .NET Framework on every Windows 10/11.
// Usage: ptybridge.exe <cols> <rows> <cwdBase64> <commandLineBase64>
// stdin  : framed messages  [type:1][len:4 LE][payload]   type 0 = input, 1 = resize(u16 cols,u16 rows), 2 = kill
// stdout : raw terminal output bytes
// exit   : child exit code
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

static class Native
{
    [StructLayout(LayoutKind.Sequential)]
    public struct COORD { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
        public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
        public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern int CreatePseudoConsole(COORD size, SafeFileHandle hInput, SafeFileHandle hOutput, uint dwFlags, out IntPtr phPC);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern int ResizePseudoConsole(IntPtr hPC, COORD size);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern void ClosePseudoConsole(IntPtr hPC);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CreatePipe(out SafeFileHandle hReadPipe, out SafeFileHandle hWritePipe, IntPtr lpPipeAttributes, int nSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpInfo, uint cbInfoLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
}

static class Program
{
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const int STARTF_USESTDHANDLES = 0x00000100;
    static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = (IntPtr)0x00020016;

    static IntPtr hPC = IntPtr.Zero;
    static IntPtr hProcess = IntPtr.Zero;
    static Stream stdout;
    static readonly object outLock = new object();
    static volatile bool closing = false;

    static string B64(string s)
    {
        if (s == "-" || s.Length == 0) return "";
        return Encoding.UTF8.GetString(Convert.FromBase64String(s));
    }

    static int Main(string[] args)
    {
        if (args.Length < 4) { Console.Error.WriteLine("usage: ptybridge cols rows cwdB64 cmdB64"); return 2; }
        short cols = short.Parse(args[0]);
        short rows = short.Parse(args[1]);
        string cwd = B64(args[2]);
        string cmd = B64(args[3]);
        if (cwd.Length == 0 || !Directory.Exists(cwd)) cwd = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        stdout = Console.OpenStandardOutput();
        Stream stdin = Console.OpenStandardInput();

        SafeFileHandle inRead, inWrite, outRead, outWrite;
        if (!Native.CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0) || !Native.CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0))
        {
            Console.Error.WriteLine("CreatePipe failed: " + Marshal.GetLastWin32Error());
            return 3;
        }

        Native.COORD size = new Native.COORD(); size.X = cols; size.Y = rows;
        int hr = Native.CreatePseudoConsole(size, inRead, outWrite, 0, out hPC);
        if (hr != 0) { Console.Error.WriteLine("CreatePseudoConsole failed: 0x" + hr.ToString("X")); return 4; }

        // Attribute list
        IntPtr lpSize = IntPtr.Zero;
        Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref lpSize);
        IntPtr attrList = Marshal.AllocHGlobal(lpSize);
        if (!Native.InitializeProcThreadAttributeList(attrList, 1, 0, ref lpSize)) { Console.Error.WriteLine("InitializeProcThreadAttributeList failed"); return 5; }
        if (!Native.UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
        { Console.Error.WriteLine("UpdateProcThreadAttribute failed: " + Marshal.GetLastWin32Error()); return 6; }

        Native.STARTUPINFOEX si = new Native.STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(Native.STARTUPINFOEX));
        // Prevent the child from inheriting this bridge's redirected stdio.
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = IntPtr.Zero; si.StartupInfo.hStdOutput = IntPtr.Zero; si.StartupInfo.hStdError = IntPtr.Zero;
        si.lpAttributeList = attrList;

        Native.PROCESS_INFORMATION pi;
        StringBuilder cmdLine = new StringBuilder(cmd);
        if (!Native.CreateProcessW(null, cmdLine, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, cwd, ref si, out pi))
        {
            int err = Marshal.GetLastWin32Error();
            byte[] msg = Encoding.UTF8.GetBytes("\r\n\x1b[31m[CanvasTTY] Не удалось запустить: " + cmd + " (код " + err + ")\x1b[0m\r\n");
            stdout.Write(msg, 0, msg.Length); stdout.Flush();
            return 127;
        }
        hProcess = pi.hProcess;
        Native.CloseHandle(pi.hThread);
        // These ends now belong to the pseudoconsole
        inRead.Dispose(); outWrite.Dispose();

        // Kill the whole process tree when the bridge goes away
        try
        {
            IntPtr job = Native.CreateJobObjectW(IntPtr.Zero, null);
            if (job != IntPtr.Zero)
            {
                Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                int len = Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                IntPtr p = Marshal.AllocHGlobal(len);
                Marshal.StructureToPtr(info, p, false);
                if (Native.SetInformationJobObject(job, 9, p, (uint)len)) Native.AssignProcessToJobObject(job, hProcess);
                Marshal.FreeHGlobal(p);
            }
        }
        catch { }

        FileStream ptyOut = new FileStream(outRead, FileAccess.Read, 4096, false);
        FileStream ptyIn = new FileStream(inWrite, FileAccess.Write, 4096, false);

        Thread reader = new Thread(delegate ()
        {
            byte[] buf = new byte[16384];
            try
            {
                while (true)
                {
                    int n = ptyOut.Read(buf, 0, buf.Length);
                    if (n <= 0) break;
                    lock (outLock) { stdout.Write(buf, 0, n); stdout.Flush(); }
                }
            }
            catch { }
        });
        reader.IsBackground = true;
        reader.Start();

        Thread waiter = new Thread(delegate ()
        {
            Native.WaitForSingleObject(hProcess, 0xFFFFFFFF);
            uint code; Native.GetExitCodeProcess(hProcess, out code);
            Finish((int)code, reader);
        });
        waiter.IsBackground = true;
        waiter.Start();

        // stdin frame loop (main thread)
        byte[] header = new byte[5];
        try
        {
            while (true)
            {
                if (!ReadExact(stdin, header, 5)) break;
                int type = header[0];
                int plen = BitConverter.ToInt32(header, 1);
                byte[] payload = new byte[plen];
                if (plen > 0 && !ReadExact(stdin, payload, plen)) break;
                if (type == 0) { ptyIn.Write(payload, 0, plen); ptyIn.Flush(); }
                else if (type == 1 && plen >= 4)
                {
                    Native.COORD s = new Native.COORD();
                    s.X = (short)BitConverter.ToUInt16(payload, 0); s.Y = (short)BitConverter.ToUInt16(payload, 2);
                    if (s.X > 0 && s.Y > 0) Native.ResizePseudoConsole(hPC, s);
                }
                else if (type == 2) break;
            }
        }
        catch { }
        // stdin closed or kill requested
        try { Native.TerminateProcess(hProcess, 1); } catch { }
        Finish(1, reader);
        return 1;
    }

    static void Finish(int code, Thread reader)
    {
        if (closing) { Thread.Sleep(5000); return; }
        closing = true;
        IntPtr pc = hPC; hPC = IntPtr.Zero;
        // ClosePseudoConsole can block until output is drained, so run it off-thread
        Thread closer = new Thread(delegate () { try { if (pc != IntPtr.Zero) Native.ClosePseudoConsole(pc); } catch { } });
        closer.IsBackground = true; closer.Start();
        reader.Join(1500);
        closer.Join(1500);
        lock (outLock) { try { stdout.Flush(); } catch { } }
        Environment.Exit(code);
    }

    static bool ReadExact(Stream s, byte[] buf, int len)
    {
        int off = 0;
        while (off < len)
        {
            int n = s.Read(buf, off, len - off);
            if (n <= 0) return false;
            off += n;
        }
        return true;
    }
}
