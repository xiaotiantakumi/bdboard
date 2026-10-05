import type { ExternalIssueListDto, ExternalTextChecks } from '../../api/issue-reports-external';

export const INVISIBLE_CODE_POINT_RANGES: readonly (readonly [number, number])[] = [
  [0x200b,0x200b],[0x200c,0x200c],[0x200d,0x200d],[0x2060,0x2060],[0xfeff,0xfeff],
  [0x202a,0x202a],[0x202b,0x202b],[0x202c,0x202c],[0x202d,0x202d],[0x202e,0x202e],
  [0x2066,0x2066],[0x2067,0x2067],[0x2068,0x2068],[0x2069,0x2069],[0x061c,0x061c],
  [0x200e,0x200e],[0x200f,0x200f],[0xe0000,0xe007f],
];
export function isInvisibleCodePoint(cp: number): boolean { return INVISIBLE_CODE_POINT_RANGES.some(([a,b]) => cp >= a && cp <= b); }
export function formatInvisibleMark(cp: number): string { return `⟦U+${cp.toString(16).toUpperCase().padStart(4,'0')}⟧`; }
export type ExternalTextSegment = { readonly kind:'text'; readonly text:string } | { readonly kind:'invisible'; readonly marks:string } | { readonly kind:'comment'; readonly parts:readonly ({readonly kind:'text';readonly text:string}|{readonly kind:'invisible';readonly marks:string})[]; readonly closed:boolean };
function segments(text:string): ExternalTextSegment[] {
  const result: ExternalTextSegment[]=[]; let plain=''; let i=0;
  const flush=()=>{if(plain){result.push({kind:'text',text:plain});plain='';}};
  const piece=(from:number,to:number): ExternalTextSegment['kind'] extends never ? never : ({kind:'text';text:string}|{kind:'invisible';marks:string})[]=>{
    const out:({kind:'text';text:string}|{kind:'invisible';marks:string})[]=[];let raw='';let marks='';
    const flushRaw=()=>{if(raw){out.push({kind:'text',text:raw});raw='';}};
    for(let p=from;p<to;){const cp=text.codePointAt(p)!;const width=cp>0xffff?2:1;if(isInvisibleCodePoint(cp)){flushRaw();marks+=formatInvisibleMark(cp);}else{if(marks){out.push({kind:'invisible',marks});marks='';}raw+=text.slice(p,p+width);}p+=width;}
    flushRaw();if(marks)out.push({kind:'invisible',marks});return out;
  };
  while(i<text.length){const open=text.indexOf('<!--',i);
    if(open===i){flush();const close=text.indexOf('-->',i+4);const end=close<0?text.length:close+3;result.push({kind:'comment',parts:piece(i,end),closed:close>=0});i=end;continue;}
    let p=i;while(p<text.length){if(text.startsWith('<!--',p))break;const cp=text.codePointAt(p)!;if(isInvisibleCodePoint(cp))break;p+=cp>0xffff?2:1;}
    if(p===text.length){plain+=text.slice(i);break;}
    if(p>i){plain+=text.slice(i,p);i=p;continue;}
    if(text.startsWith('<!--',i))continue;
    flush();let marks='';while(i<text.length){const cp=text.codePointAt(i)!;if(!isInvisibleCodePoint(cp))break;marks+=formatInvisibleMark(cp);i+=cp>0xffff?2:1;}result.push({kind:'invisible',marks});
  }
  flush();return result;
}
export function segmentExternalText(text:string):ExternalTextSegment[]{return segments(text);}
function finite(n:unknown):number{return typeof n==='number'&&Number.isFinite(n)?n:0;}
export function describeCheckCounts(c:ExternalTextChecks):{key:string;label:string;count:number;detail?:string}[]{
 const kinds=c.invisibleChars?.kinds??[];const invis=finite(c.invisibleChars?.total);const details=kinds.slice(0,5).map(k=>`${k.codePoint} ×${finite(k.count)}`);if(kinds.length>5)details.push(`ほか ${kinds.length-5} 種類`);
 const link=c.links??{markdownLinks:0,autolinks:0,referenceDefinitions:0,rawUrls:0};
 return [{key:'invisible',label:'見えない文字',count:invis,...(details.length?{detail:details.join('、')}:{})},{key:'comments',label:'HTML コメント',count:finite(c.htmlComments?.count),...(c.htmlComments?.unclosed?{detail:'閉じていないものを含む'}:{})},{key:'encoded',label:'長い符号化文字列',count:finite(c.longEncodedStrings?.count)},{key:'links',label:'リンク',count:finite(c.links?.total),detail:`Markdown ${finite(link.markdownLinks)}・autolink ${finite(link.autolinks)}・参照定義 ${finite(link.referenceDefinitions)}・生の URL ${finite(link.rawUrls)}`}];
}
export const BUDGET_EXHAUSTED_DETAIL_PREFIX='gh call limit reached';
export function retryLaterText(seconds:number):string{return `${seconds} 秒ほど待ってからもう一度押してください。`;}
export function externalStateMessage(list:ExternalIssueListDto):string{
 if(list.state==='idle')return 'まだ確かめていません (起動の約 1 分後に最初の確認をします)。';
 if(list.state==='ok')return list.issues.length?`${list.fetchedAt??''} に確かめました。届いた issue は ${list.issues.length} 件です。`:`${list.fetchedAt??''} に確かめました。届いた issue はありません。`;
 const e=list.error; if(!e)return '確認が止まりました。';if(e.detail.startsWith(BUDGET_EXHAUSTED_DETAIL_PREFIX))return 'GitHub への問い合わせの手元の上限に達しました。しばらくしてから確かめられます。';
 return ({'gh-missing':'GitHub CLI (gh) が見つかりません。gh を入れると届いた issue を確かめられます。','gh-unauthenticated':'gh でログインしていません。ターミナルで gh auth login を実行してください。','rate-limited':'GitHub の問い合わせの制限に当たりました。しばらくしてから自動でやり直します。','failed':'確認に失敗しました。しばらくしてから自動でやり直します。','bd-failed':'bd の紐付けを読めませんでした。一覧は前回のままです。','storage-failed':'写しの保存に失敗しました。一覧は前回のままです。','unexpected':'想定外の失敗で確認が止まりました。一覧は前回のままです。'} as Record<string,string>)[e.kind]??'確認が止まりました。';
}
