' Arranca el servidor sin abrir una ventana de consola visible.
' Lo invoca el acceso directo de la carpeta de Inicio de Windows.
' La salida se escribe en servidor\servidor.log para poder revisarla.
Option Explicit
Dim shell, fso, raiz, comando
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
' La carpeta del proyecto es el padre de la carpeta de este script.
raiz = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.CurrentDirectory = raiz
comando = "cmd /c node ""servidor\iniciar.mjs"" > ""servidor\servidor.log"" 2>&1"
' 0 = ventana oculta; False = no esperar a que termine.
shell.Run comando, 0, False
