' Corre correr.cmd sin mostrar ninguna ventana (lo usa la tarea programada)
Set sh = CreateObject("WScript.Shell")
carpeta = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = carpeta
sh.Run """" & carpeta & "\correr.cmd""", 0, True
