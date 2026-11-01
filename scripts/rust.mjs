// Cargo walks cwd ancestors, so an isolated CARGO_HOME alone cannot override
// ~/.cargo/config.toml when the project lives under the user's home folder.
// Run Cargo from a neutral temporary cwd, preserving this crate via --manifest-path.
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const home=path.join(tmpdir(),'exit-sentinel-cargo-home');
mkdirSync(home,{recursive:true});
for(const n of ['registry','git'])if(!existsSync(path.join(home,n))&&existsSync(path.join(homedir(),'.cargo',n)))symlinkSync(path.join(homedir(),'.cargo',n),path.join(home,n));
const args=process.argv.slice(2);const command=args.shift()||'test';
const result=spawnSync('cargo',[command,'--manifest-path',path.join(root,'src-tauri/Cargo.toml'),...args],{cwd:tmpdir(),env:{...process.env,CARGO_HOME:home},stdio:'inherit'});
process.exit(result.status??1);
