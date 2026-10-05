import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { refreshExternalIssues, refreshWaitSeconds, type ExternalIssueListDto } from '../../api/issue-reports-external';
import { formatAbsoluteTime } from '../../formatAbsoluteTime';
import { useExternalIssues } from '../../hooks/useIssueReportPendingCount';
import { LoadingIndicator } from '../LoadingIndicator';
import { externalStateMessage, retryLaterText } from './externalIssueText';
import { ExternalIssueCard } from './ExternalIssueCard';

export function ExternalIssueList({localAccess}:{readonly localAccess:boolean}) {
 const query=useExternalIssues();const client=useQueryClient();const [refreshing,setRefreshing]=useState(false);const [error,setError]=useState('');
 const list=query.data as ExternalIssueListDto|undefined;
 async function refresh(){setRefreshing(true);setError('');try{client.setQueryData(['issue-reports','external'],await refreshExternalIssues());}catch(e){const wait=refreshWaitSeconds(e);setError(wait?`確認は 1 分に 1 回までです。${retryLaterText(wait)}`:e instanceof Error&&'status'in e&&e.status===429?'確認は 1 分に 1 回までです。しばらくしてからもう一度押してください。':'今すぐ確認できませんでした。しばらくしてからもう一度押してください。');}finally{setRefreshing(false);}}
 if(query.isLoading)return <LoadingIndicator/>;
 if(query.isError||!list)return <p className="error-message" role="alert">届いた issue を読み込めませんでした。</p>;
 const message=externalStateMessage(list);
 return <div className="external-issue-list-wrap"><p role="status">{message}</p>{list.state==='error'&&list.fetchedAt&&<p>最後に確かめられたのは {formatAbsoluteTime(list.fetchedAt)} です (一覧はそのときのものです)。</p>}{list.state==='error'&&localAccess&&list.error?.detail&&<p>詳細: {list.error.detail}</p>}{list.truncated&&<p>続きがあります。一覧は上限までです。</p>}{list.skippedLines>0&&<p>GitHub の応答のうち読めなかった行が {list.skippedLines} 行あります。</p>}
 {localAccess&&<button type="button" className="btn" disabled={refreshing} onClick={()=>void refresh()}>{refreshing?'確認しています…':'今すぐ確認'}</button>}{refreshing&&<p role="status">確認しています…</p>}{error&&<p role="alert">{error}</p>}
 <ul className="external-issue-list">{list.issues.map(issue=><ExternalIssueCard key={issue.number} issue={issue}/>)}</ul></div>;
}
