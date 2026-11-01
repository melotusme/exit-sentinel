import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { listen } from '@tauri-apps/api/event';

const key='exit-sentinel.auto-update-check';
let enabled=localStorage.getItem(key)!=='false', busy=false, pending:Update|null=null;
let message='', notes='', installing=false;
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function updateSettings(){return `<h2>软件更新</h2><label class="toggle"><span>自动检查 GitHub 新版本<small>启动后及每 6 小时检查。发现新版后由你确认安装，不上传本机出口与节点记录。</small></span><input name="auto_update" type="checkbox" ${enabled?'checked':''}></label><p><button type="button" id="check-software-update" ${busy?'disabled':''}>检查更新</button></p>`;}
function paint(){
  const host=document.querySelector<HTMLElement>('#software-update');if(!host)return;
  host.hidden=!message;
  host.innerHTML=message?`<section class="notice"><div><strong>${escape(message)}</strong>${notes?`<p class="update-notes">${escape(notes)}</p>`:''}<div class="form-actions">${pending&&!installing?'<button type="button" id="install-software-update" class="primary">安装并重启</button>':''}${!busy?'<button type="button" id="dismiss-software-update">关闭提示</button>':''}</div></div></section>`:'';
  const checkButton=document.querySelector<HTMLButtonElement>('#check-software-update');if(checkButton)checkButton.disabled=busy;
}
async function checkUpdate(manual:boolean){
  if(busy)return;if(pending){message=`发现新版本 v${pending.version}（当前 v${pending.currentVersion}）`;notes=pending.body||'此版本未提供更新说明。';paint();return;}
  busy=true;if(manual)message='正在检查 GitHub 更新…';paint();
  try{
    pending=await check({timeout:20000});
    if(pending){message=`发现新版本 v${pending.version}（当前 v${pending.currentVersion}）`;notes=pending.body||'此版本未提供更新说明。';}
    else if(manual)message='当前已经是最新版本。';
  }catch(e){if(manual){message=`检查更新失败：${String(e)}`;notes='请检查 GitHub 连通性后重试。';}}
  finally{busy=false;paint();}
}
async function install(){
  if(busy||!pending)return;busy=true;installing=true;notes='安装完成后应用会重新启动。';message='正在下载更新…';paint();
  let total=0, received=0, installed=false;
  try{
    await pending.downloadAndInstall(event=>{
      if(event.event==='Started')total=event.data.contentLength||0;
      if(event.event==='Progress'){received+=event.data.chunkLength;message=total?`正在下载更新 ${Math.min(100,Math.round(received/total*100))}%`:`正在下载更新 ${(received/1048576).toFixed(1)} MiB`;paint();}
      if(event.event==='Finished'){message='下载完成，正在验证签名并安装…';paint();}
    },{timeout:120000});
    installed=true;message='更新已安装，正在重新启动…';paint();await relaunch();
  }catch(e){message=installed?`更新已安装，请手动退出并重新打开应用：${String(e)}`:`更新未完成：${String(e)}`;if(installed){await pending.close();pending=null;}}
  finally{busy=false;installing=false;paint();}
}
export async function initUpdates(){
  await listen('check-update',()=>{void checkUpdate(true);});
  document.addEventListener('click',event=>{const id=(event.target as HTMLElement).closest('button')?.id;
    if(id==='check-software-update')void checkUpdate(true);
    if(id==='install-software-update')void install();
    if(id==='dismiss-software-update'){message='';paint();}
  });
  document.addEventListener('change',event=>{const input=event.target as HTMLInputElement;if(input.name==='auto_update'){enabled=input.checked;localStorage.setItem(key,String(enabled));if(enabled)void checkUpdate(false);}});
  setTimeout(()=>{if(enabled)void checkUpdate(false);},15000);
  setInterval(()=>{if(enabled)void checkUpdate(false);},6*60*60*1000);
}
