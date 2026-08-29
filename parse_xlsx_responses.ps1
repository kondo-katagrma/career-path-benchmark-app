param(
  [Parameter(Mandatory=$true)][string]$InDir,   # folder of *.xlsx (each = one 法人 の フォーマット)
  [Parameter(Mandatory=$true)][string]$OutDir   # folder to write response-sheet CSVs (UTF-8)
)
# 各xlsxから「アンケート回答シート」を自動検出し、UTF-8 CSVで書き出す。
# Excel COMは大きいファイルで失敗するため使わず、ZIP+XMLで直接解析する。
# PIIは一切表示せず、CSVはローカルに保存するだけ（呼び出し側で集計）。
$ErrorActionPreference="Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
New-Item -ItemType Directory -Force $OutDir | Out-Null
function ColIdx($ref){ $m=[regex]::Match($ref,'^([A-Z]+)'); $s=$m.Groups[1].Value; $n=0; foreach($ch in $s.ToCharArray()){ $n=$n*26 + ([int][char]$ch - 64) }; return $n }
function ReadEntryText($zip,$name){ $e=$zip.GetEntry($name); if(-not $e){return $null}; $sr=New-Object System.IO.StreamReader($e.Open(),[System.Text.Encoding]::UTF8); $t=$sr.ReadToEnd(); $sr.Dispose(); return $t }
function CsvQuote($s){ if($null -eq $s){return '""'}; return '"' + ($s -replace '"','""') + '"' }

Get-ChildItem $InDir -Filter *.xlsx | ForEach-Object {
  $name=$_.BaseName; $csvOut=Join-Path $OutDir ($name+".csv")
  try {
    $zip=[System.IO.Compression.ZipFile]::OpenRead($_.FullName)
    $shared=@(); $ssTxt=ReadEntryText $zip 'xl/sharedStrings.xml'
    if($ssTxt){ [xml]$ss=$ssTxt; foreach($si in $ss.GetElementsByTagName('si')){ $sb=''; foreach($t in $si.GetElementsByTagName('t')){ $sb+=$t.InnerText }; $shared+=$sb } }
    $sheetEntries=$zip.Entries | Where-Object { $_.FullName -match '^xl/worksheets/sheet\d+\.xml$' } | Sort-Object FullName
    $respXml=$null; $best=-1
    foreach($se in $sheetEntries){
      $txt=ReadEntryText $zip $se.FullName
      $m=[regex]::Match($txt,'<row r="1"[^>]*>(.*?)</row>',[System.Text.RegularExpressions.RegexOptions]::Singleline)
      if(-not $m.Success){ continue }
      $rowx=$m.Groups[1].Value; $hdr=''
      foreach($cm in [regex]::Matches($rowx,'<c\b[^>]*?>(.*?)</c>',[System.Text.RegularExpressions.RegexOptions]::Singleline)){
        $cx=$cm.Value; $inner=$cm.Groups[1].Value
        if($cx -match 't="s"'){ $vm=[regex]::Match($inner,'<v>(\d+)</v>'); if($vm.Success){ $ii=[int]$vm.Groups[1].Value; if($ii -lt $shared.Count){ $hdr+=$shared[$ii]+'|' } } }
        elseif($cx -match 't="inlineStr"'){ $im=[regex]::Match($inner,'<t[^>]*>([^<]*)</t>'); if($im.Success){ $hdr+=$im.Groups[1].Value+'|' } }
        else { $vm=[regex]::Match($inner,'<v>([^<]*)</v>'); if($vm.Success){ $hdr+=$vm.Groups[1].Value+'|' } }
      }
      $score=0; if($hdr -match '役職'){$score++}; if($hdr -match '勤続'){$score++}; if($hdr -match '雇用形態'){$score++}; if($hdr -match '満足'){$score++}; if($hdr -match '経験年数'){$score++}
      if($score -ge 3 -and $score -gt $best){ $best=$score; $respXml=$txt }
    }
    if(-not $respXml){ $zip.Dispose(); "NO-RESP  $name"; return }
    [xml]$sx=$respXml
    $rowsOut=New-Object System.Collections.Generic.List[string]
    foreach($row in $sx.GetElementsByTagName('row')){
      $cells=@{}
      foreach($c in $row.GetElementsByTagName('c')){
        $ref=$c.GetAttribute('r'); if(-not $ref){continue}; $ci=ColIdx $ref; $t=$c.GetAttribute('t'); $val=''
        $vn=$c.GetElementsByTagName('v')
        if($t -eq 'inlineStr'){ $isn=$c.GetElementsByTagName('t'); if($isn.Count){ $val=$isn[0].InnerText } }
        elseif($vn.Count){ $raw=$vn[0].InnerText; if($t -eq 's'){ $ii=[int]$raw; if($ii -lt $shared.Count){$val=$shared[$ii]} } else { $val=$raw } }
        $cells[$ci]=$val
      }
      if($cells.Count -eq 0){ continue }
      $max=($cells.Keys | Measure-Object -Maximum).Maximum
      $line=@(); for($i=1;$i -le $max;$i++){ $line += (CsvQuote ([string]$cells[$i])) }
      $rowsOut.Add($line -join ',')
    }
    $zip.Dispose()
    [System.IO.File]::WriteAllLines($csvOut, $rowsOut, (New-Object System.Text.UTF8Encoding($false)))
    "OK  $name  rows=$($rowsOut.Count-1)"
  } catch { "ERR $name : $($_.Exception.Message)" }
}
