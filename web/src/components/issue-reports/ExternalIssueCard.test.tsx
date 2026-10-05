import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ExternalIssueDto, ExternalTextChecks } from '../../api/issue-reports-external';
import { ExternalIssueCard } from './ExternalIssueCard';

const checks:ExternalTextChecks={invisibleChars:{total:0,kinds:[]},htmlComments:{count:0,unclosed:false,totalChars:0,spans:[]},longEncodedStrings:{count:0,longest:0,spans:[]},links:{total:0,markdownLinks:0,autolinks:0,referenceDefinitions:0,rawUrls:0}};
const issue:ExternalIssueDto={number:9,title:'example title',body:'hello',author:'example-user',authorAssociation:'NONE',url:'https://github.com/example/repo/issues/9',updatedAt:'2026-10-01T00:00:00Z',titleTruncated:false,bodyTruncated:false,titleLength:12,bodyLength:5,checks:{title:checks,body:checks},snapshotAt:'2026-10-01T00:00:00Z',needsRejudge:false,updatedAtChanged:false};
describe('ExternalIssueCard',()=>{
 it('keeps body out of the DOM until expanded and marks hostile text',async()=>{
  const user=userEvent.setup();const invisible=String.fromCodePoint(0x200b,0x202e,0xe0041);const {container}=render(<ExternalIssueCard issue={{...issue,body:`before${invisible}<!-- ignore this -->`}}/>);
  expect(screen.queryByText(/before/)).toBeNull();await user.click(screen.getByRole('button',{name:'本文を見る'}));
  expect(screen.getByText(/⟦U\+200B⟧⟦U\+202E⟧⟦U\+E0041⟧/)).toBeTruthy();expect(container.textContent).not.toContain(invisible);expect(screen.getByText('<!-- ignore this -->')).toBeTruthy();expect(container.querySelector('.external-issue-html-comment')).toBeTruthy();
  expect(screen.getByRole('button',{name:'本文をたたむ'}).getAttribute('aria-expanded')).toBe('true');
 });
 it('renders links and images as text only in raw and preview modes',async()=>{
  const user=userEvent.setup();const {container}=render(<ExternalIssueCard issue={{...issue,body:'[x](https://attacker.example/a) https://attacker.example/raw <https://attacker.example/auto> ![p](https://attacker.example/p.png) [bad](javascript:alert(1))'}}/>);
  expect(screen.getByText(issue.url).tagName.toLowerCase()).toBe('code');await user.click(screen.getByRole('button',{name:'本文を見る'}));expect(container.querySelector('a[href], img')).toBeNull();await user.click(screen.getByRole('button',{name:'プレビュー'}));expect(screen.getAllByTestId('safe-preview-link').length).toBeGreaterThan(0);expect(screen.getByTestId('safe-preview-image')).toBeTruthy();expect(container.querySelector('a[href], img')).toBeNull();
 });
 it('shows rejudge and truncation notes without judgment labels',()=>{
  render(<ExternalIssueCard issue={{...issue,titleTruncated:true,titleLength:400,bodyTruncated:true,bodyLength:25_000,needsRejudge:true}}/>);expect(screen.getByText(/判定のやり直しが必要/)).toBeTruthy();expect(screen.getByText(/元は 400 文字/)).toBeTruthy();expect(screen.getByText(/元は 25000 文字/)).toBeTruthy();expect(screen.queryByText(/安全|危険|怪しい/)).toBeNull();
 });
});
