param([string]$RespDir, [string]$OutJson, [string[]]$Exclude=@('バルツァ','芦屋'), [int]$MinN=5)
# 匿名ベースライン(全法人の集計値のみ・個票/PIIなし)をJSON化。ブラウザアプリに埋め込む。
$ErrorActionPreference="Stop"
function ParseYear($v){ if([string]::IsNullOrWhiteSpace($v)){return $null}; $v=$v.Trim(); switch -Regex ($v){ '^(\d+)年$'{return [double]$matches[1]} '11\s*[～~]\s*15'{return 13.0} '16\s*年?\s*[～~]\s*20'{return 18.0} '20年以上'{return 22.0} '^(\d+)$'{return [double]$matches[1]} default{ if($v -match '(\d+)'){return [double]$matches[1]} else {return $null} } } }
function Col($row,$kw){ foreach($p in $row.psobject.Properties.Name){ if($p -match $kw){ return $p } }; return $null }
function Med($v){ $v=@($v|Where-Object{$_ -ne $null}|Sort-Object); if(-not $v.Count){return $null}; if($v.Count%2-eq1){$v[[int](($v.Count-1)/2)]}else{($v[$v.Count/2-1]+$v[$v.Count/2])/2} }
function RoleSeg($v){ if([string]::IsNullOrWhiteSpace($v)){return '一般'}; if($v -match '園長|副園長|施設長|管理者|児発管|本部'){'管理職'}elseif($v -match '副主任|副主幹|リーダー'){'ミドル'}elseif($v -match '主任|主幹'){'主任'}else{'一般'} }
$satSet='非常に満足','満足','やや満足','やや不満','非常に不満'

# themes: field(y/k/g/req), seg(null=全体), regex
$themes=@(
 @{key='spec_goal';label='専門性を高めたい・スペシャリストを目指したい';field='g';seg=$null;re='スペシャリスト|専門(性|家|リーダー)|極め|発達|食育|療育|資格'},
 @{key='mgr_goal';label='管理職・マネジメントを目指したい';field='g';seg=$null;re='マネジメント|主任|園長|管理|まとめ|リーダーに|運営|統括'},
 @{key='role_clear';label='自分の役割・職務をより明確にしたい';field='k';seg=$null;re='役割|何を(すれ|し)|どこまで|範囲|曖昧|明確で(は)?な|立場'},
 @{key='efficiency';label='業務の進め方・見える化を工夫したい';field='k';seg=$null;re='時間(が|の)|効率|余裕|忙|事務|見える化|段取'},
 @{key='self_growth';label='自ら学び成長したい（前向きさ）';field='k';seg=$null;re='自分(の|が|に)|スキル|学び|勉強|自信|経験(を|が)'},
 @{key='dialog_req';label='上司と一緒にキャリアを考えたい';field='req';seg=$null;re='面談|1on1|話す(機会|時間)|一緒に考え|相談(できる|する機会|の場)'},
 @{key='eval_req';label='評価への言及';field='req';seg=$null;re='評価|フィードバック|認め(て|られ)'},
 @{key='mid_yarigai_ikusei';label='ミドル層:やりがいが育成・他者に向く';field='y';seg=@('ミドル');re='後輩|育成|指導|職員(の|を)|仲間|チーム|相談(に|され|を受)|まとめ|フォロー|全体を(見|把握)'},
 @{key='chief_yarigai_ikusei';label='主任層:やりがいが育成・他者に向く';field='y';seg=@('主任');re='後輩|育成|指導|職員(の|を)|仲間|チーム|相談(に|され|を受)|まとめ|フォロー|全体を(見|把握)'},
 @{key='chiefmid_ikusei_kadai';label='主任・ミドル:育成の進め方を考えている';field='k';seg=@('主任','ミドル');re='後輩|育成|指導|伝え方|伝わら|任せ|どう伝え'}
)

$quantVals=@{regPct=@();nonPct=@();ctrPct=@();noRolePct=@();tenAvg=@();expAvg=@();chutoPct=@();satPos=@();devPct=@()}
$pool=@()  # people for qual
$lawCount=0
Get-ChildItem $RespDir -Filter *.csv | ForEach-Object {
  $nm=$_.BaseName
  if($nm -match '大元|商談用|保存用'){ return }
  if($Exclude | Where-Object { $nm -match $_ }){ return }
  try{ $rows=Import-Csv $_.FullName -Encoding UTF8 }catch{ return }
  if(-not $rows -or $rows.Count -lt $MinN){ return }
  $r0=$rows[0]; $cEmp=Col $r0 '雇用形態'; $cRole=Col $r0 '役職'; $cTen=Col $r0 '勤続'; $cExp=Col $r0 '経験年数'; $cSkill=Col $r0 '学びたいテーマ|取得したい'; $cY=Col $r0 'やりがい'; $cK=Col $r0 '改善が必要'; $cG=Col $r0 '目標を教え'; $cReq=Col $r0 '要望や提案'
  if(-not $cTen -or -not $cExp){ return }
  $key= if($cEmp){$cEmp}elseif($cRole){$cRole}else{$cTen}
  $rows=@($rows | Where-Object { -not [string]::IsNullOrWhiteSpace($_.$key) })
  if($rows.Count -lt $MinN){ return }
  $lawCount++
  $n=$rows.Count
  $cSat=$null; foreach($p in $r0.psobject.Properties.Name){ $h=($rows|ForEach-Object{$_.$p}|Where-Object{$satSet -contains $_}).Count; if($h -ge [Math]::Max(2,$n*0.3)){ $cSat=$p; break } }
  if($cEmp){ $reg=0;$non=0;$ctr=0; foreach($r in $rows){ $e=$r.$cEmp; if($e -match '正社員|正規'){$reg++}elseif($e -match '契約|年俸'){$ctr++}else{$non++} }; $quantVals.regPct+=[math]::Round(100*$reg/$n,1);$quantVals.nonPct+=[math]::Round(100*$non/$n,1);$quantVals.ctrPct+=[math]::Round(100*$ctr/$n,1) }
  if($cRole){ $quantVals.noRolePct+=[math]::Round(100*(($rows|Where-Object{$_.$cRole -match 'なし|一般'}).Count)/$n,1) }
  $ten=@();$exp=@();$ch=0;$bo=0; foreach($r in $rows){ $t=ParseYear $r.$cTen;$x=ParseYear $r.$cExp; if($t){$ten+=$t}; if($x){$exp+=$x}; if($t -and $x){$bo++; if($x -gt $t){$ch++}} }
  if($ten.Count){$quantVals.tenAvg+=[math]::Round(($ten|Measure-Object -Average).Average,2)}
  if($exp.Count){$quantVals.expAvg+=[math]::Round(($exp|Measure-Object -Average).Average,2)}
  if($bo){$quantVals.chutoPct+=[math]::Round(100*$ch/$bo,1)}
  if($cSat){ $a=($rows|Where-Object{$satSet -contains $_.$cSat}).Count; $pp=($rows|Where-Object{@('非常に満足','満足','やや満足') -contains $_.$cSat}).Count; if($a){$quantVals.satPos+=[math]::Round(100*$pp/$a,1)} }
  if($cSkill){ $a=($rows|Where-Object{-not [string]::IsNullOrWhiteSpace($_.$cSkill)}).Count; $h=($rows|Where-Object{$_.$cSkill -match '発達|療育|障害|インクルーシブ|グレー|加配'}).Count; if($a){$quantVals.devPct+=[math]::Round(100*$h/$a,1)} }
  foreach($r in $rows){ $pool += [pscustomobject]@{ seg=(RoleSeg ($(if($cRole){$r.$cRole}else{''}))); y=$(if($cY){$r.$cY}else{''}); k=$(if($cK){$r.$cK}else{''}); g=$(if($cG){$r.$cG}else{''}); req=$(if($cReq){$r.$cReq}else{''}) } }
}
function QStat($arr){ if(-not $arr.Count){return $null}; @{ median=[math]::Round((Med $arr),1); mean=[math]::Round(($arr|Measure-Object -Average).Average,1); min=($arr|Measure-Object -Minimum).Minimum; max=($arr|Measure-Object -Maximum).Maximum } }
$quant=@{}; foreach($k in $quantVals.Keys){ $quant[$k]=QStat $quantVals[$k] }
$qual=@()
foreach($t in $themes){ $set= if($t.seg){ $pool|Where-Object{$t.seg -contains $_.seg} } else { $pool }; $ans=@($set|Where-Object{-not [string]::IsNullOrWhiteSpace($_.($t.field))}); $pct=$null; if($ans.Count){ $pct=[math]::Round(100*(@($ans|Where-Object{$_.($t.field) -match $t.re}).Count)/$ans.Count,1) }; $qual += @{ key=$t.key; label=$t.label; field=$t.field; seg=$t.seg; regex=$t.re; basePct=$pct; baseN=$ans.Count } }
$obj=[ordered]@{ generatedAt=(Get-Date -Format 'yyyy-MM-dd'); lawCount=$lawCount; peopleCount=$pool.Count; quant=$quant; qual=$qual }
$json=$obj | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($OutJson, $json, (New-Object System.Text.UTF8Encoding($false)))
"baseline.json written: lawCount=$lawCount peopleCount=$($pool.Count)"
