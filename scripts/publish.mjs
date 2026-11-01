// Publish only signed updater artifacts, never source or local application data.
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(readFileSync(path.join(root,'src-tauri/tauri.conf.json'),'utf8'));
const repo=process.env.RELEASE_REPOSITORY||'melotusme/exit-sentinel-releases';
const version=config.version, tag=`v${version}`;
const arch=process.env.SENTINEL_ARCH||(process.arch==='arm64'?'aarch64':'x86_64');
if(!['aarch64','x86_64'].includes(arch))throw new Error('Unsupported updater architecture');
const bundle=path.join(root,'src-tauri/target',process.env.SENTINEL_TARGET_TRIPLE||'','release/bundle');
const archive=path.join(bundle,'macos/Exit Sentinel.app.tar.gz');
const signature=archive+'.sig';
if(!existsSync(archive)||!existsSync(signature))throw new Error('Build signed updater artifacts first.');
const plist=spawnSync('tar',['-xOf',archive,'Exit Sentinel.app/Contents/Info.plist'],{encoding:'utf8'});
const builtVersion=plist.stdout?.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
if(plist.status!==0||builtVersion!==version)throw new Error(`Stale updater archive: expected ${version}, got ${builtVersion||'unknown'}`);
const notesPath=process.argv[2];
if(!notesPath)throw new Error('Usage: node scripts/publish.mjs <release-notes-file> [--prepare-only]');
const notes=readFileSync(notesPath,'utf8');
const manifest={version,notes,pub_date:new Date().toISOString(),platforms:{[`darwin-${arch}`]:{
  signature:readFileSync(signature,'utf8').trim(),
  url:`https://github.com/${repo}/releases/download/${tag}/Exit.Sentinel.app.tar.gz`,
}}};
mkdirSync(path.join(root,'releases'),{recursive:true});
const uploadArchive=path.join(root,'releases/Exit.Sentinel.app.tar.gz');
const uploadSignature=uploadArchive+'.sig';
copyFileSync(archive,uploadArchive);copyFileSync(signature,uploadSignature);
const manifestPath=path.join(root,'releases/latest.json');
writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
if(process.argv.includes('--prepare-only')){console.log('Prepared updater manifest:',manifestPath);process.exit(0);}
const run=(args)=>{const r=spawnSync('gh',args,{cwd:root,stdio:'inherit'});if(r.status!==0)throw new Error(`gh ${args[0]} ${args[1]} failed`);};
// A failed upload leaves a recoverable draft and never replaces the stable feed.
const existing=spawnSync('gh',['release','view',tag,'--repo',repo,'--json','isDraft'],{encoding:'utf8'});
if(existing.status===0){
  if(!JSON.parse(existing.stdout).isDraft)throw new Error('This version is already published; bump the version.');
}else run(['release','create',tag,'--repo',repo,'--draft','--title',`Exit Sentinel ${tag}`,'--notes-file',notesPath]);
const dmg=path.join(bundle,`dmg/Exit Sentinel_${version}_${arch==='aarch64'?'aarch64':'x64'}.dmg`);
run(['release','upload',tag,'--repo',repo,'--clobber',uploadArchive,uploadSignature,manifestPath,...(existsSync(dmg)?[dmg]:[])]);
run(['release','edit',tag,'--repo',repo,'--draft=false','--latest']);
console.log(`Published https://github.com/${repo}/releases/tag/${tag}`);
