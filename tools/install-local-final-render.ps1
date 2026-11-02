# UNWIN local final-render installer (non-destructive)
# Installs a reusable final-render helper into the existing Director folder.
# Does not overwrite Director source or modify browser UI.
$ErrorActionPreference = 'Stop'
$comfy = Join-Path $env:LOCALAPPDATA 'Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI'
$director = Join-Path $comfy 'custom_nodes\Unwin-MiniMax-Director'
if (-not (Test-Path $director)) { throw "Director folder not found: $director. Check your ComfyUI Desktop installation." }
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) { throw 'FFmpeg not found on PATH. Install FFmpeg before running this installer.' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$target = Join-Path $director 'unwin_final_render'
New-Item -ItemType Directory -Force -Path $target | Out-Null
$backup = Join-Path $target "backup-$stamp"
New-Item -ItemType Directory -Force -Path $backup | Out-Null
foreach ($name in @('Final_Render.ps1','Run_Final_Render.cmd')) {
  $old = Join-Path $target $name
  if (Test-Path $old) { Copy-Item $old (Join-Path $backup $name) -Force }
}
$ps = @'
param(
 [string]$Video = '',
 [string]$Narration = '',
 [string]$Output = ''
)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'Comfy-Desktop\ComfyUI-Shared\output'
if (-not (Test-Path $root)) { throw "ComfyUI output folder not found: $root" }
if (-not $Video) {
 $v = Get-ChildItem $root -Recurse -File -Filter '*.mp4' | Where-Object { $_.Name -match 'H3_Cinematic_Pipeline_Test|UNWIN' -and $_.Name -notmatch 'Combined|Final' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
 if (-not $v) { throw 'No suitable video found. Pass -Video with an absolute MP4 path.' }
 $Video = $v.FullName
}
if (-not $Narration) {
 $a = Get-ChildItem $root -Recurse -File -Filter '*.mp3' | Where-Object { $_.Name -match 'voice_|dialogue|narrat' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
 if (-not $a) { throw 'No narration found. Pass -Narration with an absolute MP3 path.' }
 $Narration = $a.FullName
}
if (-not (Test-Path -LiteralPath $Video -PathType Leaf)) { throw "Video missing: $Video" }
if (-not (Test-Path -LiteralPath $Narration -PathType Leaf)) { throw "Narration missing: $Narration" }
if (-not $Output) { $Output = Join-Path $root 'UNWIN\UNWIN_Final_Render.mp4' }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Output) | Out-Null
$resolvedVideo = (Resolve-Path -LiteralPath $Video).Path
$resolvedNarration = (Resolve-Path -LiteralPath $Narration).Path
if ($Output -eq $resolvedVideo -or $Output -eq $resolvedNarration) { throw 'Output must not overwrite an input file.' }
Write-Host "Video: $resolvedVideo"
Write-Host "Narration: $resolvedNarration"
Write-Host "Output: $Output"
& ffmpeg -hide_banner -y -stream_loop -1 -i $resolvedVideo -i $resolvedNarration -map 0:v:0 -map 1:a:0 -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k -af 'apad=pad_dur=0.5' -shortest -movflags +faststart $Output
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $Output)) { throw "FFmpeg failed with exit code $LASTEXITCODE" }
Write-Host "Completed: $Output" -ForegroundColor Green
Start-Process explorer.exe -ArgumentList ('/select,"' + $Output + '"')
'@
$cmd = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Final_Render.ps1"
if errorlevel 1 pause
'@
[IO.File]::WriteAllText((Join-Path $target 'Final_Render.ps1'),$ps,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $target 'Run_Final_Render.cmd'),$cmd,[Text.UTF8Encoding]::new($false))
Write-Host "Installed final-render helper at: $target" -ForegroundColor Green
Write-Host 'This does not modify the Director interface. Run Run_Final_Render.cmd or use Final_Render.ps1 -Video ... -Narration ...'
