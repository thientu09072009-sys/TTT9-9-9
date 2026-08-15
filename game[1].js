
const S=["👹","😈","👺","☠️","🔥","🩸","👿","TTT"],M=[1,2,4,8,16,32,64,128,256,512,1028],B=[10000,50000,200000,500000,1000000,2000000];let p=0,s=0,b=10000,pot=100000000,busy=false,c=0,autoLeft=0;
const $=x=>document.getElementById(x),fmt=x=>Math.floor(x).toLocaleString("vi-VN");
let dev=localStorage.getItem("sctDevice");if(!dev){dev=crypto.randomUUID?crypto.randomUUID():"dev-"+Math.random().toString(36).slice(2);localStorage.setItem("sctDevice",dev)}
function render(){ $("points").textContent=fmt(p);$("spins").textContent=s;$("best").textContent=fmt(window.best||0);$("pot").textContent=fmt(pot);$("bet").textContent=fmt(b);$("bets").innerHTML=B.map(x=>`<button class="${x==b?'active':''}" onclick="setB(${x})">${fmt(x)}</button>`).join("");$("multi").innerHTML=M.map((x,i)=>`<span style="padding:4px 6px;margin:2px;border-radius:6px;background:${i==Math.min(c,10)?'#d67b12':'#28102f'}">${x}×</span>`).join("")}
function setB(x){if(!busy&&x<=p){b=x;render()}}
function fill(){for(let i=0;i<30;i++){let x=$("c"+i);x.textContent=S[Math.floor(Math.random()*S.length)];x.className="cell"+(x.textContent=="TTT"?" special":"")}}
function wins(){let v=[...Array(30)].map((_,i)=>$("c"+i).textContent),w=new Set();for(let r=0;r<6;r++)for(let i=0;i<=2;i++){let a=r*5+i;if(v[a]==v[a+1]&&v[a]==v[a+2]&&v[a]!="TTT"){w.add(a);w.add(a+1);w.add(a+2)}}return [...w]}
function cascade(){let w=wins();if(!w.length)return false;w.forEach(i=>$("c"+i).classList.add("win"));let gain=b*M[Math.min(c,10)];p+=gain;window.best=Math.max(window.best||0,gain);$("msg").textContent=`🔥 Cascade ${c+1}: +${fmt(gain)} điểm`;setTimeout(()=>{w.forEach(i=>{$("c"+i).textContent=S[Math.floor(Math.random()*S.length)];$("c"+i).className="cell"});c++;render();setTimeout(()=>{if(c<11&&cascade()){}else finish()},220)},300);return true}
function finish(){busy=false;$("spin").disabled=false;render();if(autoLeft>0){autoLeft--;if(p>=b)setTimeout(spin,180);else{autoLeft=0;$("msg").textContent="Hết điểm.";}}}
function spin(){if(busy)return;if(p<b){$("msg").textContent="Không đủ điểm.";autoLeft=0;return}busy=true;$("spin").disabled=true;p-=b;s++;pot+=Math.floor(b*.1);c=0;fill();render();setTimeout(()=>{if(!cascade()){finish()}},350)}
function auto(n){if(busy||p<b){$("msg").textContent="Không đủ điểm để bắt đầu auto.";return}autoLeft=n;spin()}
function stopAuto(){autoLeft=0;$("msg").textContent="Đã dừng Auto."}
async function redeemUI(){let code=prompt("Nhập code:");if(!code)return;let r=await fetch("/api/redeem",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code,deviceId:dev})});let d=await r.json();$("msg").textContent=d.ok?`✅ +${fmt(d.reward)} điểm`:"❌ "+d.error;if(d.ok){p+=d.reward;render()}}
$("grid").innerHTML=[...Array(30)].map((_,i)=>`<div id="c${i}" class="cell">?</div>`).join("");render();fill();



/* ===== SCT ULTRA LAYER ===== */
(()=>{
  const badge=document.createElement("div");
  badge.className="ultra-badge";
  badge.textContent="⚡ SCT ULTRA";
  document.body.appendChild(badge);
  window.SCT_ULTRA={version:"3.0",ready:true};
})();
