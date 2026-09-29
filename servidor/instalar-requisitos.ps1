# Instala los requisitos del SERVIDOR en Windows automáticamente con winget
# (incluido en Windows 10/11): Node.js y Tailscale. Docker es opcional y se ofrece aparte
# porque requiere WSL2 y reiniciar la PC.
#
#   powershell -ExecutionPolicy Bypass -File servidor\instalar-requisitos.ps1
#   powershell -ExecutionPolicy Bypass -File servidor\instalar-requisitos.ps1 -ConDocker
param([switch]$ConDocker)

$ErrorActionPreference = 'Stop'

function Tengo($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Write-Host '== Instalación de requisitos del servidor (SoftGala) ==' -ForegroundColor Cyan

# winget es la tienda de paquetes de Windows; viene en Windows 10 21H2+ y Windows 11.
if (-not (Tengo winget)) {
  Write-Host 'No se encontró winget (Instalador de aplicaciones de Windows).' -ForegroundColor Yellow
  Write-Host 'Actualiza "Instalador de aplicaciones" desde Microsoft Store, o instala a mano:'
  Write-Host '  Node.js LTS: https://nodejs.org     Tailscale: https://tailscale.com/download'
  exit 1
}

function Instalar($id, $nombre, $comando) {
  if (Tengo $comando) {
    Write-Host "[ok] $nombre ya está instalado." -ForegroundColor Green
    return
  }
  Write-Host "[..] Instalando $nombre..." -ForegroundColor Cyan
  winget install --id $id --exact --silent --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) { throw "No se pudo instalar $nombre (winget devolvió $LASTEXITCODE)." }
  Write-Host "[ok] $nombre instalado." -ForegroundColor Green
}

# Node.js LTS (para correr el servidor) y Tailscale (red privada).
Instalar 'OpenJS.NodeJS.LTS' 'Node.js LTS' 'node'
Instalar 'tailscale.tailscale' 'Tailscale' 'tailscale'

if ($ConDocker) {
  if (Tengo docker) {
    Write-Host '[ok] Docker ya está instalado.' -ForegroundColor Green
  } else {
    Write-Host '[..] Instalando Docker Desktop (necesita WSL2 y reiniciar la PC al terminar)...' -ForegroundColor Cyan
    winget install --id Docker.DockerDesktop --exact --silent --accept-source-agreements --accept-package-agreements
    Write-Host '[!] Docker requiere REINICIAR la PC y abrir Docker Desktop una vez antes de usarlo.' -ForegroundColor Yellow
  }
} else {
  Write-Host ''
  Write-Host 'Docker (opcional) no se instaló. Sirve solo para ejecutar las validaciones (tests) de los'
  Write-Host 'proyectos; sin él se informan como "no ejecutadas". Para instalarlo: repite con -ConDocker.'
}

Write-Host ''
Write-Host '== Requisitos listos ==' -ForegroundColor Green
Write-Host 'IMPORTANTE: cierra y vuelve a abrir PowerShell para que se actualice el PATH (node, tailscale).'
Write-Host 'Luego continúa con la guía: servidor\README.md (preparar-servidor, publicar-tailscale, iniciar).'
