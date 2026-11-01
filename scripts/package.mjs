import { cpSync, readFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function packageMac(root, appOnly=false) {
  // Documents may be managed by File Provider, which adds FinderInfo to .app
  // packages after signing. Stage a clean copy outside that tree for the DMG.
  const stage=mkdtempSync(path.join(tmpdir(),'exit-sentinel-release-'));
  try {
    const app=path.join(stage,'Exit Sentinel.app');
    cpSync(path.join(root,'src-tauri/target/release/bundle/macos/Exit Sentinel.app'),app,{recursive:true});
    const verify=spawnSync('codesign',['--verify','--deep','--strict',app],{stdio:'inherit'});
    if(verify.status!==0)throw new Error('Clean app signature verification failed');
    if(!appOnly){
      symlinkSync('/Applications',path.join(stage,'Applications'));
      const dir=path.join(root,'src-tauri/target/release/bundle/dmg');mkdirSync(dir,{recursive:true});
      const config=JSON.parse(readFileSync(path.join(root,'src-tauri/tauri.conf.json'),'utf8'));
      const arch=process.arch==='arm64'?'aarch64':'x64';
      const output=path.join(dir,`Exit Sentinel_${config.version}_${arch}.dmg`);
      const dmg=spawnSync('hdiutil',['create','-volname','Exit Sentinel','-srcfolder',stage,'-ov','-format','UDZO',output],{stdio:'inherit'});
      if(dmg.status!==0)throw new Error('DMG creation failed');
      console.log('Verified clean app packaged:',output);
    }
  } finally {rmSync(stage,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))packageMac(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
