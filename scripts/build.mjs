// Build from a neutral folder without modifying any global Cargo configuration.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, existsSync, symlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageMac } from './package.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const home=path.join(tmpdir(),'exit-sentinel-cargo-home');mkdirSync(home,{recursive:true});
for(const n of ['registry','git'])if(!existsSync(path.join(home,n))&&existsSync(path.join(homedir(),'.cargo',n)))symlinkSync(path.join(homedir(),'.cargo',n),path.join(home,n));
const stage=mkdtempSync(path.join(tmpdir(),'exit-sentinel-build-'));
for(const n of ['package.json','package-lock.json','tsconfig.json','vite.config.ts','index.html','src','src-tauri'])cpSync(path.join(root,n),path.join(stage,n),{recursive:true,filter:p=>!p.split(path.sep).includes('target')});
symlinkSync(path.join(root,'node_modules'),path.join(stage,'node_modules'));
mkdirSync(path.join(root,'src-tauri/target'),{recursive:true});
symlinkSync(path.join(root,'src-tauri/target'),path.join(stage,'src-tauri/target'));
const result=spawnSync(path.join(root,'node_modules/.bin/tauri'),['build',...process.argv.slice(2)],{cwd:stage,env:{...process.env,CARGO_HOME:home},stdio:'inherit'});
if(result.status===0){packageMac(root,process.argv.includes('--bundles')&&process.argv.includes('app'));rmSync(stage,{recursive:true,force:true});}
else console.error('Build staging directory retained:',stage);
process.exit(result.status??1);
