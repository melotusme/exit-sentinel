import {readFileSync,writeFileSync,copyFileSync,mkdirSync,readdirSync} from 'node:fs';
import path from 'node:path';
const platform=process.argv[2], target=process.argv[3];
if(!['darwin-aarch64','windows-x86_64'].includes(platform))throw new Error('Unsupported platform');
const config=JSON.parse(readFileSync('src-tauri/tauri.conf.json','utf8'));
const bundle=path.join('src-tauri/target',target,'release/bundle');
const out='release-assets';mkdirSync(out,{recursive:true});
let asset;
if(platform==='darwin-aarch64'){
  asset='Exit.Sentinel.app.tar.gz';
  for(const suffix of ['', '.sig'])copyFileSync(path.join(bundle,'macos/Exit Sentinel.app.tar.gz'+suffix),path.join(out,asset+suffix));
  const dmg=readdirSync(path.join(bundle,'dmg')).filter(n=>n.endsWith('.dmg'));
  if(dmg.length!==1)throw new Error('Expected one DMG');
  copyFileSync(path.join(bundle,'dmg',dmg[0]),path.join(out,dmg[0].replaceAll(' ', '.')));
}else{
  asset='Exit.Sentinel.windows.x64.exe';
  const exes=readdirSync(path.join(bundle,'nsis')).filter(n=>n.endsWith('-setup.exe'));
  if(exes.length!==1)throw new Error('Expected one NSIS installer');
  for(const suffix of ['', '.sig'])copyFileSync(path.join(bundle,'nsis',exes[0]+suffix),path.join(out,asset+suffix));
}
writeFileSync(path.join(out,platform+'.json'),JSON.stringify({version:config.version,platform,asset,signature:readFileSync(path.join(out,asset+'.sig'),'utf8').trim()},null,2));
