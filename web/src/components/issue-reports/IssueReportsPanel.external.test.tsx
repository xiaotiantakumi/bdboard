import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ExternalIssueListDto } from '../../api/issue-reports-external';
import { IssueReportsPanel } from './IssueReportsPanel';

vi.mock('../../api/issue-reports',async importOriginal=>({...await importOriginal<typeof import('../../api/issue-reports')>(),fetchIssueDrafts:vi.fn().mockResolvedValue({drafts:[],pendingCount:0}),fetchIssueReportPendingCount:vi.fn().mockResolvedValue({pendingCount:0})}));
vi.mock('../../api/issue-reports-external',()=>({fetchExternalIssues:vi.fn()}));
import { fetchExternalIssues } from '../../api/issue-reports-external';
const list=(enabled:boolean):ExternalIssueListDto=>({enabled,state:'ok',fetchedAt:'2026-10-01T00:00:00Z',error:null,truncated:false,skippedLines:0,issues:[{number:17,title:'external example issue',body:'body text',author:'example-user',authorAssociation:null,url:'https://github.com/example/repo/issues/17',updatedAt:'2026-10-01T00:00:00Z',titleTruncated:false,bodyTruncated:false,titleLength:22,bodyLength:9,checks:{title:{invisibleChars:{total:0,kinds:[]},htmlComments:{count:0,unclosed:false,totalChars:0,spans:[]},longEncodedStrings:{count:0,longest:0,spans:[]},links:{total:0,markdownLinks:0,autolinks:0,referenceDefinitions:0,rawUrls:0}},body:{invisibleChars:{total:0,kinds:[]},htmlComments:{count:0,unclosed:false,totalChars:0,spans:[]},longEncodedStrings:{count:0,longest:0,spans:[]},links:{total:0,markdownLinks:0,autolinks:0,referenceDefinitions:0,rawUrls:0}}},snapshotAt:'2026-10-01T00:00:00Z',needsRejudge:false,updatedAtChanged:false}]});
function setup(hostname='example.test'){const client=new QueryClient({defaultOptions:{queries:{retry:false}}});return {client,...render(<QueryClientProvider client={client}><IssueReportsPanel hostname={hostname}/></QueryClientProvider>)};}
describe('IssueReportsPanel external issues',()=>{
 it('shows the switch only when enabled and returns to draft views',async()=>{const user=userEvent.setup();vi.mocked(fetchExternalIssues).mockResolvedValueOnce(list(false)).mockResolvedValue(list(true));setup();await screen.findByRole('heading',{name:'不具合報告'});expect(screen.queryByRole('button',{name:/届いた issue/})).toBeNull();
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});vi.mocked(fetchExternalIssues).mockResolvedValue(list(true));render(<QueryClientProvider client={client}><IssueReportsPanel/></QueryClientProvider>);await user.click(await screen.findByRole('button',{name:'届いた issue (1)'}));expect(await screen.findByRole('heading',{name:/external example issue/})).toBeTruthy();expect(screen.queryByText('pending')).toBeNull();await user.click(screen.getAllByRole('button',{name:/未処理/}).at(-1)!);expect(screen.getAllByText('未処理の下書きはありません。').length).toBeGreaterThan(0);
 });
});
