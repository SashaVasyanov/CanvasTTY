// minimal CommonJS bundler: node bundle.js <rootDir> <entry> <globalName> <out> [aliasRoot]
const fs=require('fs'),path=require('path');
const [root,entry,globalName,out]=process.argv.slice(2);
const aliasRoot=path.join(root,'src');
const mods=new Map();let n=0;
function resolve(from,req){
  let p;
  if(req.startsWith('.')) p=path.resolve(path.dirname(from),req);
  else if(/^(common|browser)\//.test(req)) p=path.join(aliasRoot,req);
  else if(req.startsWith('@xterm/xterm')||req==='xterm') return null;
  else throw new Error('external '+req+' from '+from);
  if(fs.existsSync(p+'.js')) return p+'.js';
  if(fs.existsSync(path.join(p,'index.js'))) return path.join(p,'index.js');
  throw new Error('cannot resolve '+req+' from '+from);
}
function add(file){
  if(mods.has(file)) return mods.get(file).id;
  const m={id:n++,src:'',deps:{}};mods.set(file,m);
  let src=fs.readFileSync(file,'utf8');
  src=src.replace(/require\("([^"]+)"\)/g,(all,req)=>{const r=resolve(file,req);if(r===null)return 'undefined';const id=add(r);return `__r(${id})`;});
  m.src=src;return m.id;
}
const eid=add(path.resolve(entry));
let code=`(function(g){var __defs={},__cache={};function __r(i){if(__cache[i])return __cache[i].exports;var m=__cache[i]={exports:{}};__defs[i](m,m.exports);return m.exports;}\n`;
for(const [f,m] of mods) code+=`__defs[${m.id}]=function(module,exports){\n${m.src}\n};\n`;
code+=`g.${globalName}=__r(${eid});})(typeof window!=='undefined'?window:globalThis);\n`;
fs.writeFileSync(out,code);console.log('modules',mods.size,'bytes',code.length);
