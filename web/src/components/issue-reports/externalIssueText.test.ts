import { readFileSync } from 'node:fs';
import { URL as NodeUrl, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatInvisibleMark, isInvisibleCodePoint, segmentExternalText } from './externalIssueText';

it('matches the server invisible character table for every code point',()=>{
 const src=readFileSync(fileURLToPath(new NodeUrl('../../../../src/domain/external-issue-hidden-text.ts',import.meta.url)),'utf8');
 const rows=[...src.matchAll(/\{ code: (0x[0-9a-f]+)(?:, last: (0x[0-9a-f]+))?/g)];expect(rows).toHaveLength(18);
 const set=new Set<number>();for(const row of rows){const a=Number(row[1]);const b=Number(row[2]??row[1]);for(let n=a;n<=b;n++)set.add(n);}
 const actual=new Set<number>();for(let cp=0;cp<=0x10ffff;cp++)if(isInvisibleCodePoint(cp))actual.add(cp);expect(actual).toEqual(set);
});
describe('segmentExternalText',()=>{
 it('marks invisible runs and preserves comment delimiters, code points and surrogates',()=>{
  expect(formatInvisibleMark(0xe0041)).toBe('⟦U+E0041⟧');
  const parts=segmentExternalText('a'+String.fromCodePoint(0x200b,0x202e)+'<!-- ignore -->😀\ud800');
  expect(parts).toEqual([{kind:'text',text:'a'},{kind:'invisible',marks:'⟦U+200B⟧⟦U+202E⟧'},{kind:'comment',closed:true,parts:[{kind:'text',text:'<!-- ignore -->'}]},{kind:'text',text:'😀\ud800'}]);
 });
 it('handles <!-->, unclosed comments, embedded invisibles and empty text',()=>{
  expect(segmentExternalText('')).toEqual([]);expect(segmentExternalText('<!-->')).toEqual([{kind:'comment',closed:false,parts:[{kind:'text',text:'<!-->'}]}]);
  expect(segmentExternalText('<!--'+String.fromCodePoint(0x200b))).toEqual([{kind:'comment',closed:false,parts:[{kind:'text',text:'<!--'},{kind:'invisible',marks:'⟦U+200B⟧'}]}]);
 });
 it('finishes a large alternating input',()=>{expect(segmentExternalText(('x'+String.fromCodePoint(0x200b)).repeat(20_000)).length).toBe(40_000);});
});
