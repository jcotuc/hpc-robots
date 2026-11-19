Option Explicit
' Corre correr.cmd sin ventana negra (lo usa la tarea "HPC Correos").
' 0 = oculto, True = espera a que termine (asi la tarea no se encima con la siguiente corrida)
Dim sh, carpeta
Set sh = CreateObject("WScript.Shell")
carpeta = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WScript.Quit sh.Run("cmd.exe /c """ & carpeta & "\correr.cmd""", 0, True)
