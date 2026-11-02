# Install the Final Render integration into the existing UNWIN Director.
# Backups are created; only __init__.py, web/audio-studio.html, and the new bridge are touched.
$ErrorActionPreference = 'Stop'
$roots = @(
 (Join-Path $env:LOCALAPPDATA 'Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\custom_nodes\Unwin-MiniMax-Director'),
 (Join-Path $env:LOCALAPPDATA 'Comfy-Desktop\ComfyUI-Shared\custom_nodes\Unwin-MiniMax-Director')
)
$target = $roots | Where-Object { Test-Path (Join-Path $_ 'web\audio-studio.html') } | Select-Object -First 1
if (-not $target) {
 Write-Host 'Could not auto-detect the Director folder.' -ForegroundColor Yellow
 $target = Read-Host 'Paste the FULL path to your Unwin-MiniMax-Director folder'
 $target = $target.Trim('"')
}
$init = Join-Path $target '__init__.py'
$htmlFile = Join-Path $target 'web\audio-studio.html'
$bridge = Join-Path $target 'final_render_bridge.py'
if (-not (Test-Path $init) -or -not (Test-Path $htmlFile)) { throw 'Invalid Director folder. Expected __init__.py and web\audio-studio.html' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $target ('final-render-backup-' + $stamp)
New-Item -ItemType Directory -Path $backup | Out-Null
Copy-Item $init (Join-Path $backup '__init__.py')
Copy-Item $htmlFile (Join-Path $backup 'audio-studio.html')
if (Test-Path $bridge) { Copy-Item $bridge (Join-Path $backup 'final_render_bridge.py') }
$url = 'https://raw.githubusercontent.com/leeunwin2024/UNWIN-MiniMax-Director/main/integration/final_render_bridge.py'
Invoke-WebRequest -Uri $url -OutFile $bridge
$utf8 = [Text.UTF8Encoding]::new($false)
$initText = [IO.File]::ReadAllText($init)
if (-not $initText.Contains("'final_render_bridge'")) {
 $anchor = "'chatterbox_bridge'"
 if (-not $initText.Contains($anchor)) { throw 'Unexpected __init__.py format; backed up but no UI changes made' }
 $initText = $initText.Replace($anchor, $anchor + ", 'final_render_bridge'")
 [IO.File]::WriteAllText($init,$initText,$utf8)
}
$html = [IO.File]::ReadAllText($htmlFile)
if (-not $html.Contains('id="final-render-button"')) {
 $anchor = '<section id="timeline"'
 if (-not $html.Contains($anchor)) { throw 'Unexpected Audio Studio layout; no HTML changes made' }
 $panel = @'
<section id="final-render-panel" class="hidden">
<h2>Final Render — Video + Narration</h2>
<p>Automatically collect completed shots from this project, or enter output-relative video paths below. Clips are joined in order; the assembled master narration replaces scene audio.</p>
<label>Optional completed clip paths, comma-separated (leave empty for automatic project job lookup)</label>
<input type="text" id="final-render-clips" placeholder="UNWIN/shot1.mp4, UNWIN/shot2.mp4">
<div class="row"><label><input type="checkbox" id="final-render-loop" checked> Repeat finished video if narration is longer</label><button id="final-render-button">Final Render — Export MP4</button></div>
<p id="final-render-result" class="hint"></p>
</section>
'@
 $html = $html.Replace($anchor,$panel + $anchor)
 $showAnchor = 'updateRoster()}'
 if (-not $html.Contains($showAnchor)) { throw 'Unexpected show() function; cannot add panel visibility' }
 $html = $html.Replace($showAnchor, "if(\$('final-render-panel'))\$('final-render-panel').classList.toggle('hidden',!project);" + $showAnchor)
 $jsAnchor = "\$('export').onclick="
 if (-not $html.Contains($jsAnchor)) { throw 'Unexpected JavaScript layout; cannot attach button' }
 $handler = @'
$('final-render-button').onclick=async()=>{
 const btn=$('final-render-button');
 try {
  if(!project)throw Error('Create a project first');
  const clips=$('final-render-clips').value.split(',').map(s=>s.trim()).filter(Boolean);
  btn.disabled=true;
  status('Final render running locally. This may take several minutes...');
  const j=await post('final-render',{id:project.id,clips,loop_to_audio:$('final-render-loop').checked});
  const target=$('final-render-result');
  target.replaceChildren();
  const a=document.createElement('a');a.href=j.view_url;a.target='_blank';a.rel='noopener';a.textContent='Play finished MP4 — '+j.filename;
  target.append(a);
  status('Final Render complete: '+j.filename+' · '+j.clips.length+' clip(s). Lip-sync not applied.');
 }catch(e){status('Final Render failed: '+e.message)}
 finally{btn.disabled=false}
};
'@
 $html = $html.Replace($jsAnchor,$handler + $jsAnchor)
 [IO.File]::WriteAllText($htmlFile,$html,$utf8)
}
Write-Host "Final Render interface installed. Backup: $backup" -ForegroundColor Green
Write-Host 'Restart ComfyUI Desktop, then open http://localhost:8188/unwin/audio-studio'
