/** Pure endpoint resolution shared by Node MCP/command hooks and Claude's isolated hooks. */
import {invariant} from './pure.mjs';

export function serviceEndpoints(value, allowRemote=false, provider='generic') {
  invariant(typeof value === 'string', 'System One URL must be a string');
  let url;
  try { url = new URL(value); } catch { invariant(false, 'Invalid System One URL'); }
  invariant(['http:','https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
    'Use HTTP(S) without URL credentials, query or fragment');
  if(url.hostname.toLowerCase() === 'localhost') url.hostname='127.0.0.1';
  const local=/^127(?:\.\d{1,3}){3}$/.test(url.hostname)||url.hostname==='[::1]';
  invariant(local||allowRemote, 'Non-loopback System One URL requires explicit allowRemote / --allow-remote');
  let prefix=url.pathname.replace(/\/+$/, '');
  if(provider==='decider') invariant(!prefix.endsWith('/decide'), 'decider: use /v1/systemone, not the different /decide schema');
  for(const suffix of ['/v1/systemone','/v1/completions','/v1',...(provider==='shisa'?['/completion']:[])]) {
    if(prefix.endsWith(suffix)) { prefix=prefix.slice(0,-suffix.length); break; }
  }
  const base=url.origin+prefix;
  return {systemOne:base+'/v1/systemone', models:base+'/v1/models',
    completions:base+'/v1/completions', tokenize:base+'/tokenize', props:base+'/props',
    applyTemplate:base+'/apply-template', nativeCompletion:base+'/completion', local};
}
