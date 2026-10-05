import { useState } from 'react';
import type { ExternalTextChecks } from '../../api/issue-reports-external';
import { togglePressedProps } from '../toggleGroupA11y';
import { previewHeavyReason, SafeMarkdownPreview } from './SafeMarkdownPreview';
import { segmentExternalText } from './externalIssueText';

export function ExternalIssueBody({body,checks}:{readonly body:string;readonly checks:ExternalTextChecks}) {
 const [preview,setPreview]=useState(false);const reason=previewHeavyReason(body);
 const showInvisible=checks.invisibleChars.total>0||checks.htmlComments.count>0;
 return <div className="external-issue-body">
  <div className="toggle-group" aria-label="本文の表示">
   <button type="button" className={`toggle-btn${!preview?' active':''}`} {...togglePressedProps(!preview)} onClick={()=>setPreview(false)}>生の本文</button>
   <button type="button" className={`toggle-btn${preview?' active':''}`} {...togglePressedProps(preview)} disabled={reason!==null} onClick={()=>setPreview(true)}>プレビュー</button>
  </div>
  {reason&&<p className="issue-draft-muted">{reason}生の本文のままにします。</p>}
  {preview&&reason===null?<>
   {showInvisible&&<p className="issue-draft-muted">プレビューでは見えない文字と HTML コメントが見えません。生の本文で確かめてください。</p>}
   <SafeMarkdownPreview text={body}/>
  </>:<>
   <p className="external-issue-legend">⟦U+200B⟧ は見えない文字、⟦HTML コメント⟧ はコメントです。</p>
   <pre className="external-issue-raw-body">{segmentExternalText(body).map((s,i)=>s.kind==='text'?<span key={i}>{s.text}</span>:s.kind==='invisible'?<span key={i} className="external-issue-mark" data-testid="external-issue-invisible-mark">{s.marks}</span>:<span key={i} className="external-issue-html-comment" data-testid="external-issue-html-comment"><span className="external-issue-mark">{s.closed?'⟦HTML コメント⟧':'⟦HTML コメント (閉じていない)⟧'}</span>{s.parts.map((p,j)=>p.kind==='text'?<span key={j}>{p.text}</span>:<span key={j} className="external-issue-mark" data-testid="external-issue-invisible-mark">{p.marks}</span>)}</span>)}</pre>
  </>}
 </div>;
}
