#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const srcDir = path.resolve('src');
const tsFiles = [];
function walk(dir){fs.readdirSync(dir).forEach(f=>{const p=path.join(dir,f);if(fs.statSync(p).isDirectory()){walk(p);}else if(p.endsWith('.ts')){tsFiles.push(p);}})
walk(srcDir);
const nameToPath = {};
for(const p of tsFiles){const name=path.basename(p);nameToPath[name]=p;}
const used = new Set();
for(const p of tsFiles){const content=fs.readFileSync(p,'utf8');const regex=/\bimport\s+[^;]*?\bfrom\s+['"]([^'"]+)['"]/g;let m;while((m=regex.exec(content))!==null){const imp=m[1];const impPath=imp.endsWith('.ts')?imp:imp+'.ts';const impName=path.basename(impPath);if(nameToPath[impName]) used.add(nameToPath[impName]);}
// also require
const regex2=/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;while((m=regex2.exec(content))!==null){const imp=m[1];const impPath=imp.endsWith('.ts')?imp:imp+'.ts';const impName=path.basename(impPath);if(nameToPath[impName]) used.add(nameToPath[impName]);}
}
const unused = tsFiles.filter(p=>!used.has(p));
console.log('Unused files:');unused.forEach(p=>console.log(p));
