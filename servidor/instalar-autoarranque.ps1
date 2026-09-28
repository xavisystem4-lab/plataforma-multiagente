# Crea (o quita) un acceso directo en la carpeta de Inicio de Windows para que el servidor
# arranque solo al iniciar sesión en esta PC. No instala ningún servicio del sistema.
#
#   Instalar:   powershell -ExecutionPolicy Bypass -File servidor\instalar-autoarranque.ps1
#   Quitar:     powershell -ExecutionPolicy Bypass -File servidor\instalar-autoarranque.ps1 -Quitar
param([switch]$Quitar)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$vbs = Join-Path $raiz 'servidor\iniciar-servidor.vbs'
$inicio = [Environment]::GetFolderPath('Startup')
$acceso = Join-Path $inicio 'Plataforma Multiagente (servidor).lnk'

if ($Quitar) {
  if (Test-Path $acceso) { Remove-Item $acceso; Write-Host 'Autoarranque quitado.' }
  else { Write-Host 'No había autoarranque instalado.' }
  return
}

if (-not (Test-Path $vbs)) { throw "No se encontró $vbs" }

# Comprueba que Node esté disponible.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js no está instalado o no está en el PATH. Instálalo desde https://nodejs.org (LTS) y reinicia esta ventana.' }

$w = New-Object -ComObject WScript.Shell
$s = $w.CreateShortcut($acceso)
$s.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$s.Arguments = "`"$vbs`""
$s.WorkingDirectory = $raiz
$s.Description = 'Servidor de la Plataforma Multiagente (SoftGala)'
$s.WindowStyle = 7  # minimizado
$s.Save()

Write-Host "Autoarranque instalado: $acceso"
Write-Host 'El servidor arrancará la próxima vez que inicies sesión en Windows.'
Write-Host 'Para arrancarlo ahora sin reiniciar:  wscript "servidor\iniciar-servidor.vbs"'
Write-Host 'El registro del servidor queda en:     servidor\servidor.log'
