// TAG LIFE TCG Mammals 1st Edition cert lister (for the Kickstarter check).
//
// TAG files Kickstarter copies under Mammals 1st Edition, so the pop table cannot split them. Each
// card page lists every slab with a link to /card/<CERT>; the cert page shows the front scan, where
// Kickstarter copies read "(c)LIFE TCG 2022" with a small K stamp at the bottom center.
// Pasted into a browser tab by Claude (in-app browser) during the monthly refresh. The browser tool
// times out near 45 s, so this returns at once and works in the background; progress is in
// window.__tagCerts ({done,total,lines,err}). When done, the lines are rendered into <article><pre>
// at the top of the body: read them with get_page_text and save to
// data/private/tag-mammals-certs-<date>.txt (lines card|grade|cert, e.g. Bengal Tiger/25/100|10 GEM (982)|X6851170).
// Poll with: JSON.stringify({d:window.__tagCerts.done,t:window.__tagCerts.total})
//
// Mode 1: run on https://my.taggrading.com/pop-report/Nature/2023/Life%20TCG?setName=Mammals+1st+Edition
// Mode 2 (scans): set window.__tagImgList=['CERT',...] first, then run this on any my.taggrading.com
//   page. It visits /card/<cert> and records the FRONT_MAIN image URL in window.__tagImgs
//   ({cert:url}); the rendered <pre> then holds lines cert|url.
(async()=>{
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const go=async u=>{ history.pushState({},'',u); dispatchEvent(new PopStateEvent('popstate')); await sleep(3500); };
  const render=lines=>{ document.querySelector('article#__tagCerts')?.remove(); const a=document.createElement('article'); a.id='__tagCerts'; const p=document.createElement('pre'); p.textContent=lines.join('\n'); a.appendChild(p); document.body.prepend(a); };
  try{
    if(Array.isArray(window.__tagImgList)){
      const certs=window.__tagImgList; const imgs=window.__tagImgs={}; const st=window.__tagCerts={done:0,total:certs.length,lines:[],err:null};
      for(const c of certs){ await go(`/card/${c}`); const i=[...document.images].find(x=>(x.src||'').includes('_FRONT_MAIN.jpg')); imgs[c]=i?i.src:null; st.lines.push(`${c}|${imgs[c]}`); st.done++; }
      render(st.lines); return;
    }
    const st=window.__tagCerts={done:0,total:0,lines:[],err:null};
    const links=[...new Set([...document.querySelectorAll('a')].map(a=>a.getAttribute('href')).filter(h=>h&&h.includes('/Life TCG/')&&!h.includes('grades=')))];
    st.total=links.length;
    for(const h of links){
      const card=decodeURIComponent(h.split('/Life TCG/')[1].split('?')[0]);
      await go(h);
      for(const tr of document.querySelectorAll('tr')){
        const a=tr.querySelector('a[href*="/card/"]'); if(!a) continue;
        const cells=[...tr.querySelectorAll('td')].map(td=>td.innerText.trim());
        st.lines.push(`${card}|${cells[1]}|${a.getAttribute('href').split('/card/')[1].split(/[?#/]/)[0]}`);
      }
      st.done++;
    }
    render(st.lines);
  }catch(e){ (window.__tagCerts=window.__tagCerts||{}).err=String(e); }
})();
'started'
