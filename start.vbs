' Zero Desk —— 无窗口启动（双击本文件即可）
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
exe = base & "\node_modules\electron\dist\electron.exe"
sh.CurrentDirectory = base
sh.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = ""
sh.Run """" & exe & """ """ & base & """", 0, False
