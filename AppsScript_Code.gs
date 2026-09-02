/**
 * キャリアパス アンケート傾向ベンチマーク — データ取得用 Web アプリ（Apps Script）
 *
 * 役割：
 *  1) スプレッドシートIDを受け取り、回答シートを自動検出して「集計値だけ」を返す（貴法人側）。
 *  2) マスターフォルダ配下の全法人フォルダを走査し、ベースライン（他法人の集計値）を
 *     算出してキャッシュする（全法人側）。マスターフォルダに新しい法人が増えるたびに
 *     自動で反映される（毎日1回の自動更新トリガー、または手動再計算）。
 *
 * 氏名などの個人情報（PII）は集計に使うだけで、外部（ブラウザ）には一切返さない。
 *
 * 使い方：カタグルマのGoogleアカウントでこのスクリプトを Web アプリとしてデプロイし、
 *         発行された URL を index.html の WEBAPP_URL に設定する（手順は DEPLOY.md）。
 *         初回のみエディタから setupBaseline() を1回実行して、キャッシュ作成と
 *         毎日自動更新トリガーの設定を行う（Driveへのアクセス許可を求められたら許可する）。
 */

// 権限承認トリガー用。関数一覧の一番上に出るよう、あえてここに置いている（エディタから一度だけ実行する）。
function AAA_runThisToAuthorize(){
  var t=extractDeckText('1EK8tdqz8hkVUZAIq8JxwrfE6gKQuMDY6');
  Logger.log('OK: '+t.length+'文字読み込めました');
}

// ==== 設定 ====
// マスターフォルダ（法人ごとのサブフォルダが並ぶ、案件が随時増えていくフォルダ）
var MASTER_FOLDER_ID = '1XsLinjqF1Ht4H1wRoJGSyWMaf3mh0OR-';
// ベースラインから常に除外したい法人名の部分一致（進行中で回答が固まっていない案件など。カンマ区切り）
// スクリプトプロパティ BASELINE_EXCLUDE_NAMES で上書き可能（例: "バルツァ,芦屋"）
var DEFAULT_EXCLUDE_NAMES = ['バルツァ','芦屋'];
var MIN_N = 5; // この人数未満の法人はベースラインから除外
var BASELINE_CACHE_KEY = 'BASELINE_CACHE_V1';
var BASELINE_CACHE_AT_KEY = 'BASELINE_CACHE_AT_V1';
// 法人ごとの集計値（自己除外の都度計算をDriveスキャンなしで一瞬で行うためのキャッシュ）。
// スクリプトプロパティ1件あたり9KBの上限があるため、必要ならチャンク分割して保存する。
var FIRM_RECORDS_CHUNK_PREFIX = 'FIRM_RECORDS_V1_';
var FIRM_RECORDS_COUNT_KEY = 'FIRM_RECORDS_V1_COUNT';
var CHUNK_SIZE = 8000;

// ==== 質的テーマ（index.html の baseline と同一定義） ====
var THEMES = [
 {key:'spec_goal',label:'専門性を高めたい・スペシャリストを目指したい',field:'g',seg:null,re:'スペシャリスト|専門(性|家|リーダー)|極め|発達|食育|療育|資格'},
 {key:'mgr_goal',label:'管理職・マネジメントを目指したい',field:'g',seg:null,re:'マネジメント|主任|園長|管理|まとめ|リーダーに|運営|統括'},
 {key:'role_clear',label:'自分の役割・職務をより明確にしたい',field:'k',seg:null,re:'役割|何を(すれ|し)|どこまで|範囲|曖昧|明確で(は)?な|立場'},
 {key:'efficiency',label:'業務の進め方・見える化を工夫したい',field:'k',seg:null,re:'時間(が|の)|効率|余裕|忙|事務|見える化|段取'},
 {key:'self_growth',label:'自ら学び成長したい（前向きさ）',field:'k',seg:null,re:'自分(の|が|に)|スキル|学び|勉強|自信|経験(を|が)'},
 {key:'dialog_req',label:'上司と一緒にキャリアを考えたい',field:'req',seg:null,re:'面談|1on1|話す(機会|時間)|一緒に考え|相談(できる|する機会|の場)'},
 {key:'eval_req',label:'評価への言及',field:'req',seg:null,re:'評価|フィードバック|認め(て|られ)'},
 {key:'mid_yarigai_ikusei',label:'ミドル層:やりがいが育成・他者に向く',field:'y',seg:['ミドル'],re:'後輩|育成|指導|職員(の|を)|仲間|チーム|相談(に|され|を受)|まとめ|フォロー|全体を(見|把握)'},
 {key:'chief_yarigai_ikusei',label:'主任層:やりがいが育成・他者に向く',field:'y',seg:['主任'],re:'後輩|育成|指導|職員(の|を)|仲間|チーム|相談(に|され|を受)|まとめ|フォロー|全体を(見|把握)'},
 {key:'chiefmid_ikusei_kadai',label:'主任・ミドル:育成の進め方を考えている',field:'k',seg:['主任','ミドル'],re:'後輩|育成|指導|伝え方|伝わら|任せ|どう伝え'}
];
var SAT=['非常に満足','満足','やや満足','やや不満','非常に不満'], POS=['非常に満足','満足','やや満足'];

function parseYear(v){ if(v==null) return null; v=(''+v).trim(); if(!v) return null; var m;
 if(m=v.match(/^(\d+)年$/)) return +m[1]; if(/11\s*[～~]\s*15/.test(v)) return 13; if(/16\s*年?\s*[～~]\s*20/.test(v)) return 18; if(/20年以上/.test(v)) return 22; if(m=v.match(/(\d+)/)) return +m[1]; return null; }
function roleSeg(v){ v=v||''; if(/園長|副園長|施設長|管理者|児発管|本部/.test(v)) return '管理職'; if(/副主任|副主幹|リーダー/.test(v)) return 'ミドル'; if(/主任|主幹/.test(v)) return '主任'; return '一般'; }
function findCol(keys,re){ for(var i=0;i<keys.length;i++){ if(re.test(keys[i])) return keys[i]; } return null; }
function round1(x){ return Math.round(x*10)/10; }
function median(arr){ var a=arr.filter(function(x){return x!=null;}).slice().sort(function(x,y){return x-y;}); if(!a.length) return null; var m=Math.floor(a.length/2); return a.length%2 ? a[m] : (a[m-1]+a[m])/2; }
function mean(arr){ if(!arr.length) return null; var s=0; for(var i=0;i<arr.length;i++) s+=arr[i]; return s/arr.length; }

// ---- テンプレート/対象外ファイル名の除外パターン ----
// 「〇〇御中】キャリアパス策定支援フォーマット」は各法人の実回答ファイル名なので除外しない。
// 除外するのはマスター雛形・商談用サンプル・保存用コピーなど、"大元"側のファイルのみ。
var SKIP_FILE_NAME_RE = /大元|商談用|保存用/;

function pickResponseRowsFromSheet(ss){
  var sheets=ss.getSheets();
  for(var s=0;s<sheets.length;s++){
    var sh=sheets[s]; var lc=sh.getLastColumn(); if(lc<3) continue;
    var hdr=sh.getRange(1,1,1,lc).getValues()[0].join('|');
    if(/役職/.test(hdr) && /勤続/.test(hdr)){
      var data=sh.getDataRange().getValues(); if(data.length<2) continue;
      var head=data[0].map(function(x){return ''+x;});
      var rows=[]; for(var r=1;r<data.length;r++){ var o={}; for(var c=0;c<head.length;c++){ o[head[c]]=data[r][c]; } rows.push(o); }
      if(rows.length) return rows;
    }
  }
  return null;
}

// フォルダ内（1階層下のサブフォルダも含む）のGoogleスプレッドシートから、回答シートを探す
function findResponseRowsInFolder(folder){
  var files=folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while(files.hasNext()){
    var f=files.next();
    var name=f.getName();
    if(SKIP_FILE_NAME_RE.test(name)) continue;
    try{
      var rows=pickResponseRowsFromSheet(SpreadsheetApp.open(f));
      if(rows && rows.length) return rows;
    }catch(e){ /* 開けないファイルはスキップ */ }
  }
  // 1階層下のサブフォルダも見る（年度別フォルダ等の運用に対応）
  var subs=folder.getFolders();
  while(subs.hasNext()){
    var sub=subs.next();
    var rows2=findResponseRowsInFolder2(sub);
    if(rows2) return rows2;
  }
  return null;
}
function findResponseRowsInFolder2(folder){
  var files=folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while(files.hasNext()){
    var f=files.next();
    if(SKIP_FILE_NAME_RE.test(f.getName())) continue;
    try{
      var rows=pickResponseRowsFromSheet(SpreadsheetApp.open(f));
      if(rows && rows.length) return rows;
    }catch(e){}
  }
  return null;
}

function analyzeRows(rows){
  var keys=Object.keys(rows[0]);
  var cEmp=findCol(keys,/雇用形態/),cRole=findCol(keys,/役職/),cTen=findCol(keys,/勤続/),cExp=findCol(keys,/経験年数/),
      cSkill=findCol(keys,/学びたいテーマ|取得したい/),cY=findCol(keys,/やりがい/),cK=findCol(keys,/改善が必要/),cG=findCol(keys,/目標を教え/),cReq=findCol(keys,/要望や提案/);
  var key=cEmp||cRole||cTen;
  rows=rows.filter(function(r){return (''+(r[key]||'')).trim()!=='';});
  var n=rows.length; var q={n:n};
  var cSat=null; for(var i=0;i<keys.length;i++){ var p=keys[i]; var h=rows.filter(function(r){return SAT.indexOf((''+r[p]).trim())>=0;}).length; if(h>=Math.max(2,n*0.3)){cSat=p;break;} }
  if(cEmp){ var reg=0,non=0,ctr=0; rows.forEach(function(r){var e=''+r[cEmp]; if(/正社員|正規/.test(e))reg++; else if(/契約|年俸/.test(e))ctr++; else non++;}); q.regPct=round1(100*reg/n);q.nonPct=round1(100*non/n);q.ctrPct=round1(100*ctr/n); }
  if(cRole){ q.noRolePct=round1(100*rows.filter(function(r){return /なし|一般/.test(''+r[cRole]);}).length/n); }
  var ten=[],exp=[],ch=0,bo=0; rows.forEach(function(r){var t=parseYear(r[cTen]),x=parseYear(r[cExp]); if(t!=null)ten.push(t); if(x!=null)exp.push(x); if(t!=null&&x!=null){bo++; if(x>t)ch++;}});
  if(ten.length) q.tenAvg=Math.round(mean(ten)*100)/100;
  if(exp.length) q.expAvg=Math.round(mean(exp)*100)/100;
  if(bo) q.chutoPct=round1(100*ch/bo);
  if(cSat){ var a=rows.filter(function(r){return SAT.indexOf((''+r[cSat]).trim())>=0;}).length, pp=rows.filter(function(r){return POS.indexOf((''+r[cSat]).trim())>=0;}).length; if(a) q.satPos=round1(100*pp/a); }
  if(cSkill){ var a2=rows.filter(function(r){return (''+r[cSkill]).trim()!=='';}).length, h2=rows.filter(function(r){return /発達|療育|障害|インクルーシブ|グレー|加配/.test(''+r[cSkill]);}).length; if(a2) q.devPct=round1(100*h2/a2); }
  var people=rows.map(function(r){ return {seg:roleSeg(''+(cRole?r[cRole]:'')), y:cY?''+r[cY]:'', k:cK?''+r[cK]:'', g:cG?''+r[cG]:'', req:cReq?''+r[cReq]:''}; });
  var qual={}, qualCounts={};
  THEMES.forEach(function(t){ var set=t.seg?people.filter(function(p){return t.seg.indexOf(p.seg)>=0;}):people; var ans=set.filter(function(p){return (''+p[t.field]).trim()!=='';}); var re=new RegExp(t.re); var matched=ans.filter(function(p){return re.test(p[t.field]);}).length; var pct=ans.length?round1(100*matched/ans.length):null; qual[t.key]={pct:pct,n:ans.length}; qualCounts[t.key]=[ans.length,matched]; });
  return {q:q, qual:qual, qualCounts:qualCounts, people:people};   // 集計値のみ（PIIなし）。peopleは呼び出し元でベースライン集計にのみ使う。
}

function getExcludeNames(){
  var prop=PropertiesService.getScriptProperties().getProperty('BASELINE_EXCLUDE_NAMES');
  var names=DEFAULT_EXCLUDE_NAMES.slice();
  if(prop){ prop.split(',').forEach(function(s){ s=s.trim(); if(s) names.push(s); }); }
  return names;
}

// マスターフォルダ配下の法人フォルダを走査し、法人ごとの集計値（レコード）を作る。
// Driveスキャンが必要な唯一の重い処理。除外は名前ベースのものだけをここで適用し、
// 「特定の1法人を除外」は軽量な aggregateFirmRecords 側で行う（都度Driveを再走査しないため）。
function computeFirmRecords(){
  var master=DriveApp.getFolderById(MASTER_FOLDER_ID);
  var excludeNames=getExcludeNames();
  var records=[];
  var subs=master.getFolders();
  while(subs.hasNext()){
    var sub=subs.next();
    var name=sub.getName();
    var skip=false; for(var i=0;i<excludeNames.length;i++){ if(excludeNames[i] && name.indexOf(excludeNames[i])>=0){ skip=true; break; } }
    if(skip) continue;
    var rows;
    try{ rows=findResponseRowsInFolder(sub); }catch(e){ rows=null; }
    if(!rows || rows.length<MIN_N) continue;
    var res;
    try{ res=analyzeRows(rows); }catch(e){ continue; }
    if(res.q.n<MIN_N) continue;
    records.push({ id:sub.getId(), name:name, n:res.q.n, q:res.q, qc:res.qualCounts });
  }
  return records;
}

// 法人レコードの配列から、指定の1法人（excludeFolderId）を除いて集計する。Driveアクセスなし・一瞬で終わる。
function aggregateFirmRecords(records, excludeFolderId){
  var quantVals={regPct:[],nonPct:[],ctrPct:[],noRolePct:[],tenAvg:[],expAvg:[],chutoPct:[],satPos:[],devPct:[]};
  var qualAgg={}; THEMES.forEach(function(t){ qualAgg[t.key]={ans:0,matched:0}; });
  var lawCount=0, peopleCount=0, firms=[];
  records.forEach(function(rec){
    if(excludeFolderId && rec.id===excludeFolderId) return;
    lawCount++; peopleCount+=rec.n; firms.push({name:rec.name, n:rec.n});
    Object.keys(quantVals).forEach(function(k){ if(rec.q[k]!=null) quantVals[k].push(rec.q[k]); });
    THEMES.forEach(function(t){ var c=rec.qc[t.key]; if(c){ qualAgg[t.key].ans+=c[0]; qualAgg[t.key].matched+=c[1]; } });
  });
  var quant={};
  Object.keys(quantVals).forEach(function(k){
    var arr=quantVals[k];
    quant[k]= arr.length ? {median:round1(median(arr)), mean:round1(mean(arr)), min:Math.min.apply(null,arr), max:Math.max.apply(null,arr)} : null;
  });
  var qual=[];
  THEMES.forEach(function(t){
    var a=qualAgg[t.key];
    qual.push({key:t.key,label:t.label,field:t.field,seg:t.seg,regex:t.re,basePct:a.ans?round1(100*a.matched/a.ans):null,baseN:a.ans});
  });
  return { generatedAt:Utilities.formatDate(new Date(),'Asia/Tokyo','yyyy-MM-dd HH:mm'), lawCount:lawCount, peopleCount:peopleCount, quant:quant, qual:qual, firms:firms };
}

function saveFirmRecordsCache(records){
  var props=PropertiesService.getScriptProperties();
  // 前回分のチャンクを掃除
  var prevCount=+(props.getProperty(FIRM_RECORDS_COUNT_KEY)||0);
  for(var i=0;i<prevCount;i++){ props.deleteProperty(FIRM_RECORDS_CHUNK_PREFIX+i); }
  var json=JSON.stringify(records);
  var chunks=[]; for(var p=0;p<json.length;p+=CHUNK_SIZE){ chunks.push(json.slice(p,p+CHUNK_SIZE)); }
  chunks.forEach(function(c,i){ props.setProperty(FIRM_RECORDS_CHUNK_PREFIX+i, c); });
  props.setProperty(FIRM_RECORDS_COUNT_KEY, String(chunks.length));
}
function loadFirmRecordsCache(){
  var props=PropertiesService.getScriptProperties();
  var count=+(props.getProperty(FIRM_RECORDS_COUNT_KEY)||0);
  if(!count) return null;
  var parts=[]; for(var i=0;i<count;i++){ parts.push(props.getProperty(FIRM_RECORDS_CHUNK_PREFIX+i)||''); }
  try{ return JSON.parse(parts.join('')); }catch(e){ return null; }
}

// 毎日の自動更新トリガーから呼ばれる。Driveを走査して法人別レコードと、除外なし版の集計キャッシュを作り直す。
function refreshBaselineCache(){
  var records=computeFirmRecords();
  saveFirmRecordsCache(records);
  var base=aggregateFirmRecords(records, null);
  var props=PropertiesService.getScriptProperties();
  props.setProperty(BASELINE_CACHE_KEY, JSON.stringify(base));
  props.setProperty(BASELINE_CACHE_AT_KEY, new Date().toISOString());
  return base;
}

// 管理者が初回に1回だけエディタから実行するセットアップ関数。
// キャッシュを作成し、毎日3時(JST)に自動更新するトリガーを設定する。
function setupBaseline(){
  // 既存の同名トリガーがあれば一旦削除してから作り直す（二重登録防止）
  var triggers=ScriptApp.getProjectTriggers();
  for(var i=0;i<triggers.length;i++){
    if(triggers[i].getHandlerFunction()==='refreshBaselineCache'){ ScriptApp.deleteTrigger(triggers[i]); }
  }
  ScriptApp.newTrigger('refreshBaselineCache').timeBased().everyDays(1).atHour(3).inTimezone('Asia/Tokyo').create();
  var base=refreshBaselineCache();
  Logger.log('セットアップ完了: lawCount=%s peopleCount=%s', base.lawCount, base.peopleCount);
  return base;
}

// ==== 第1回・第2回資料（pptx/Googleスライド）からのテキスト抽出 ====
// fileId のファイルがGoogleスライドでなければ、一時的にGoogleスライド形式へ変換コピーして読み取り、
// 読み取り後に一時コピーは削除する（元ファイルは一切変更しない）。
function extractDeckText(fileId){
  var file=DriveApp.getFileById(fileId);
  var mime=file.getMimeType();
  var slidesId=fileId, tempId=null;
  if(mime!==MimeType.GOOGLE_SLIDES){
    var copied=Drive.Files.copy({mimeType:MimeType.GOOGLE_SLIDES, name:'[一時変換] '+file.getName()}, fileId);
    tempId=copied.id; slidesId=tempId;
  }
  try{
    var pres=SlidesApp.openById(slidesId);
    var out=[];
    pres.getSlides().forEach(function(slide, idx){
      var texts=[];
      slide.getShapes().forEach(function(shape){
        try{ if(shape.getText){ var t=shape.getText().asString(); if(t && t.trim()) texts.push(t.trim()); } }catch(e){}
      });
      try{
        slide.getTables().forEach(function(table){
          var nr=table.getNumRows(), nc=table.getNumColumns();
          for(var r=0;r<nr;r++){
            var rowTexts=[];
            for(var c=0;c<nc;c++){ try{ var ct=table.getCell(r,c).getText().asString().trim(); if(ct) rowTexts.push(ct); }catch(e){} }
            if(rowTexts.length) texts.push(rowTexts.join(' | '));
          }
        });
      }catch(e){}
      if(texts.length) out.push('--- スライド'+(idx+1)+' ---\n'+texts.join('\n'));
    });
    return out.join('\n\n');
  } finally {
    if(tempId){ try{ DriveApp.getFileById(tempId).setTrashed(true); }catch(e){} }
  }
}

function fmtBaseRange(s,u){ if(!s) return '—'; return '中央'+s.median+(u||'')+'（範囲'+s.min+(u||'')+'〜'+s.max+(u||'')+'）'; }

// アンケート集計(target)・全法人ベースライン(base)・第1回/第2回資料テキストをまとめて、
// career-path-survey-analysis 等のSkillに準じた本格分析用プロンプトを組み立てる。
// 回答シートの生データから、氏名・タイムスタンプ列だけを除いた匿名の自由記述テキストを組み立てる。
// 属性列（施設名・役職・職種・雇用形態・勤続・経験年数など、短い選択式の値）は見出し行にまとめ、
// 自由記述の長文はその下に列挙する。貴法人（対象法人）のみに使う。他法人の生データは扱わない。
function buildAnonRespondentText(rows){
  if(!rows || !rows.length) return '（回答データなし）';
  var excludeRe=/氏名|タイムスタンプ/;
  var headRe=/施設名|役職|職種|雇用形態|勤続|経験年数|満足していますか/;
  var keys=Object.keys(rows[0]).filter(function(k){ return !excludeRe.test(k); });
  var L=[];
  rows.forEach(function(r,idx){
    var head=[], body=[];
    keys.forEach(function(k){
      var v=(''+(r[k]==null?'':r[k])).trim();
      if(!v) return;
      if(headRe.test(k) && v.length<=20){ head.push(k.replace(/[（(].*?[）)]/g,'')+':'+v); }
      else{ body.push('・'+k.replace(/[（(].*?[）)]/g,'').trim()+'：'+v); }
    });
    L.push('### 回答者'+(idx+1)+'（'+head.join('／')+'）');
    L.push(body.join('\n'));
    L.push('');
  });
  return L.join('\n');
}

function buildFullPrompt(lawName, target, base, deck1Text, deck2Text, respondentText){
  var QLABEL=[['n','回答者数',''],['regPct','正規職員','%'],['nonPct','非正規（パート・サポーター等）','%'],['ctrPct','契約社員（年俸制）','%'],['noRolePct','役職なし（一般）','%'],['tenAvg','平均勤続年数','年'],['expAvg','平均経験年数','年'],['chutoPct','中途（経験＞勤続）','%'],['satPos','研修満足（肯定）','%'],['devPct','発達支援への学習志向','%']];
  var L=[];
  L.push('# 役割');
  L.push('あなたは、保育・福祉分野を専門とするキャリアパス策定支援コンサルタントです。以下の資料をもとに、対象法人の決裁権者（理事長・園長など）に提出する「現状把握アンケート分析」レポートを、1つの完成文書として作成してください。');
  L.push('対象法人：'+(lawName||'（法人名）'));
  L.push('');
  L.push('以下の3種類の資料をすべて読み込んで分析してください。');
  L.push('①アンケートの匿名化された自由記述・集計値（貴法人 / 全法人ベースライン）');
  L.push('②第1回打合せ資料の全文（決裁権者への事前アンケート回答＋打合せでの深掘りヒアリング。目指したい組織像・職層方針・雇用形態や給与に関する意向などが含まれる）');
  L.push('③第2回打合せ資料の全文（ミドルリーダー数名へのヒアリング。現場の課題・必要な役割・権限委譲・働きたい相手像などが含まれる）');
  L.push('');
  L.push('## 使う前の確認');
  L.push('- 個人情報：①-3の自由記述は氏名・タイムスタンプを除外済み。アンケートは法人の実態そのものではなく「職員の書簡」として扱うこと。');
  L.push('- 回収率：回答者数が極端に少ない場合（例:在籍者数に対して著しく低い等）、決裁権者の指示や新たな取組に職員が協力的でない可能性として、総括で軽く触れる。');
  L.push('- 複数施設運営の場合：全体傾向だけでなく、施設ごとの傾向差も追加で分析する（3.やりがいと改善点でまとめて扱う。1.属性では職務内容・役割の差の話に留め、施設間のやりがい・課題感の違いを前倒しで書かない）。');
  L.push('');
  L.push('## レポート構成（1つの文書として。見出しは以下の順番・粒度で）');
  L.push('- 総括（2〜4点。①アンケート・②第1回資料・③第2回資料の3つを突き合わせた、最も重要な構造的発見。各項目に根拠を明記。まず結論、その後に根拠データを続ける）');
  L.push('- 1. 属性と職務内容・役割の傾向（役職別・施設別の違いを表形式で提示。「保育士が多い」のような業界共通の指摘は書かない）');
  L.push('- 2. 勤続年数と経験年数（役職別。表形式で提示。下記「勤続年数・経験年数・中途比率の解釈について」を必ず反映する）');
  L.push('- 3. やりがいと改善点（課題意識。役職別・施設別の対比。上位項目を挙げ理由を考察する）');
  L.push('- 4. 取得したいスキル・学びたいテーマ（件数の多い順にランキング表。経験年数・役職との関連にも触れる。発達支援・保護者支援は業界特性上どの法人でも上位に来やすい点を踏まえる）');
  L.push('- 5. キャリア目標の傾向とサポートの必要性（キャリア目標を掲げていない職員が多いのが一般的で、それ自体も一つの特徴として扱ってよい）');
  L.push('- 6. 研修・学びの機会に対する満足度（満足度の内訳を表形式で。今後受けたい研修の優先順位も示す）');
  L.push('- 7. 法人・上司へのキャリアに関する要望（回答数は少ない傾向にあるため、特徴的な要望があれば触れる程度でよい）');
  L.push('- 8. 提案：キャリアパス策定の方向性（具体的・実行可能な提案。第1回の決裁権者の意向、第2回のミドルリーダーの発言と直接紐づけて書く。専門職・分野別リーダー等の複線コースを提案する場合は、下記「複線設計の提案について」の但し書きを必ず添える）');
  L.push('- 9. 課題→打ち手対応表（下記「課題→打ち手対応表について」の形式で表にまとめる）');
  L.push('- 10. その他（キャリアパスに直接関係しないが、2件以上の回答者から挙がった要望・気になる点を最後にまとめる）');
  L.push('');
  L.push('## 最重要：3つの資料を常に突き合わせること');
  L.push('- 特に総括と8.提案は、アンケート単独の集計から書かず、必ず①アンケート・②第1回資料・③第2回資料の3つを突き合わせて書くこと。');
  L.push('- 同じ趣旨の指摘がアンケートの自由記述・第1回資料・第2回ヒアリングの複数にまたがって出ている場合は、それを最優先の構造課題として扱い、「〇〇という点は、アンケートの自由記述複数件、第2回ヒアリングの発言、第1回でうかがった意向のいずれからも共通して見られる」という形で、根拠が複数資料にまたがっていることを明記する。');
  L.push('- 逆に、アンケートだけ／ヒアリングだけにしか出てこない論点も、それはそれとして扱ってよい(無理に全資料に紐づけない)。');
  L.push('- 1〜7の各セクションも、関連する第1回・第2回の記述があれば積極的に引用・接続すること（8.提案だけに寄せない）。');
  L.push('- 第1回資料の中に、雇用形態のあり方や給与・等級制度そのものへの意向・悩みが含まれる場合、それは記録・言及に留め、その制度設計自体への助言はしない（本レポートの対象外）。');
  L.push('- 第1回資料の中に「思いやりを持って」「一般常識」のような情意的な要望が含まれる場合、それはキャリアパス（職務一覧）には組み込まず、「今後の評価項目策定で情意項目の候補として扱う」旨を総括または8.提案で一言添えるに留める。');
  L.push('');
  L.push('## 分析の質について（重要・必ず守ること）');
  L.push('- 数値で必ず裏付けること。定性的な言い回しだけで終わらせない。「〜を大きく上回っており」のような曖昧な表現は、必ず「平均○年(中央値○年)」のような具体的な数値に置き換える。');
  L.push('- 自由記述から制度上の仕組みを読み解くこと。同じ趣旨の指摘が複数の回答者から出ている場合、「処遇への不満」のような一般化で終わらせず、その背後にある具体的な制度・運用上の仕組みを再構成して明示する（例：「契約社員の年俸制が勤続8年で頭打ちになる」「副主任がクラス担任を兼務しているため権限委譲が進まない」等）。単一の回答者の声ではなく、複数回答からしか見えてこない「仕組み」を優先的に拾う。');
  L.push('- 役職別・施設別の対比を必ず行うこと。①-3の自由記述には回答者ごとに施設名・役職・職種が付いている。各セクションで、「一般職員では〜という記述が多い一方、主任・主幹層では〜」のように、役職（一般／ミドル・副主任等／主任・主幹／園長等の管理職）や施設による回答傾向の違い・共通点を積極的に拾うこと。役職者（主任・副主任・園長等）の回答は特に重視し、現場と管理層の間で見えているものにギャップがないかを確認すること。');
  L.push('- 設問の設計によって生まれる見かけ上の傾向を、組織の成果や特徴であるかのように書かないこと。例えば「改善が必要な点」という設問は回答者本人の内省を促す設計になっているため、回答が自己成長への言及に集中するのは設問上自然な結果であり、それ自体を「自分事化が非常に進んでいる」のようなポジティブな組織的特徴として強調しないこと（改善点の記述が法人への要望か自分の改善かは、あくまで一つの補助的な観察に留める）。');
  L.push('- そのかわり、①組織として構造的に未解決・未着手のまま残っている論点（同じ課題が複数施設・複数職層・複数資料にまたがって繰り返し語られている等）、②役職者（主任・副主任・管理職）の回答を踏まえたときに見える、現場との認識のギャップや改善余地、を優先して指摘すること。');
  L.push('- 「キャリアパス設計に効く構造課題」の観点で、データから該当する兆候がないか能動的に探して言語化すること。1. 役割・職務範囲の未定義（雇用形態間で職務範囲が違うのに定義されていない兆候）2. 職層（特にリーダー・中間職）の役割の曖昧さ 3. 評価の納得性・フィードバックの有無 4. 処遇の構造（頭打ち・資格や経験との不連動など） 5. 定着ドライバー（勤続と経験の乖離、勤続1年目の比率、施設別の定着差） 6. 育成体制（指導・育成の責任者不在、研修が現場に還流していない兆候） 7. キャリア志向の分布（専門性志向/管理職志向/現状維持志向の割合。単線か複線かの設計判断）。');
  L.push('');
  L.push('## 勤続年数・経験年数・中途比率の解釈について（2.のセクションで必ず反映する）');
  L.push('- 経験年数＝勤続年数はおおむね新卒入職、経験年数＞勤続年数は中途入職と読める。中途が多い場合は理念・方針の浸透や定着率に課題がある可能性がある。新卒が多い場合は理念の伝承はできているが、変化への抵抗が生まれやすい。新卒・中途どちらも勤続が短く中間層が薄い場合は、ベテラン層と若手層の断絶や、若手の意見の通りづらさが疑われる。');
  L.push('- パート職員の経験年数が長い場合、担任相当の業務を担っている可能性や、元正規職員である可能性がある。パート向け職務のレベルを一律に低く設定しすぎないよう注意を促す。');
  L.push('- 在籍年数が長い職員が多い場合、層は厚いが上が詰まり若手のキャリアアップが難しい可能性がある。育成の仕組み化への必要性を感じにくい可能性もある。');
  L.push('- 在籍年数が短い職員が多い場合、定着率の課題、または役職に求められる能力と実際に任命されている職員の能力とのギャップ（配置せざるを得ず任命している状態）が疑われる。キャリアパスと実態が乖離しやすい。');
  L.push('- これらは一般的な傾向であり、実際にどの含意が当てはまるかは、①-3の自由記述（特に役職者の記述）や②③の資料と突き合わせて確認し、根拠のある形で書くこと（一般論をそのまま断定的に書かない）。');
  L.push('');
  L.push('## 複線設計の提案について（重要）');
  L.push('- 「専門性を高めたい・スペシャリストを目指したい」という回答が多いことだけを根拠に、管理職コースと専門職・分野別リーダーコースを分ける「複線設計」を安易に提案しないこと。');
  L.push('- 専門職・分野別リーダーのポジションを設けるかどうかは、職員個人の志向だけでなく、①組織として本当にそのポジションが（配置・予算・指揮系統上）必要かどうか、②該当する職員が異動・退職した場合に、後任を時間をかけてでも育成するほど組織として重要視しているかどうか、という組織側の判断が前提になる。この判断は貴法人にしかできない。');
  L.push('- そのため、複線設計や専門職コースの新設を提案する場合は、「職員の志向としては〜という声が一定数あります。ただし、専門職ポジションの新設は職員の希望だけでなく、貴法人として当該分野を専任で担う役割が組織上必要か、後継育成にまで投資する対象かを判断したうえで検討することをお勧めします」という趣旨の但し書きを必ず添えること。');
  L.push('');
  L.push('## 課題→打ち手対応表について（9.のセクション）');
  L.push('「キャリアパス設計に効く構造課題」で拾った課題を、次のアクションを描けるよう表にまとめる。列は「課題カテゴリ｜主な現象・根拠データ｜キャリアパスで対応すべきこと｜育成・制度で対応すべきこと｜目指したい在り方」の5列とする。「キャリアパスで対応（職務・職責・任用要件・評価項目の設計で解ける）」と「育成・その他制度で対応（研修、配置など）」を切り分けることが要点。すべてを一度にやる前提にしない。根拠データ欄には必ず数値か具体的な記述傾向を入れる。');
  L.push('');
  L.push('## 読み手への配慮（決裁権者向け報告であることに注意・必守）');
  L.push('- このレポートは、理事長・園長など、支援を発注いただいた決裁権者に直接お渡しする報告書である。読み手が責められている・否定されていると感じることのないよう、常に「今後どう良くしていくか」という前向きな提案として書くこと。');
  L.push('- 構造的な課題を指摘する際も、「法人の対応が不十分」「〜が放置されている」「〜ができていない」のように、法人・決裁権者・現在の経営や運営を批判・非難するような書き方はしないこと。「〜という声があり、仕組み化することで次の伸びしろになります」のように、現状を否定せず、次の一手として前向きに表現する。');
  L.push('- 第2回ヒアリングの発言の中に、法人・決裁権者・園長への不満や批判に類する内容が含まれる場合は、本人が「言ってもよい」と話していたとしても、その発言をそのまま本文に引用・要約しないこと。迷った場合は含めない方に倒す。内容を一般化・構造化したうえで扱うか、本文には含めずレポート末尾に「次回打合せでの確認事項（本人の意向確認が必要）」として簡潔に触れるにとどめる。');
  L.push('- ただし、読み手の心証を気にして事実や重要な論点そのものを省略しすぎないこと。事実・数値は正確に書き、配慮するのは表現の仕方（言い回し）のみとする。');
  L.push('- 資料の呼び方として「①アンケート」「②第1回資料」「③第2回資料」という表現は使ってよいが、レポート本文（総括や各セクションの文章）の中で読み手を「決裁権者は〜」のように名指しする表現は使わないこと。読み手＝決裁権者そのものであるため、本文では理事長・園長など実際の役職名で書くか、「貴法人」を主語にすること。');
  L.push('');
  L.push('## 見やすさの工夫（重要）');
  L.push('- 貴法人と全法人ベースラインを比べる数値は、必ずMarkdownの表形式で提示すること（属性の内訳、勤続・経験年数、学びたいテーマの件数ランキング等）。長い文章の中に数値を埋め込むだけで済ませないこと。');
  L.push('- 各セクションの分析コメントは、長い1段落の文章ではなく、論点ごとに箇条書き（・）で区切ること。1項目はおおむね2〜3文以内を目安とする。');
  L.push('- 比較のイメージが伝わりやすいよう、貴法人と全法人を比べる主要な指標については「貴法人 44.2%／全法人 中央58%」のような対比表記に加えて、差が大きい指標には一言で傾向を添える（例：「全法人より低め」）。');
  L.push('');
  L.push('## 出力形式・文体（必守）');
  L.push('- 正しい日本語で精度の高い文章にする。専門用語を知らない読み手でも分かる言葉を使う。');
  L.push('- 「平均の○倍」等の倍率表現は使わない（「高め／比較的多い／やや控えめ」等に）。');
  L.push('- アンケートは職員の主観的な声。否定的に見せず、前向きな志向・要望として「キャリアパスでどう応えるか」に接続する。ただし、組織として未解決・未着手の構造的な課題は、前向きなトーンを保ちつつも曖昧にせずはっきり指摘すること。');
  L.push('- AI分析特有の言い回し（「〜と考えられます」の多用、過度に一般化した表現など）は使わない。');
  L.push('- 結論を薄める言い回しも避ける。「〜な傾向にあります」「〜という声もあり、温度差があります」のように結論をぼかさず、データがそう言っているなら「〜が少ない」「〜できていない」と言い切る。まず結論を書き、その後に根拠を続ける順番にすると、ぼかし表現が入り込みにくい。');
  L.push('- 内部運用メモ（「母数を増やして更新できる」等）や、冗長・誘導的な言い回し（「どのような前向きさが見られるか整理しています」等）は入れない。先方に見せるレポートであることを常に意識する。');
  L.push('- 自由記述を引用する際、本文中に固有の個人名が残っていないか必ず確認し、残っていれば役職・職種などの表現に置き換える。');
  L.push('');
  L.push('## 文体・粒度の目標水準（重要）');
  L.push('以下は、同じ形式で過去に作成した完成レポートの抜粋のイメージです（別法人・匿名化済み・数値は例）。個人名や具体的な数値は今回の対象法人のものに置き換えつつ、この粒度・構成・トーンを目標としてください。');
  L.push('');
  L.push('> 総括');
  L.push('> 貴法人の職員アンケートからは、①副主任の役割定義の曖昧さ、②現場の学習ニーズと管理層が抱える育成上の課題が仕組みとして接続されていないこと、という2つの構造的な論点が浮かび上がりました。');
  L.push('> 1. 副主任の役割の重さと定義の曖昧さは、複数施設の副主任本人の記述、第2回ヒアリングでの発言、第1回でうかがった理事長の課題認識のいずれからも共通して指摘されており、貴法人が最優先で職務・職責を定義すべき対象です。');
  L.push('> 2. 一般職員の「学びたいテーマ」は発達支援・インクルーシブ保育に集中する一方、主任・主幹層の記述には「伝え方」「育成の仕方」への悩みが繰り返し現れており、現場の学習ニーズと管理層の育成課題が、まだ仕組みとして接続されていません。');
  L.push('> 3. 研修満足度は高水準ですが、園長・主幹自身が「学んだ内容を実践・振り返りにつなげる仕組みが不足している」と課題を挙げており、次の焦点は研修の「量」ではなく「定着させる仕組み」です。');
  L.push('>');
  L.push('> 3. やりがいと改善点（課題意識）');
  L.push('> 改善点の自由記述を読み解くと、次の構造的な課題が浮かびます。');
  L.push('> ・副主任の役割の重さと定義の曖昧さ：「副主任とクラス担任の両立が難しく、園全体に目を向ける余裕が持てない」。複数施設の副主任が同じ趣旨を述べており、個人の力量ではなく役割設計上の課題です。');
  L.push('> ・育成の伝え方が標準化されていない：主任・主幹層の記述に「伝え方の難しさ」「後輩への指導方法に悩む」が繰り返し現れる一方、対応するOJTの型や指導マニュアルは現状ありません。役職が上がるほど個人の経験則に頼る構造になっています。');
  L.push('> ・サポーター層の裁量の不明確さ：「どこまで判断してよいか迷う」という記述が複数あり、正規職員向けの役割定義がサポーター層には及んでいないことがうかがえます。');
  L.push('');
  L.push('この抜粋のように、①自由記述から実際の言い回しを（個人が特定されない範囲で）引用する、②同趣旨の記述をまとめて「複数の〜が同じ趣旨を述べています」と明記する、③役職による違いに触れる、④各項目の最後にキャリアパス設計への含意を書く、という書き方を踏襲してください。');
  L.push('');
  L.push('## 最終セルフチェック（レポート完成後、必ず自分で確認すること）');
  L.push('- 事業形態（保育園/幼稚園・こども園/児童発達支援・放課後デイ/放課後児童クラブ）に用語が合っているか（「保育」表現でよいか、役職名が実態と一致しているか、園児/利用者/児童などの呼称が一致しているか、「子供」表記になっていないか）。①②③の資料から事業形態を判断し、不明な場合は本文冒頭にその旨を一言断る。');
  L.push('- ヒアリング由来の内容に、法人・決裁権者・園長への批判に類する内容が紛れ込んでいないか（読み手への配慮の節を再確認）。');
  L.push('- 「円滑に進めるため」「弊社が」のような内部向け・運用向けの言い回しが残っていないか。');
  L.push('- 数値の裏付けがない断定や、曖昧なまま終わっている論点がないか。');
  L.push('- 上記に問題があれば、提出前に自分で修正してから最終版として出力すること。');
  L.push('');
  L.push('## ①アンケート集計（貴法人 / 全法人'+(base.lawCount||0)+'法人・'+(base.peopleCount||0)+'名）');
  QLABEL.forEach(function(c){ var k=c[0],lab=c[1],u=c[2];
    if(k==='n'){ L.push('- 回答者数：'+(target.q.n||0)+'名'); return; }
    var tv=target.q[k]; var bs=base.quant?base.quant[k]:null;
    L.push('- '+lab+'：貴法人 '+(tv==null?'—':tv+u)+' ／ 全法人 '+fmtBaseRange(bs,u));
  });
  L.push('');
  L.push('## ①-2 質的傾向（貴法人 / 全法人）');
  (base.qual||[]).forEach(function(t){ var r=(target.qual||{})[t.key]||{}; L.push('- '+t.label+(t.seg?'（'+t.seg.join('・')+'）':'')+'：貴法人 '+(r.pct==null?'—':r.pct+'%')+'(n='+(r.n||0)+') ／ 全法人 '+(t.basePct==null?'—':t.basePct+'%')+'(n='+(t.baseN||0)+')'); });
  L.push('');
  L.push('## ①-3 アンケート自由記述（匿名化・貴法人のみ）');
  L.push('氏名・タイムスタンプは除外済み。実際の回答者の言葉なので、上記の目標水準の例のように、具体的な言い回しを（個人が特定されない範囲で）引用しながら分析してください。');
  L.push('');
  L.push(respondentText || '（未提供）');
  L.push('');
  L.push('## ②第1回打合せ資料（原文）');
  L.push(deck1Text || '（未提供）');
  L.push('');
  L.push('## ③第2回打合せ資料（原文）');
  L.push(deck2Text || '（未提供）');
  L.push('');
  L.push('上記をもとに、指示した構成の統合レポートを作成してください。');
  return L.join('\n');
}

// セキュリティ：外部からTOKEN付きで呼べる関数は、指定ファイルがマスターフォルダ配下
// （案件フォルダ群）にあるものだけを対象にする。呼び出し元が用意した任意のファイルID
// （例えば実行アカウントがアクセスできる無関係な社内ファイル）を読み込ませないため。
function isWithinMasterFolder(fileId){
  try{
    var file=DriveApp.getFileById(fileId);
    var seen={}, queue=[]; var it=file.getParents();
    while(it.hasNext()){ queue.push(it.next().getId()); }
    var depth=0;
    while(queue.length && depth<12){
      depth++;
      var next=[];
      for(var i=0;i<queue.length;i++){
        var fid=queue[i];
        if(fid===MASTER_FOLDER_ID) return true;
        if(seen[fid]) continue;
        seen[fid]=true;
        try{
          var folder=DriveApp.getFolderById(fid);
          var pit=folder.getParents();
          while(pit.hasNext()){ next.push(pit.next().getId()); }
        }catch(e){}
      }
      queue=next;
    }
    return false;
  }catch(e){ return false; }
}

function doGet(e){
  var cb=(e.parameter.callback||'').replace(/[^a-zA-Z0-9_$]/g,'');
  var out;
  try{
    var need=PropertiesService.getScriptProperties().getProperty('TOKEN');
    if(need && e.parameter.token!==need){ out={ok:false,error:'認証エラー（token不一致）'}; }
    else if(e.parameter.fullreport){
      var fid=(e.parameter.id||'').trim();
      if(!fid){ out={ok:false,error:'アンケートのスプレッドシートIDがありません'}; }
      else if(!isWithinMasterFolder(fid)){ out={ok:false,error:'指定されたファイルはマスターフォルダ配下ではないため処理できません'}; }
      else{
        var fss=SpreadsheetApp.openById(fid);
        var frows=pickResponseRowsFromSheet(fss);
        if(!frows||frows.length<3){ out={ok:false,error:'回答シートが見つかりませんでした'}; }
        else{
          var ftarget=analyzeRows(frows);
          var frecords=loadFirmRecordsCache();
          var fexcludeFolderId=null;
          try{ var ff=DriveApp.getFileById(fid); var fparents=ff.getParents(); if(fparents.hasNext()) fexcludeFolderId=fparents.next().getId(); }catch(e2){}
          if(!frecords){ frecords=computeFirmRecords(); saveFirmRecordsCache(frecords); }
          var fbase=aggregateFirmRecords(frecords, fexcludeFolderId);
          var deck1Text='', deck2Text='';
          try{
            if(e.parameter.deck1){ var d1=e.parameter.deck1.trim(); if(!isWithinMasterFolder(d1)) throw new Error('マスターフォルダ配下ではありません'); deck1Text=extractDeckText(d1); }
          }catch(e3){ deck1Text='（第1回資料の読み込みに失敗: '+e3.message+'）'; }
          try{
            if(e.parameter.deck2){ var d2=e.parameter.deck2.trim(); if(!isWithinMasterFolder(d2)) throw new Error('マスターフォルダ配下ではありません'); deck2Text=extractDeckText(d2); }
          }catch(e4){ deck2Text='（第2回資料の読み込みに失敗: '+e4.message+'）'; }
          var lawName=(e.parameter.name||'').trim();
          var respondentText=buildAnonRespondentText(frows);
          var prompt=buildFullPrompt(lawName, ftarget, fbase, deck1Text, deck2Text, respondentText);
          var apiKey=PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
          if(apiKey){
            try{
              var resp=UrlFetchApp.fetch('https://api.anthropic.com/v1/messages',{
                method:'post',
                headers:{'x-api-key':apiKey,'anthropic-version':'2023-06-01','content-type':'application/json'},
                payload:JSON.stringify({model:'claude-sonnet-5',max_tokens:16000,messages:[{role:'user',content:prompt}]}),
                muteHttpExceptions:true
              });
              var rj=JSON.parse(resp.getContentText());
              if(rj && rj.content && rj.content[0] && rj.content[0].text){ out={ok:true, generated:true, text:rj.content[0].text}; }
              else{ out={ok:true, generated:false, text:prompt, note:'AI生成に失敗したためプロンプトを返します: '+resp.getContentText().slice(0,300)}; }
            }catch(e5){ out={ok:true, generated:false, text:prompt, note:'AI呼び出しエラーのためプロンプトを返します: '+e5.message}; }
          }else{
            out={ok:true, generated:false, text:prompt};
          }
        }
      }
    }
    else if(e.parameter.baseline){
      if(e.parameter.excludeId){
        // 自己比較を避けたい場合：対象シートIDが属するフォルダを特定し、キャッシュ済みの
        // 法人別レコードからその1法人だけを除いて集計する（Drive再走査なし・一瞬で終わる）。
        var excludeFolderId=null;
        var exId=e.parameter.excludeId.trim();
        try{
          if(isWithinMasterFolder(exId)){
            var f=DriveApp.getFileById(exId);
            var parents=f.getParents();
            if(parents.hasNext()) excludeFolderId=parents.next().getId();
          }
        }catch(err){ /* 特定できなければ除外なしで計算 */ }
        var records=loadFirmRecordsCache();
        if(records){ out={ok:true, base:aggregateFirmRecords(records, excludeFolderId), live:true}; }
        else{
          // キャッシュが無い場合のみ、フォールバックとしてDriveを都度走査する（時間がかかる）
          var freshRecords=computeFirmRecords();
          saveFirmRecordsCache(freshRecords);
          out={ok:true, base:aggregateFirmRecords(freshRecords, excludeFolderId), live:true};
        }
      }else{
        var cached=PropertiesService.getScriptProperties().getProperty(BASELINE_CACHE_KEY);
        if(cached){ out={ok:true, base:JSON.parse(cached), live:false}; }
        else{ out={ok:true, base:refreshBaselineCache(), live:true}; }
      }
    }
    else{
      var id=(e.parameter.id||'').trim();
      if(!id){ out={ok:false,error:'スプレッドシートIDがありません'}; }
      else if(!isWithinMasterFolder(id)){ out={ok:false,error:'指定されたファイルはマスターフォルダ配下ではないため処理できません'}; }
      else{
        var ss=SpreadsheetApp.openById(id);
        var rows=pickResponseRowsFromSheet(ss);
        if(!rows||rows.length<3){ out={ok:false,error:'回答シート（役職・勤続などの列を持つタブ）が見つかりませんでした'}; }
        else{ var res=analyzeRows(rows); out={ok:true, q:res.q, qual:res.qual}; }
      }
    }
  }catch(err){ out={ok:false,error:'取得エラー: '+err.message}; }
  var body=JSON.stringify(out);
  if(cb){ return ContentService.createTextOutput(cb+'('+body+');').setMimeType(ContentService.MimeType.JAVASCRIPT); }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}
