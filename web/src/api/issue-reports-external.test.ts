import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './http';
import { EXTERNAL_ISSUES_API_PATH, EXTERNAL_ISSUES_REFRESH_API_PATH, fetchExternalIssues, refreshExternalIssues, refreshWaitSeconds } from './issue-reports-external';

afterEach(()=>vi.unstubAllGlobals());
describe('external issue API',()=>{
 it('gets the list path',async()=>{const f=vi.fn().mockResolvedValue({ok:true,status:200,json:async()=>({issues:[]})});vi.stubGlobal('fetch',f);await fetchExternalIssues();expect(f).toHaveBeenCalledWith(EXTERNAL_ISSUES_API_PATH,undefined);});
 it('posts JSON to refresh',async()=>{const f=vi.fn().mockResolvedValue({ok:true,status:200,json:async()=>({issues:[]})});vi.stubGlobal('fetch',f);await refreshExternalIssues();expect(f).toHaveBeenCalledWith(EXTERNAL_ISSUES_REFRESH_API_PATH,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});});
 it('extracts only positive integer retry-after values from 429',()=>{expect(refreshWaitSeconds(new ApiError(429,'x',{body:'{"retryAfterSeconds":42}'}))).toBe(42);expect(refreshWaitSeconds(new ApiError(429,'x',{body:'bad'}))).toBeUndefined();expect(refreshWaitSeconds(new ApiError(500,'x',{body:'{"retryAfterSeconds":42}'}))).toBeUndefined();expect(refreshWaitSeconds(new Error())).toBeUndefined();});
});
