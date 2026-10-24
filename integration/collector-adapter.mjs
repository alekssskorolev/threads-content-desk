/** Read only selected numeric metrics from a Threads Collector links-v2 archive.
 * No browser profile, credentials, response payloads or post texts are exported.
 * Dependency-free; also embedded into the standalone site at build time.
 */
export function collectorToMetrics(archive) {
 const KEYS=['views','likes','replies','reposts','quotes','shares'];
 if(!archive||archive.version!==2||typeof archive.author!=='string'||!/^[A-Za-z0-9_.]{1,40}$/.test(archive.author)||!archive.posts||typeof archive.posts!=='object'||Array.isArray(archive.posts))throw Error('Ожидается archive.json формата Threads Collector links-v2');
 const author=archive.author.toLowerCase(),roots=new Set(Object.keys(archive.threads||{}));
 for(const [code,p] of Object.entries(archive.posts))if(p?.is_reply===false&&!archive.membership?.[code])roots.add(code);
 const observations=[],warnings=[];
 for(const code of roots){
  if(!/^[A-Za-z0-9_-]+$/.test(code))continue;
  const p=archive.posts[code];if(!p||p.author?.toLowerCase()!==author){warnings.push(`${code}: исходный пост не подтверждён для автора`);continue;}
  if(p.is_reply===true||(archive.membership?.[code]&&archive.membership[code]!==code)){warnings.push(`${code}: продолжение/ответ пропущен`);continue;}
  const row={url:`https://www.threads.com/@${author}/post/${code}`,source:'Threads Collector links-v2',metric_observed_at:{},approximate_metrics:[],metric_sources:{},metric_scopes:{}};
  let found=0;
  for(const k of KEYS){
   const h=archive.page_header_views?.[code];
   const m=k==='views'?(h?.post_code===code&&h?.scope==='thread_page_header'?h:null):p.metrics?.[k];
   row[k]=null;
   if(m?.value==null||m.status==='hidden')continue;
   if(!Number.isSafeInteger(m.value)||m.value<0){warnings.push(`${code}/${k}: некорректное значение пропущено`);continue;}
   if(typeof m.observed_at!=='string'||!Number.isFinite(Date.parse(m.observed_at))){warnings.push(`${code}/${k}: неизвестное время — значение пропущено`);continue;}
   row[k]=m.value;found++;row.metric_observed_at[k]=new Date(m.observed_at).toISOString();
   if(m.approximate===true)row.approximate_metrics.push(k);
   row.metric_sources[k]=typeof m.source==='string'?m.source:'collector';row.metric_scopes[k]=k==='views'?'thread_page_header':'root_post';
  }
  row.clicks=null; // Public Threads counts do not measure site clicks.
  if(found){row.observed_at=Object.values(row.metric_observed_at).sort().at(-1);observations.push(row);}
 }
 return {kind:'threads-metrics',version:1,observations,warnings};
}
