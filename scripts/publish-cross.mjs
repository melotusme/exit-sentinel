import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const repo='melotusme/exit-sentinel-releases',dir='release-assets';
const {version}=JSON.parse(readFileSync('src-tauri/tauri.conf.json','utf8'));
const tag=`v${version}`,notes=readFileSync('release-notes.md','utf8'),platforms={};
for(const key of ['darwin-aarch64','windows-x86_64','linux-x86_64']){
 const meta=JSON.parse(readFileSync(`${dir}/${key}.json`,'utf8'));
 if(meta.version!==version||meta.platform!==key||!meta.signature||!existsSync(`${dir}/${meta.asset}`))throw new Error('Missing or mismatched build artifacts');
 platforms[key]={signature:meta.signature,url:`https://github.com/${repo}/releases/download/${tag}/${meta.asset}`};
}
writeFileSync(`${dir}/latest.json`,JSON.stringify({version,notes,pub_date:new Date().toISOString(),platforms},null,2)+'\n');
const files=readdirSync(dir).filter(n=>!n.endsWith('.json')||n==='latest.json');
writeFileSync(`${dir}/SHA256SUMS`,files.map(n=>`${createHash('sha256').update(readFileSync(`${dir}/${n}`)).digest('hex')}  ${n}`).join('\n')+'\n');
files.push('SHA256SUMS');
const run=args=>{const r=spawnSync('gh',args,{stdio:'inherit'});if(r.status!==0)throw new Error('GitHub release operation failed');};
const existing=spawnSync('gh',['release','view',tag,'--repo',repo,'--json','isDraft'],{encoding:'utf8'});
if(existing.status===0){if(!JSON.parse(existing.stdout).isDraft)throw new Error('Version already published');}
else run(['release','create',tag,'--repo',repo,'--draft','--title',`Exit Sentinel ${tag}`,'--notes-file','release-notes.md']);
run(['release','upload',tag,'--repo',repo,'--clobber',...files.map(n=>`${dir}/${n}`)]);
run(['release','edit',tag,'--repo',repo,'--draft=false','--latest']);
