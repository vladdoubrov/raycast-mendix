# Moves one folder to the Recycle Bin. Raycast's trash() times out after 5 seconds, which a Mendix
# project (deployment, node_modules) easily exceeds, so the extension runs this instead.
# Input: MX_RECYCLE_PATH. Exit codes: 0 recycled, 2 cancelled at the permanent-delete warning, 1 failed.
$ErrorActionPreference = 'Stop'
$path = $env:MX_RECYCLE_PATH
if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Container)) { [Console]::Error.WriteLine("Folder not found: $path"); exit 1 }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Recycler {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SHFILEOPSTRUCT {
        public IntPtr hwnd;
        public uint wFunc;
        [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;
        [MarshalAs(UnmanagedType.LPWStr)] public string pTo;
        public ushort fFlags;
        [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
        public IntPtr hNameMappings;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszProgressTitle;
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHFileOperation(ref SHFILEOPSTRUCT op);

    const uint FO_DELETE = 3;
    const ushort FOF_SILENT = 0x4, FOF_NOCONFIRMATION = 0x10, FOF_ALLOWUNDO = 0x40, FOF_NOERRORUI = 0x400;
    // Asks before deleting permanently (e.g. the folder exceeds the Recycle Bin size); overrides NOCONFIRMATION for that case only.
    const ushort FOF_WANTNUKEWARNING = 0x4000;

    public static int Recycle(string path, out bool aborted) {
        var op = new SHFILEOPSTRUCT {
            wFunc = FO_DELETE,
            pFrom = path + "\0\0",
            fFlags = (ushort)(FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_WANTNUKEWARNING | FOF_SILENT | FOF_NOERRORUI),
        };
        int result = SHFileOperation(ref op);
        aborted = op.fAnyOperationsAborted;
        return result;
    }

    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, byte[] info, int length, out int returned);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, int size, out IntPtr read);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, System.Text.StringBuilder name, ref int size);

    // Reads PEB -> ProcessParameters -> CurrentDirectory (64-bit layout); null when not readable.
    static string CurrentDirectory(IntPtr process) {
        var basic = new byte[48]; int returned; IntPtr read;
        if (NtQueryInformationProcess(process, 0, basic, basic.Length, out returned) != 0) return null;
        var pointer = new byte[8];
        if (!ReadProcessMemory(process, (IntPtr)(BitConverter.ToInt64(basic, 8) + 0x20), pointer, 8, out read)) return null;
        var text = new byte[16];
        if (!ReadProcessMemory(process, (IntPtr)(BitConverter.ToInt64(pointer, 0) + 0x38), text, 16, out read)) return null;
        var chars = new byte[BitConverter.ToUInt16(text, 0)];
        if (!ReadProcessMemory(process, (IntPtr)BitConverter.ToInt64(text, 8), chars, chars.Length, out read)) return null;
        return System.Text.Encoding.Unicode.GetString(chars);
    }

    // Processes working in or running from the folder, e.g. a terminal opened in the project.
    // A process's current directory blocks moving the folder. Studio Pro holding files inside it is not detected.
    public static string[] Holders(string folder) {
        Func<string, string> slash = p => p.TrimEnd('\\') + "\\";
        string prefix = slash(folder);
        var found = new System.Collections.Generic.List<string>();
        int self = System.Diagnostics.Process.GetCurrentProcess().Id;
        foreach (var p in System.Diagnostics.Process.GetProcesses()) {
            if (p.Id == self) continue;
            IntPtr process = OpenProcess(0x0410, false, p.Id); // QUERY_INFORMATION | VM_READ
            if (process == IntPtr.Zero) continue;
            try {
                var image = new System.Text.StringBuilder(1024); int size = image.Capacity;
                string cwd = CurrentDirectory(process), exe = QueryFullProcessImageName(process, 0, image, ref size) ? image.ToString() : null;
                if ((cwd != null && slash(cwd).StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                    || (exe != null && exe.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)))
                    found.Add(p.ProcessName + " (PID " + p.Id + ")");
            } finally { CloseHandle(process); }
        }
        return found.ToArray();
    }
}
'@

$full = [IO.Path]::GetFullPath($path)
$aborted = $false
$code = [Recycler]::Recycle($full, [ref]$aborted)
if ($aborted) { exit 2 }
if ($code -ne 0) {
    $holders = @([Recycler]::Holders($full))
    $reason = if ($holders.Count) { "It is in use by $($holders -join ', '). Close it or move it out of the folder, then try again." }
        else { 'Close it in Studio Pro and any terminal or editor open in it, then try again.' }
    [Console]::Error.WriteLine(('Windows could not recycle the folder (error 0x{0:X}). {1}' -f $code, $reason))
    exit 1
}
exit 0
