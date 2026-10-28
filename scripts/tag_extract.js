// TAG LIFE TCG population extractor.
//
// Pasted into a browser tab on https://my.taggrading.com/pop-report/Nature by Claude during the
// monthly refresh (TAG files LIFE under the Nature category; the set list comes from the
// /pop-report/Nature/<year> links that contain "Life TCG"). TAG's API returns 403 to direct
// fetches, so this runs inside the real page and reads what the page renders. It returns a JSON
// string; save it as data/raw/tag-<YYYY-MM-DD>.json.
// Shape: [{year,set,num,name,variant,grades:{grade:count,...,TOTAL}}]
// TAG grades: VA, 1..10 in halves, 10P (Pristine). If new years appear, add them to `years`.
//
// run on https://my.taggrading.com/pop-report/Nature ; returns JSON string
const years=[2023,2024,2025,2026,2027]; const sets=[];
for (const y of years){ history.pushState({},'',`/pop-report/Nature/${y}`); dispatchEvent(new PopStateEvent('popstate')); await new Promise(r=>setTimeout(r,3500));
  for (const h of [...document.querySelectorAll('a')].map(a=>a.getAttribute('href')).filter(h=>h&&h.includes(`/Nature/${y}/Life TCG`))) sets.push([y,new URLSearchParams(h.split('?')[1]).get('setName')]); }
const G=["VA","1","1.5","2","2.5","3","3.5","4","4.5","5","5.5","6","6.5","7","7.5","8","8.5","9","10","10P","TOTAL"]; const res=[];
for (const [y,s] of sets){ history.pushState({},'',`/pop-report/Nature/${y}/Life TCG?setName=${encodeURIComponent(s).replace(/%20/g,'+')}`); dispatchEvent(new PopStateEvent('popstate')); await new Promise(r=>setTimeout(r,4000));
 const body=document.body.innerText.split('\tTOTAL\n')[1]||''; const lines=body.split('\n').map(l=>l.trim()).filter(l=>l!=='');
 let buf=[]; for (const l of lines){ if(/^(\d+\t){20}\d+$/.test(l)){ const n=l.split('\t').map(Number); const [num,name,...v]=buf; res.push({year:String(y),set:s,num:num.replace(/\t$/,''),name,variant:v.join(' ')||null,grades:Object.fromEntries(G.map((g,i)=>[g,n[i]]).filter(([g,c])=>c>0))}); buf=[]; } else if(/^200 rows/.test(l)) break; else buf.push(l.replace(/\t$/,'')); } }
JSON.stringify(res)
