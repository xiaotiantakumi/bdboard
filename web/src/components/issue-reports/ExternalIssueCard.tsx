import { useId, useState } from 'react';
import type { ExternalIssueDto } from '../../api/issue-reports-external';
import { formatAbsoluteTime } from '../../formatAbsoluteTime';
import { describeCheckCounts, segmentExternalText } from './externalIssueText';
import { ExternalIssueBody } from './ExternalIssueBody';

function CheckList({title,checks}:{readonly title:string;readonly checks:ExternalIssueDto['checks']['body']}) {
 const counts=describeCheckCounts(checks);return <section><h4>{title}</h4><dl className="external-issue-checks">{counts.map(x=><div key={x.key}><dt>{x.label}</dt><dd>{x.count}{x.detail&&<small>{x.detail}</small>}</dd></div>)}</dl></section>;
}
function MarkedTitle({text}:{readonly text:string}) {return <>{segmentExternalText(text).map((s,i)=>s.kind==='text'?<span key={i}>{s.text}</span>:s.kind==='invisible'?<span key={i} className="external-issue-mark">{s.marks}</span>:<span key={i} className="external-issue-html-comment">⟦HTML コメント⟧{s.parts.map((p,j)=>p.kind==='text'?<span key={j}>{p.text}</span>:<span key={j} className="external-issue-mark">{p.marks}</span>)}</span>)}</>;}
export function ExternalIssueCard({issue}:{readonly issue:ExternalIssueDto}) {
 const [open,setOpen]=useState(false);const id=useId();
 return <li className="external-issue-card"><h3>#{issue.number} <MarkedTitle text={issue.title}/></h3>
  <p className="external-issue-meta">{issue.author??'(不明)'}{issue.authorAssociation&&<> · {issue.authorAssociation}</>} · <time dateTime={issue.updatedAt}>{formatAbsoluteTime(issue.updatedAt)}</time> · <code className="external-issue-url">{issue.url}</code></p>
  <CheckList title="本文の検査" checks={issue.checks.body}/>
  {describeCheckCounts(issue.checks.title).some(x=>x.count>0)&&<CheckList title="題名の検査" checks={issue.checks.title}/>}
  {issue.titleTruncated&&<p>題名は長いため途中までです (元は {issue.titleLength} 文字)</p>}{issue.bodyTruncated&&<p>本文は長いため途中までです (元は {issue.bodyLength} 文字)</p>}
  {issue.needsRejudge&&<p role="status">GitHub 側で編集されました (判定のやり直しが必要)</p>}
  <button type="button" className="external-issue-body-toggle" aria-expanded={open} aria-controls={id} onClick={()=>setOpen(v=>!v)}>{open?'本文をたたむ':'本文を見る'}</button>
  {open&&<div id={id}><ExternalIssueBody body={issue.body} checks={issue.checks.body}/></div>}
 </li>;
}
