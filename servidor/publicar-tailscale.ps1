# Publica el servidor local (127.0.0.1:4000) como HTTPS dentro de tu red privada Tailscale.
# Requiere: Tailscale instalado y con sesión iniciada, y MagicDNS + HTTPS activados en la
# consola de administración de Tailscale (Settings -> Keys/DNS -> Enable HTTPS).
#
#   Publicar:   powershell -ExecutionPolicy Bypass -File servidor\publicar-tailscale.ps1
#   Quitar:     powershell -ExecutionPolicy Bypass -File servidor\publicar-tailscale.ps1 -Quitar
param([int]$Puerto = 4000, [switch]$Quitar)

$ErrorActionPreference = 'Stop'

$ts = Get-Command tailscale -ErrorAction SilentlyContinue
if (-not $ts) {
  $rutaTs = "$env:ProgramFiles\Tailscale\tailscale.exe"
  if (Test-Path $rutaTs) { $ts = $rutaTs } else { throw 'No se encontró Tailscale. Instálalo desde https://tailscale.com/download y vuelve a intentarlo.' }
}
$tsExe = if ($ts -is [string]) { $ts } else { $ts.Source }

if ($Quitar) {
  & $tsExe serve --https=443 off
  Write-Host 'Publicación HTTPS retirada.'
  return
}

# Comprueba que Tailscale tenga sesión.
$estado = & $tsExe status 2>&1
if ($LASTEXITCODE -ne 0 -or $estado -match 'Logged out') {
  throw 'Tailscale no tiene sesión iniciada. Ejecuta:  tailscale up   e inicia sesión, luego repite esto.'
}

# Publica HTTPS (443) apuntando al servidor local. --bg lo deja corriendo en segundo plano.
& $tsExe serve --bg --https=443 "http://127.0.0.1:$Puerto"
if ($LASTEXITCODE -ne 0) {
  throw 'No se pudo publicar. Verifica que "HTTPS Certificates" esté activado en la consola de Tailscale (admin console -> DNS).'
}

# Obtiene el nombre DNS de esta máquina en la tailnet (…​.ts.net).
$dns = (& $tsExe status --json | ConvertFrom-Json).Self.DNSName.TrimEnd('.')
Write-Host ''
Write-Host '==============================================================='
Write-Host ' Servidor publicado en tu red privada Tailscale.'
Write-Host ' Pon ESTA dirección en la app (Windows y Android), en Servidor:'
Write-Host ''
Write-Host "     https://$dns"
Write-Host ''
Write-Host ' Solo tus dispositivos con Tailscale podrán conectarse.'
Write-Host '==============================================================='
