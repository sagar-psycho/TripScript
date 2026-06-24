const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const money=(v,c='INR')=>new Intl.NumberFormat('en-IN',{style:'currency',currency:c,maximumFractionDigits:0}).format(Number(v||0));
const fmt=d=>d?new Date(d).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}):'';
const toast=(msg)=>{let w=$('.toast-wrap')||document.body.appendChild(Object.assign(document.createElement('div'),{className:'toast-wrap'}));let t=document.createElement('div');t.className='toast';t.textContent=msg;w.appendChild(t);setTimeout(()=>t.remove(),2800)};
const initials=n=>(n||'User').split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase();
const requireAuth=()=>{if(!Store.user()) location.href='login.html'};
const applyTheme=()=>{const db=Store.db();document.documentElement.dataset.theme=db.settings.theme||'light'};
function downloadFile(name,content,type='text/plain'){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;a.click();URL.revokeObjectURL(a.href)}
function exportCSV(name,rows){if(!rows.length)return toast('No data to export');const keys=Object.keys(rows[0]);const csv=[keys.join(','),...rows.map(r=>keys.map(k=>`"${String(r[k]??'').replaceAll('"','""')}"`).join(','))].join('\n');downloadFile(name,csv,'text/csv')}
function fakePDF(title,body){downloadFile(`${title}.pdf`,`${title}\n\n${body}`,'application/pdf');toast('PDF report generated')}
class Paginator{constructor(items,per=6){this.items=items;this.per=per;this.page=1}get pageItems(){return this.items.slice((this.page-1)*this.per,this.page*this.per)}get pages(){return Math.max(1,Math.ceil(this.items.length/this.per))}}
